import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { env } from "./config";
import { AnswersSchema, ExperienceSchema, ProfileSchema, TargetsSchema } from "./types";

export const PROFILE_FILES = {
  "profile.yaml": { schema: ProfileSchema, title: "Profile", help: "Identity, work authorization, filters, style rules and automation thresholds." },
  "experience.yaml": { schema: ExperienceSchema, title: "Experience bank", help: "Every true bullet you have. The tailor can only use what is here." },
  "answers.yaml": { schema: AnswersSchema, title: "Saved answers", help: "Regex → answer for screening questions, plus fields that are never auto-filled." },
  "targets.yaml": { schema: TargetsSchema, title: "Target companies", help: "Greenhouse / Lever / Ashby boards to scout." },
} as const;
export type ProfileFile = keyof typeof PROFILE_FILES;

const examplesDir = () => path.resolve(/*turbopackIgnore: true*/ process.cwd(), "examples/profile");

export function readProfileFile(name: ProfileFile): { content: string; exists: boolean } {
  const p = path.join(env.profileDir, name);
  if (fs.existsSync(p)) return { content: fs.readFileSync(p, "utf8"), exists: true };
  return { content: fs.readFileSync(path.join(examplesDir(), name), "utf8"), exists: false };
}

export function saveProfileFile(name: ProfileFile, content: string): { ok: true } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = YAML.parse(content);
  } catch (e) {
    return { ok: false, error: `YAML syntax: ${(e as Error).message}` };
  }
  const parsed = PROFILE_FILES[name].schema.safeParse(data);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  fs.mkdirSync(env.profileDir, { recursive: true });
  fs.writeFileSync(path.join(env.profileDir, name), content);
  return { ok: true };
}

export function profileReady(): boolean {
  return (Object.keys(PROFILE_FILES) as ProfileFile[]).every((f) => fs.existsSync(path.join(env.profileDir, f)));
}

export function createProfileFromExamples() {
  fs.mkdirSync(env.profileDir, { recursive: true });
  for (const f of Object.keys(PROFILE_FILES)) {
    const dest = path.join(env.profileDir, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(examplesDir(), f), dest);
  }
}

/* ---------------- .env (language model settings) ---------------- */

const envPath = () => path.resolve(/*turbopackIgnore: true*/ process.cwd(), ".env");

export function llmSettings() {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  const keyVar = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : null;
  return { provider, model: process.env.LLM_MODEL || "", keySet: keyVar ? !!process.env[keyVar] : true /* ollama / mock need no key */, keyVar };
}

/** Update keys in .env, keeping every other line. Also applies them to this process. */
export function updateEnv(values: Record<string, string | undefined>) {
  const file = envPath();
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === "") continue;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}
