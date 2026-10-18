/** Offline end-to-end smoke test: fake LLM + local form. `tsx evals/smoke.ts` */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exampleWorkspace } from "../tests/helpers";
import type { LLM } from "../src/core/llm";
import { tailorResume } from "../src/agents/tailor";
import { verifyResume } from "../src/agents/verifier";
import { resumeHtml, renderPdf } from "../src/render/resume";
import { runApplication } from "../src/agents/applier";
import { decide } from "../src/agents/gate";
import type { JobPosting } from "../src/core/types";

const ws = exampleWorkspace();
const fake: LLM = {
  name: "fake",
  async json({ name }: { name: string }) {
    if (name === "tailored_resume")
      return {
        headline: "Forward Deployed Engineer",
        summary: ws.experience.summaries[0],
        roles: [
          { roleId: "acme", bullets: [
            { sourceId: "acme.2", text: "Embedded with three hospital customers to scope and ship HL7 integrations, owning requirements through production rollout." },
            { sourceId: "acme.1", text: "Built a RAG support assistant over 4,000 SOPs with TypeScript, PostgreSQL and pgvector, cutting ticket resolution time by 45%." }, // inflated -> must be repaired
          ] },
          { roleId: "globex", bullets: [{ sourceId: "globex.1", text: ws.experience.roles[1].bullets[0].text }] },
        ],
        skillsPriority: ["RAG", "TypeScript", "LLM"],
        coverLetter: "I like deploying LLM systems with customers.\n\nAt Acme Health I embedded with hospital customers.",
      } as never;
    if (name === "entailment") return { results: [] } as never;
    if (name === "form_answers") return { answers: [{ apId: "ap8", answer: "I enjoy working directly with customers to ship LLM systems.", confidence: 0.85 }] } as never;
    throw new Error("unexpected " + name);
  },
};

const out = fs.mkdtempSync(path.join(os.tmpdir(), "applypilot-smoke-"));
const job: JobPosting = { id: "other:local:1", ats: "other", company: "Acme", title: "Forward Deployed Engineer", location: "Remote", url: "", applyUrl: "file://" + path.resolve("evals/fixtures/form.html"), description: "LLM RAG TypeScript customer-facing" };

const draft = await tailorResume(job, ws, fake, null);
const { resume, result } = await verifyResume(draft, ws, fake);
console.log("verifier issues:", result.issues.map((i) => `${i.where}:${i.kind}`));
if (!result.issues.some((i) => i.kind === "new_number")) throw new Error("verifier missed inflated metric");
const pdf = await renderPdf(resumeHtml(resume, ws.profile), path.join(out, "resume.pdf"));
console.log("pdf bytes:", fs.statSync(pdf).size);

const profile = structuredClone(ws.profile); profile.automation.autoSubmit = true;
const res = await runApplication(job, { ...ws, profile }, { submit: true, headless: true, resumePdf: pdf, coverLetterText: resume.coverLetter, outDir: out, llm: fake }, (fields, captcha) => {
  const g = decide({ job: { ...job, ats: "greenhouse" }, profile, score: { score: 90, keywordCoverage: 1, matchedSkills: [], missingSkills: [], notes: [] }, verify: result, submittedToday: 0, submittedToCompany30d: 0, fields, captcha });
  console.log("gate:", g);
  return g.decision === "auto_submit";
});
console.table(res.fields.map((f) => ({ label: f.label.slice(0, 45), value: (f.value ?? "").slice(0, 30), source: f.source, conf: f.confidence })));
console.log({ submitted: res.submitted, confirmation: res.confirmation, error: res.error });
if (!res.submitted) process.exit(1);
