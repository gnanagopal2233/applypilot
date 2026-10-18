import { skillVocabulary, type Workspace } from "../core/config";
import type { LLM } from "../core/llm";
import { containsTerm } from "../core/text";
import { ScoreLLMSchema, type JobPosting, type ScoreResult } from "../core/types";

/** Deterministic skill coverage: which of the candidate's skills does the JD mention? */
export function keywordCoverage(job: JobPosting, ws: Workspace) {
  const jd = `${job.title}\n${job.description}`;
  const vocab = skillVocabulary(ws.experience);
  const matched = vocab.filter((s) => containsTerm(jd, s));
  // Coverage relative to a soft target: matching ~12 of your skills is a strong overlap.
  const coverage = Math.min(1, matched.length / 12);
  return { matched, coverage };
}

/** Common tech terms we look for in the JD that the candidate does NOT list (gap signal). */
const COMMON_TECH = [
  "Python", "Golang", "Rust", "C++", "Java", "TypeScript", "React", "Kubernetes", "Terraform", "AWS", "GCP", "Azure",
  "PostgreSQL", "Kafka", "Spark", "Airflow", "dbt", "Snowflake", "LangChain", "LlamaIndex", "PyTorch", "TensorFlow",
  "RAG", "MCP", "Docker", "GraphQL", "Redis", "Elasticsearch", "Ruby", "Scala", "Swift", "Kotlin", "SQL", "Node.js",
];

export function missingSkills(job: JobPosting, ws: Workspace): string[] {
  const vocab = skillVocabulary(ws.experience).map((s) => s.toLowerCase());
  return COMMON_TECH.filter((t) => containsTerm(job.description, t) && !vocab.some((v) => v === t.toLowerCase() || containsTerm(v, t)));
}

const SYSTEM = `You are a senior technical recruiter scoring candidate-job fit for software and forward-deployed engineering roles.
Be calibrated and skeptical: 5 = plausible, 7 = strong, 9+ = exceptional. Only use evidence in the candidate profile.
"mustHaveGaps" lists hard requirements in the posting the candidate clearly lacks.`;

export async function scoreJob(job: JobPosting, ws: Workspace, llm: LLM | null): Promise<ScoreResult> {
  const { matched, coverage } = keywordCoverage(job, ws);
  const missing = missingSkills(job, ws);
  const notes: string[] = [];
  const base: ScoreResult = { score: Math.round(coverage * 70), keywordCoverage: coverage, matchedSkills: matched, missingSkills: missing, notes };
  if (!llm) {
    notes.push("LLM scoring skipped; keyword-only score");
    return base;
  }

  const profileDigest = [
    `Headline: ${ws.profile.headline}`,
    `Summary: ${ws.experience.summaries[0]}`,
    ...ws.experience.roles.map((r) => `${r.title} @ ${r.company} (${r.start}–${r.end}):\n${r.bullets.map((b) => `  - ${b.text}`).join("\n")}`),
    `Skills: ${Object.entries(ws.experience.skills).map(([k, v]) => `${k}: ${v.join(", ")}`).join(" | ")}`,
  ].join("\n");

  const llmOut = await llm.json({
    name: "job_fit",
    system: SYSTEM,
    schema: ScoreLLMSchema,
    maxTokens: 1200,
    prompt: `<job>\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n\n${job.description.slice(0, 12000)}\n</job>\n\n<candidate>\n${profileDigest}\n</candidate>\n\nScore the fit.`,
  });

  const llmScore = (llmOut.skillsFit * 0.35 + llmOut.roleFit * 0.25 + llmOut.seniorityFit * 0.2 + llmOut.domainFit * 0.2) * 10;
  let score = Math.round(llmScore * 0.8 + coverage * 100 * 0.2);
  // Deterministic guardrails so a confident LLM can't paper over real gaps.
  if (llmOut.mustHaveGaps.length >= 3) {
    score = Math.min(score, 65);
    notes.push("capped at 65: 3+ must-have gaps");
  }
  if (llmOut.seniorityFit <= 3) {
    score = Math.min(score, 60);
    notes.push("capped at 60: seniority mismatch");
  }
  return { ...base, score, llm: llmOut };
}
