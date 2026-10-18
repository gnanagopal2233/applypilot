import { skillVocabulary, type Workspace } from "../core/config";
import type { Embedder, LLM } from "../core/llm";
import { hybridSearch } from "../core/retrieval";
import { bannedIn, containsTerm } from "../core/text";
import { TailorLLMSchema, type JobPosting, type TailoredResume } from "../core/types";

/**
 * Tailor agent (RAG). It never writes a resume from scratch: it RETRIEVES the most
 * relevant bullets from the candidate's experience bank, then asks the LLM to select,
 * order and lightly re-phrase them. Every output bullet carries the id of its source
 * bullet so the Verifier can check it claim-by-claim.
 */

export async function retrieveEvidence(job: JobPosting, ws: Workspace, embedder: Embedder | null, perRole = 5) {
  const corpus = ws.experience.roles.flatMap((r) => r.bullets.map((b) => ({ id: b.id!, text: `${b.text} ${b.skills.join(" ")} ${b.tags.join(" ")}` })));
  const query = `${job.title}\n${job.description}`.slice(0, 8000);
  const hits = await hybridSearch(corpus, query, corpus.length, embedder);
  const rank = new Map(hits.map((h, i) => [h.id, i]));
  return ws.experience.roles.map((r) => {
    const ordered = [...r.bullets].sort((a, b) => (rank.get(a.id!) ?? 999) - (rank.get(b.id!) ?? 999));
    return { role: r, bullets: ordered.slice(0, perRole) };
  });
}

const SYSTEM = `You tailor resumes for a specific job. HARD RULES — violating any of them makes the output unusable:
1. Use ONLY facts in <evidence>. Never add a number, metric, tool, employer, title, date, certification or responsibility that is not in the source bullet you cite.
2. Each output bullet must cite exactly one "sourceId" and may only rephrase THAT bullet (reorder clauses, mirror the job's terminology for things the bullet already says, tighten wording).
3. Keep every number exactly as written in the source.
4. You may drop weak bullets; keep 2-5 bullets per role, most relevant first. Keep every role.
5. The summary and headline may only use facts that appear somewhere in the evidence or the candidate summary.
6. skillsPriority: order the candidate's EXISTING skills by relevance to the job (never add new ones).
7. coverLetter: 3 short paragraphs, specific to the company and role, same factual rules, no clichés, no em-dashes.`;

export async function tailorResume(job: JobPosting, ws: Workspace, llm: LLM, embedder: Embedder | null): Promise<TailoredResume> {
  const evidence = await retrieveEvidence(job, ws, embedder);
  const vocab = skillVocabulary(ws.experience);
  const evidenceText = evidence
    .map(({ role, bullets }) => `<role id="${role.id}" company="${role.company}" title="${role.title}" dates="${role.start} – ${role.end}">\n${bullets.map((b) => `  [${b.id}] ${b.text}`).join("\n")}\n</role>`)
    .join("\n");

  const out = await llm.json({
    name: "tailored_resume",
    system: ws.profile.style.bannedTerms.length
      ? `${SYSTEM}\n8. NEVER use these words or phrases anywhere (not in headline, summary, bullets or cover letter): ${ws.profile.style.bannedTerms.map((t) => `"${t}"`).join(", ")}.`
      : SYSTEM,
    schema: TailorLLMSchema,
    maxTokens: 5000,
    prompt: `<job>\nTitle: ${job.title}\nCompany: ${job.company}\n\n${job.description.slice(0, 10000)}\n</job>\n\n<candidate_summary>\n${ws.experience.summaries.join("\n")}\nHeadline: ${ws.profile.headline}\n</candidate_summary>\n\n<evidence>\n${evidenceText}\n</evidence>\n\n<candidate_skills>${vocab.join(", ")}</candidate_skills>\n\nProduce the tailored resume.`,
  });

  // Assemble with identity fields copied from the bank (the LLM never controls them).
  const roles = ws.experience.roles.map((r) => {
    const fromLlm = out.roles.find((x) => x.roleId === r.id);
    const bullets = fromLlm?.bullets?.length ? fromLlm.bullets : r.bullets.slice(0, 3).map((b) => ({ sourceId: b.id!, text: b.text }));
    return { roleId: r.id, company: r.company, title: r.title, location: r.location, start: r.start, end: r.end, bullets };
  });

  // Reorder skills inside each category by the LLM's priority; drop anything not in the bank.
  const prio = out.skillsPriority.filter((s) => vocab.some((v) => v.toLowerCase() === s.toLowerCase()));
  const rankOf = (s: string) => {
    const i = prio.findIndex((p) => p.toLowerCase() === s.toLowerCase());
    return i < 0 ? 999 : i;
  };
  const banned = ws.profile.style.bannedTerms;
  const skills = Object.fromEntries(
    Object.entries(ws.experience.skills)
      .map(([cat, list]) => [cat, list.filter((s) => !bannedIn(s, banned).length).sort((a, b) => rankOf(a) - rankOf(b))] as const)
      .filter(([cat, list]) => list.length && !bannedIn(cat, banned).length),
  );
  const catScore = (list: string[]) => Math.min(...list.map(rankOf));
  const orderedSkills = Object.fromEntries(Object.entries(skills).sort((a, b) => catScore(a[1]) - catScore(b[1])));

  // Projects: keep those relevant to the JD first.
  const projects = [...ws.experience.projects].filter((p) => !bannedIn(`${p.name} ${p.text}`, banned).length).sort(
    (a, b) => b.skills.filter((s) => containsTerm(job.description, s)).length - a.skills.filter((s) => containsTerm(job.description, s)).length,
  );

  return {
    headline: out.headline,
    summary: out.summary,
    roles,
    skills: orderedSkills,
    projects,
    education: ws.experience.education,
    certifications: ws.experience.certifications.filter((c) => !bannedIn(c, banned).length),
    coverLetter: out.coverLetter,
  };
}
