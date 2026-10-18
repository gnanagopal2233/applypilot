import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { AnswersSchema, ExperienceSchema, ProfileSchema, TargetsSchema } from "../src/core/types";
import type { Workspace } from "../src/core/config";

export function exampleWorkspace(): Workspace {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/profile");
  const y = (f: string) => YAML.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const experience = ExperienceSchema.parse(y("experience.yaml"));
  experience.roles.forEach((r) => r.bullets.forEach((b, i) => (b.id ||= `${r.id}.${i + 1}`)));
  return {
    profile: ProfileSchema.parse(y("profile.yaml")),
    experience,
    answers: AnswersSchema.parse(y("answers.yaml")),
    targets: TargetsSchema.parse(y("targets.yaml")),
  };
}
