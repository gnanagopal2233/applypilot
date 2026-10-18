/**
 * Hallucination eval for the Verifier. Each case is a tailored bullet that is either
 * faithful or fabricated; we measure how many fabrications are caught (recall) and how
 * many faithful rewrites are wrongly reverted (false-positive rate).
 *
 *   npm run eval            deterministic layer only (free, offline)
 *   npm run eval -- --llm   + LLM entailment layer (uses your API key)
 */
import { exampleWorkspace } from "../tests/helpers";
import { verifyDeterministic, verifyResume } from "../src/agents/verifier";
import { getLLM } from "../src/core/llm";
import type { TailoredResume } from "../src/core/types";

const ws = exampleWorkspace();
type Case = { sourceId: string; text: string; fabricated: boolean; why: string };

const CASES: Case[] = [
  { sourceId: "acme.1", fabricated: false, why: "faithful rephrase", text: "Shipped a RAG support assistant over 4,000 internal SOPs (TypeScript, PostgreSQL, pgvector), cutting ticket resolution time by 30%." },
  { sourceId: "acme.1", fabricated: true, why: "inflated metric", text: "Built a RAG assistant over 4,000 SOPs, cutting ticket resolution time by 50%." },
  { sourceId: "acme.1", fabricated: true, why: "invented tool", text: "Built a RAG assistant with LangChain and Pinecone over 4,000 SOPs, cutting resolution time by 30%." },
  { sourceId: "acme.1", fabricated: true, why: "invented scale", text: "Built a RAG assistant over 40,000 SOPs used by 2,000 agents, cutting resolution time by 30%." },
  { sourceId: "acme.2", fabricated: false, why: "mirrors JD wording", text: "Worked on-site with three hospital customers as a forward-deployed engineer, scoping and shipping HL7 integrations from requirements to production." },
  { sourceId: "acme.2", fabricated: true, why: "scope inflation (LLM layer)", text: "Led a team of engineers embedded with three hospital customers and owned the HL7 integration roadmap." },
  { sourceId: "acme.3", fabricated: false, why: "faithful", text: "Designed RBAC and audit logging that passed a SOC 2 Type II audit with zero findings." },
  { sourceId: "acme.3", fabricated: true, why: "invented platform", text: "Designed RBAC and audit logging on Kubernetes that passed a SOC 2 Type II audit." },
  { sourceId: "globex.1", fabricated: false, why: "faithful", text: "Split a monolithic billing app into 4 Node.js services on AWS ECS; p95 latency fell from 900ms to 250ms." },
  { sourceId: "globex.1", fabricated: true, why: "invented language", text: "Rewrote a billing monolith into 4 Golang services on AWS ECS, improving p95 latency from 900ms to 250ms." },
  { sourceId: "globex.2", fabricated: false, why: "faithful", text: "Automated CI/CD in GitHub Actions, taking releases from 2 days to 3 hours." },
  { sourceId: "globex.2", fabricated: true, why: "invented tool", text: "Automated CI/CD with Jenkins and Terraform, cutting release time from 2 days to 3 hours." },
];

function wrap(c: Case): TailoredResume {
  const role = ws.experience.roles.find((r) => c.sourceId.startsWith(r.id + "."))!;
  return {
    headline: ws.profile.headline,
    summary: ws.experience.summaries[0],
    roles: [{ roleId: role.id, company: role.company, title: role.title, start: role.start, end: role.end, bullets: [{ sourceId: c.sourceId, text: c.text }] }],
    skills: ws.experience.skills,
    projects: [],
    education: [],
    certifications: [],
    coverLetter: "",
  };
}

const useLlm = process.argv.includes("--llm");
const llm = useLlm ? getLLM() : null;
let tp = 0, fn = 0, fp = 0, tn = 0;
for (const c of CASES) {
  const flagged = useLlm ? (await verifyResume(wrap(c), ws, llm)).result.issues.length > 0 : verifyDeterministic(wrap(c), ws).issues.length > 0;
  if (c.fabricated && flagged) tp++;
  else if (c.fabricated) fn++;
  else if (flagged) fp++;
  else tn++;
  console.log(`${flagged === c.fabricated ? "✔" : "✖"} ${c.fabricated ? "FAB " : "TRUE"} flagged=${flagged}  ${c.why}`);
}
const recall = tp / (tp + fn);
console.log(`\nlayer: ${useLlm ? "deterministic + LLM" : "deterministic"}`);
console.log(`fabrications caught: ${tp}/${tp + fn} (recall ${(recall * 100).toFixed(0)}%)`);
console.log(`faithful rewrites wrongly reverted: ${fp}/${fp + tn}`);
if (fp > 0) process.exitCode = 1;
