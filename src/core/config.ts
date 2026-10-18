import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { AnswersSchema, ExperienceSchema, ProfileSchema, TargetsSchema, type Answers, type Experience, type Profile, type Targets } from "./types";

export function loadDotEnv(file = path.resolve(/*turbopackIgnore: true*/ process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [, k, raw] = m;
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

export const env = {
  get profileDir() {
    return path.resolve(/*turbopackIgnore: true*/ process.env.PROFILE_DIR || "./profile");
  },
  get dataDir() {
    return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || "./data");
  },
  get maxLlmScores() {
    return Number(process.env.MAX_LLM_SCORES_PER_RUN || 60);
  },
  get headless() {
    return (process.env.HEADLESS ?? "true") !== "false";
  },
};

function readYaml<T>(file: string, schema: z.ZodType<T>): T {
  const full = path.join(env.profileDir, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${full}. Copy examples/profile/* to ${env.profileDir}/ and edit it (or run: npm run cli init).`);
  }
  const parsed = schema.safeParse(YAML.parse(fs.readFileSync(full, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export interface Workspace {
  profile: Profile;
  experience: Experience;
  answers: Answers;
  targets: Targets;
}

let cached: Workspace | null = null;
export function loadWorkspace(fresh = false): Workspace {
  if (cached && !fresh) return cached;
  const experience = readYaml("experience.yaml", ExperienceSchema);
  // Give every bullet a stable id: <roleId>.<n>
  experience.roles.forEach((r) => r.bullets.forEach((b, i) => (b.id ||= `${r.id}.${i + 1}`)));
  experience.projects.forEach((p, i) => (p.id ||= `project.${i + 1}`));
  cached = {
    profile: readYaml("profile.yaml", ProfileSchema),
    experience,
    answers: readYaml("answers.yaml", AnswersSchema),
    targets: readYaml("targets.yaml", TargetsSchema),
  };
  return cached;
}

/** Every skill string the candidate legitimately has (skills section + bullet tags + projects). */
export function skillVocabulary(exp: Experience): string[] {
  const set = new Set<string>();
  Object.values(exp.skills).flat().forEach((s) => set.add(s));
  exp.roles.forEach((r) => r.bullets.forEach((b) => b.skills.forEach((s) => set.add(s))));
  exp.projects.forEach((p) => p.skills.forEach((s) => set.add(s)));
  return [...set];
}
