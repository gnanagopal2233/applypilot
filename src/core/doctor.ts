import { z } from "zod";
import { loadWorkspace } from "./config";
import { getDb } from "./db";
import { getLLM } from "./llm";
import { fetchBoard } from "../agents/sources";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Health checks shared by the CLI and the web app. */
export async function runDoctor(): Promise<Check[]> {
  const out: Check[] = [];
  const check = async (name: string, fn: () => Promise<string | void> | string | void) => {
    try {
      out.push({ name, ok: true, detail: (await fn()) || "" });
    } catch (e) {
      out.push({ name, ok: false, detail: (e as Error).message === "fetch failed" ? "network error (no internet, or this board is blocked)" : (e as Error).message });
    }
  };
  let ws: ReturnType<typeof loadWorkspace> | undefined;
  await check("Profile files", () => {
    ws = loadWorkspace(true);
    return `${ws.experience.roles.length} roles, ${ws.experience.roles.reduce((n, r) => n + r.bullets.length, 0)} bullets, ${ws.targets.companies.length} boards`;
  });
  await check("Database", () => void getDb());
  await check("Language model key", async () => {
    const llm = getLLM();
    const r = await llm.json({ name: "ping", system: "Reply with ok=true.", prompt: "ping", schema: z.object({ ok: z.boolean() }), maxTokens: 50 });
    return `${llm.name} responded (ok=${r.ok})`;
  });
  await check("Browser", async () => {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }).catch((e: Error) => {
      throw new Error(/Executable doesn't exist/.test(e.message) ? "Browser not installed. Run: npx playwright install chromium" : e.message.split("\n")[0]);
    });
    await b.close();
    return "Chromium launches";
  });
  if (ws) {
    await Promise.all(
      ws.targets.companies.map((c) => check(`Board: ${c.name} (${c.ats}/${c.slug})`, async () => `${(await fetchBoard(c.ats, c.slug, c.name)).length} open roles`)),
    );
  }
  return out;
}
