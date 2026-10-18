import { z } from "zod";
import { skillVocabulary, type Workspace } from "../core/config";
import type { LLM } from "../core/llm";
import { containsTerm, extractNumbers } from "../core/text";
import type { TailoredResume, VerifyIssue, VerifyResult } from "../core/types";

/**
 * Verifier agent: the anti-hallucination layer. Two passes:
 *  1. Deterministic — every bullet must cite a real source bullet; no new numbers;
 *     no technologies that the source bullet doesn't mention.
 *  2. LLM entailment (optional) — "is the tailored claim fully supported by its source?"
 * Anything that fails is REPAIRED by reverting to the original text, so an unsupported
 * claim can never reach an application. Issues are kept for transparency/evals.
 */

const TECH_TERMS = [
  "Python", "Golang", "Rust", "C++", "C#", "Java", "Kotlin", "Scala", "Ruby", "PHP", "Swift", "TypeScript", "JavaScript",
  "React", "Angular", "Vue", "Next.js", "Node.js", "Django", "Flask", "FastAPI", "Spring Boot", "GraphQL",
  "Kubernetes", "EKS", "GKE", "Docker", "Terraform", "Ansible", "Jenkins", "GitHub Actions", "AWS", "GCP", "Azure", "Lambda",
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "RabbitMQ", "Spark", "Airflow", "dbt", "Snowflake", "BigQuery", "Databricks",
  "Elasticsearch", "PyTorch", "TensorFlow", "LangChain", "LlamaIndex", "LangGraph", "OpenAI", "Claude", "RAG", "MCP", "vector database",
  "pgvector", "Pinecone", "fine-tuning", "LoRA", "Salesforce", "SAP", "Workday",
];

export function allBankText(ws: Workspace): string {
  return [
    ...ws.experience.summaries,
    ws.profile.headline,
    ...ws.experience.roles.flatMap((r) => [r.title, r.company, ...r.bullets.map((b) => `${b.text} ${b.skills.join(" ")}`)]),
    ...ws.experience.projects.map((p) => `${p.name} ${p.text} ${p.skills.join(" ")}`),
    ...ws.experience.certifications,
    ...ws.experience.education.map((e) => `${e.school} ${e.degree} ${e.details ?? ""}`),
    ...Object.values(ws.experience.skills).flat(),
  ].join("\n");
}

function newNumbers(candidate: string, source: string): string[] {
  const src = new Set(extractNumbers(source));
  return extractNumbers(candidate).filter((n) => !src.has(n) && !src.has(n.replace(/[%kmx+]$/, "")));
}

function newTerms(candidate: string, sourceText: string, extraVocab: string[]): string[] {
  const terms = [...new Set([...TECH_TERMS, ...extraVocab])];
  return terms.filter((t) => containsTerm(candidate, t) && !containsTerm(sourceText, t));
}

function dropSentences(text: string, offenders: string[]): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !offenders.some((o) => s.toLowerCase().includes(o.toLowerCase())))
    .join(" ");
}

export function verifyDeterministic(t: TailoredResume, ws: Workspace): { resume: TailoredResume; issues: VerifyIssue[]; checked: number } {
  const issues: VerifyIssue[] = [];
  const vocab = skillVocabulary(ws.experience);
  const bank = new Map(ws.experience.roles.flatMap((r) => r.bullets.map((b) => [b.id!, { role: r, bullet: b }] as const)));
  const resume: TailoredResume = structuredClone(t);
  let checked = 0;

  for (const role of resume.roles) {
    const bankRole = ws.experience.roles.find((r) => r.id === role.roleId);
    if (!bankRole || bankRole.company !== role.company || bankRole.title !== role.title) {
      issues.push({ where: `role:${role.roleId}`, kind: "altered_identity", detail: "role identity differs from experience bank", repaired: true });
      if (bankRole) Object.assign(role, { company: bankRole.company, title: bankRole.title, start: bankRole.start, end: bankRole.end });
    }
    role.bullets = role.bullets.map((b) => {
      checked++;
      const src = bank.get(b.sourceId);
      if (!src || src.role.id !== role.roleId) {
        issues.push({ where: `bullet:${b.sourceId}`, kind: "unknown_source", detail: `cites unknown/foreign source "${b.sourceId}" — removed`, repaired: true });
        return null;
      }
      const sourceText = `${src.bullet.text} ${src.bullet.skills.join(" ")}`;
      const nums = newNumbers(b.text, src.bullet.text);
      const terms = newTerms(b.text, sourceText, vocab);
      if (nums.length || terms.length) {
        if (nums.length) issues.push({ where: `bullet:${b.sourceId}`, kind: "new_number", detail: `numbers not in source: ${nums.join(", ")}`, repaired: true });
        if (terms.length) issues.push({ where: `bullet:${b.sourceId}`, kind: "new_skill", detail: `terms not in source: ${terms.join(", ")}`, repaired: true });
        return { sourceId: b.sourceId, text: src.bullet.text }; // revert to the truth
      }
      return b;
    }).filter((b): b is { sourceId: string; text: string } => b !== null);
    if (!role.bullets.length && bankRole) role.bullets = bankRole.bullets.slice(0, 2).map((b) => ({ sourceId: b.id!, text: b.text }));
  }

  const bankText = allBankText(ws);
  for (const field of ["headline", "summary", "coverLetter"] as const) {
    checked++;
    const text = resume[field];
    const nums = newNumbers(text, bankText);
    const terms = newTerms(text, bankText, []);
    if (nums.length || terms.length) {
      const detail = [nums.length && `numbers: ${nums.join(", ")}`, terms.length && `terms: ${terms.join(", ")}`].filter(Boolean).join("; ");
      issues.push({ where: field, kind: nums.length ? "new_number" : "new_skill", detail: `not in experience bank (${detail})`, repaired: true });
      if (field === "summary") resume.summary = ws.experience.summaries[0];
      else if (field === "headline") resume.headline = ws.profile.headline;
      else resume.coverLetter = dropSentences(text, [...nums, ...terms]);
    }
  }
  return { resume, issues, checked };
}

const EntailSchema = z.object({
  results: z.array(z.object({ sourceId: z.string(), supported: z.boolean(), issue: z.string().optional() })),
});

export async function verifyResume(t: TailoredResume, ws: Workspace, llm: LLM | null): Promise<{ resume: TailoredResume; result: VerifyResult }> {
  const det = verifyDeterministic(t, ws);
  const resume = det.resume;
  const issues = [...det.issues];

  if (llm) {
    const bank = new Map(ws.experience.roles.flatMap((r) => r.bullets.map((b) => [b.id!, b.text] as const)));
    const pairs = resume.roles.flatMap((r) => r.bullets).filter((b) => bank.get(b.sourceId) !== b.text);
    if (pairs.length) {
      const out = await llm.json({
        name: "entailment",
        system:
          "You are a strict fact-checker. For each pair, decide if TAILORED is fully supported by SOURCE: every fact, scope, tool, ownership claim and metric in TAILORED must be stated or directly implied by SOURCE. Rewording is fine; inflation (e.g. 'contributed' -> 'led') is NOT supported.",
        schema: EntailSchema,
        maxTokens: 2000,
        prompt: pairs.map((p) => `<pair sourceId="${p.sourceId}">\nSOURCE: ${bank.get(p.sourceId)}\nTAILORED: ${p.text}\n</pair>`).join("\n"),
      });
      for (const r of out.results.filter((x) => !x.supported)) {
        issues.push({ where: `bullet:${r.sourceId}`, kind: "unsupported", detail: r.issue ?? "not entailed by source", repaired: true });
        for (const role of resume.roles) for (const b of role.bullets) if (b.sourceId === r.sourceId) b.text = bank.get(r.sourceId) ?? b.text;
      }
    }
  }

  return { resume, result: { pass: issues.every((i) => i.repaired), issues, checkedClaims: det.checked } };
}
