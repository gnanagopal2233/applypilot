import fs from "node:fs";
import path from "node:path";
import { env, loadWorkspace } from "./core/config";
import { getDb, getJob, listJobs, setStatus, statusCounts } from "./core/db";
import { getLLM } from "./core/llm";
import { fetchBoard } from "./agents/sources";
import { addJobByUrl, applyJob, filterAndScore, notify, runPipeline, scout, tailorJob } from "./agents/pipeline";
import { scoreJob } from "./agents/scorer";
import { rowToPosting, updateJob } from "./core/db";

const HELP = `ApplyPilot — multi-agent job application pilot

Usage: npm run cli <command> [args]

  init                 Copy example profile files into ./profile (won't overwrite)
  doctor               Check config, API key, browser, and target boards
  scout                Pull open roles from every board in profile/targets.yaml
  add <url>            Add one job by URL (Greenhouse, Lever, Ashby; others = manual apply)
  score [--max N]      Filter + score new jobs
  tailor <jobId>       Tailor + verify + render PDFs for one job
  apply <jobId> [--headed]
                       Run the confidence gate and apply. --headed opens a browser,
                       fills the form and waits up to 15 min for YOU to click Submit.
  approve <jobId>      Mark a reviewed job as human-approved (next run submits it)
  skip <jobId>         Skip a job
  run [--no-scout]     Full pipeline: scout → filter → score → tailor → verify → gate → apply
  list [status]        List jobs (default: review + tailored)
  status               Counts by status
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const opt = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };

  switch (cmd) {
    case "init": {
      const src = path.resolve("examples/profile");
      fs.mkdirSync(env.profileDir, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        const dest = path.join(env.profileDir, f);
        if (fs.existsSync(dest)) console.log(`keep   ${dest}`);
        else {
          fs.copyFileSync(path.join(src, f), dest);
          console.log(`create ${dest}`);
        }
      }
      if (!fs.existsSync(".env")) fs.copyFileSync(".env.example", ".env"), console.log("create .env");
      console.log("\nNext: edit profile/*.yaml and .env, then run: npm run doctor");
      return;
    }
    case "doctor": {
      let ok = true;
      const check = async (name: string, fn: () => Promise<string | void> | string | void) => {
        try {
          const msg = await fn();
          console.log(`✔ ${name}${msg ? ` — ${msg}` : ""}`);
        } catch (e) {
          ok = false;
          console.log(`✖ ${name} — ${(e as Error).message}`);
        }
      };
      let ws: ReturnType<typeof loadWorkspace> | undefined;
      await check("profile files valid", () => {
        ws = loadWorkspace(true);
        return `${ws.experience.roles.length} roles, ${ws.experience.roles.reduce((n, r) => n + r.bullets.length, 0)} bullets, ${ws.targets.companies.length} target boards`;
      });
      await check("database", () => void getDb());
      await check("LLM reachable + key valid", async () => {
        const llm = getLLM();
        const { z } = await import("zod");
        const r = await llm.json({ name: "ping", system: "Reply with ok=true.", prompt: "ping", schema: z.object({ ok: z.boolean() }), maxTokens: 50 });
        return `${llm.name} ok=${r.ok}`;
      });
      await check("headless browser", async () => {
        const { chromium } = await import("playwright");
        const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
        await b.close();
      });
      if (ws) {
        for (const c of ws.targets.companies) await check(`board ${c.name} (${c.ats}/${c.slug})`, async () => `${(await fetchBoard(c.ats, c.slug, c.name)).length} open roles`);
        const a = ws.profile.automation;
        console.log(`\nautomation: autoSubmit=${a.autoSubmit} dryRun=${a.dryRun} autoThreshold=${a.minScoreToAutoSubmit} dailyCap=${a.dailyCap}`);
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case "scout":
      console.log(await scout());
      return;
    case "add": {
      if (!args[0]) throw new Error("usage: add <url>");
      const job = await addJobByUrl(args[0]);
      const ws = loadWorkspace();
      const s = await scoreJob(job, ws, getLLM());
      updateJob(job.id, { score: s.score, score_json: JSON.stringify(s), status: "scored" });
      console.log(`${job.id}\nscore ${s.score}\n${s.llm?.summary ?? ""}`);
      return;
    }
    case "score":
      console.log(await filterAndScore(loadWorkspace(), getLLM(), Number(opt("--max") ?? env.maxLlmScores)));
      return;
    case "tailor": {
      const r = await tailorJob(args[0], loadWorkspace(), getLLM());
      console.log(`PDF: ${r.pdf}\nverifier: ${r.result.issues.length} repaired claim(s)`);
      r.result.issues.forEach((i) => console.log(`  - ${i.where}: ${i.kind} ${i.detail}`));
      return;
    }
    case "apply": {
      const ws = loadWorkspace();
      const row = getJob(args[0]);
      if (row && !row.tailored_json) await tailorJob(args[0], ws, getLLM());
      const r = await applyJob(args[0], ws, getLLM(), flag("--headed") ? { headed: true, holdForHumanMs: 15 * 60_000 } : {});
      console.log(r.decision, r.reasons);
      return;
    }
    case "approve":
      setStatus(args[0], "ready", "approved by human");
      console.log("approved — it will be submitted on the next run (or run: apply <id>)");
      return;
    case "skip":
      setStatus(args[0], "skipped", "skipped by human");
      return;
    case "run": {
      try {
        const s = await runPipeline({ skipScout: flag("--no-scout") });
        await notify(`ApplyPilot run: ${JSON.stringify(s)}`);
      } catch (e) {
        await notify(`ApplyPilot run FAILED: ${(e as Error).message}`);
        throw e;
      }
      return;
    }
    case "list": {
      const status = (args[0] as never) ?? ["review", "tailored", "ready"];
      for (const r of listJobs({ status, limit: 100 })) {
        console.log(`${String(r.score ?? "-").padStart(3)}  ${r.status.padEnd(9)} ${r.company} — ${r.title}\n     ${r.id}${r.status_reason ? `\n     ↳ ${r.status_reason}` : ""}`);
      }
      return;
    }
    case "status":
      console.log(statusCounts());
      return;
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
});

// re-exported for scripts that want the posting shape
export { rowToPosting };
