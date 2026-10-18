import fs from "node:fs";
import path from "node:path";
import { env, loadWorkspace, type Workspace } from "../core/config";
import { getJob, listJobs, logEvent, rowToPosting, setStatus, submittedForCompany, submittedToday, updateJob, upsertJobs, type JobRow } from "../core/db";
import { getEmbedder, getLLM, type LLM } from "../core/llm";
import { pLimit, slug } from "../core/text";
import type { JobPosting, ScoreResult, TailoredResume, VerifyResult } from "../core/types";
import { runApplication } from "./applier";
import { applyHardFilters } from "./filters";
import { decide } from "./gate";
import { keywordCoverage, scoreJob } from "./scorer";
import { fetchBoard, fetchJobByUrl } from "./sources";
import { tailorResume } from "./tailor";
import { verifyResume } from "./verifier";
import { renderPdf, resumeHtml } from "../render/resume";

/* ---------------- Scout ---------------- */

export async function scout(ws: Workspace = loadWorkspace()) {
  let found = 0,
    added = 0;
  await pLimit(ws.targets.companies, 4, async (c) => {
    try {
      const jobs = await fetchBoard(c.ats, c.slug, c.name);
      found += jobs.length;
      const n = upsertJobs(jobs);
      added += n;
      logEvent("scout", "info", `${c.name}: ${jobs.length} open, ${n} new`);
    } catch (e) {
      logEvent("scout", "warn", `${c.name} (${c.ats}/${c.slug}) failed: ${(e as Error).message}`);
    }
  });
  return { found, added };
}

export async function addJobByUrl(url: string) {
  const job = await fetchJobByUrl(url);
  upsertJobs([job]);
  logEvent("scout", "info", `added ${job.title} @ ${job.company}`, job.id);
  return job;
}

/* ---------------- Filter + Score ---------------- */

export async function filterAndScore(ws: Workspace, llm: LLM | null, maxLlm = env.maxLlmScores) {
  const fresh = listJobs({ status: "new", limit: 5000 });
  const passing: { row: JobRow; job: JobPosting; cov: number }[] = [];
  for (const row of fresh) {
    const job = rowToPosting(row);
    const f = applyHardFilters(job, ws.profile);
    if (!f.pass) {
      setStatus(job.id, "filtered", f.reasons.join("; "));
      continue;
    }
    passing.push({ row, job, cov: keywordCoverage(job, ws).coverage });
  }
  // Spend LLM budget on the most promising jobs first.
  passing.sort((a, b) => b.cov - a.cov);
  const toLlm = passing.slice(0, maxLlm);
  const rest = passing.slice(maxLlm);
  await pLimit(toLlm, 3, async ({ job }) => {
    try {
      const s = await scoreJob(job, ws, llm);
      updateJob(job.id, { score: s.score, score_json: JSON.stringify(s), status: "scored" });
      logEvent("scorer", "info", `score ${s.score} — ${job.title} @ ${job.company}`, job.id);
    } catch (e) {
      logEvent("scorer", "error", (e as Error).message, job.id);
      throw e; // auth/quota errors must surface, not silently produce empty runs
    }
  });
  logEvent("scorer", "info", `${fresh.length} new → ${passing.length} passed filters → ${toLlm.length} LLM-scored (${rest.length} deferred to next run)`);
  return { considered: fresh.length, passed: passing.length, scored: toLlm.length };
}

/* ---------------- Tailor + Verify ---------------- */

export function jobOutDir(jobId: string) {
  return path.join(env.dataDir, "applications", slug(jobId));
}

export async function tailorJob(jobId: string, ws: Workspace, llm: LLM) {
  const row = getJob(jobId);
  if (!row) throw new Error(`no job ${jobId}`);
  const job = rowToPosting(row);
  const draft = await tailorResume(job, ws, llm, getEmbedder());
  const { resume, result } = await verifyResume(draft, ws, llm);
  const dir = jobOutDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const html = resumeHtml(resume, ws.profile);
  fs.writeFileSync(path.join(dir, "resume.html"), html);
  fs.writeFileSync(path.join(dir, "cover-letter.txt"), resume.coverLetter);
  fs.writeFileSync(path.join(dir, "job.md"), `# ${job.title} — ${job.company}\n${job.url}\n\n${job.description}`);
  const pdf = await renderPdf(html, path.join(dir, `${slug(ws.profile.identity.firstName + "-" + ws.profile.identity.lastName)}-resume.pdf`));
  const clHtml = `<html><body style="font-family:Calibri,Arial;font-size:11pt;line-height:1.45;margin:0.8in">${resume.coverLetter
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/</g, "&lt;")}</p>`)
    .join("")}<p>${ws.profile.identity.firstName} ${ws.profile.identity.lastName}</p></body></html>`;
  await renderPdf(clHtml, path.join(dir, "cover-letter.pdf"));
  updateJob(jobId, { tailored_json: JSON.stringify(resume), verify_json: JSON.stringify(result), pdf_path: pdf, status: "tailored" });
  logEvent("verifier", result.issues.length ? "warn" : "info", `${result.checkedClaims} claims checked, ${result.issues.length} repaired`, jobId, result.issues);
  return { resume, result, pdf };
}

/* ---------------- Gate + Apply ---------------- */

export async function applyJob(jobId: string, ws: Workspace, llm: LLM | null, opts: { headed?: boolean; holdForHumanMs?: number } = {}) {
  const row = getJob(jobId);
  if (!row?.tailored_json || !row.score_json || !row.verify_json || !row.pdf_path) throw new Error(`${jobId} is not tailored yet`);
  const job = rowToPosting(row);
  const score = JSON.parse(row.score_json) as ScoreResult;
  const verify = JSON.parse(row.verify_json) as VerifyResult;
  const resume = JSON.parse(row.tailored_json) as TailoredResume;
  const humanApproved = row.status === "ready";
  const gateBase = {
    job,
    profile: ws.profile,
    score,
    verify,
    submittedToday: submittedToday(),
    submittedToCompany30d: submittedForCompany(job.company),
    humanApproved,
  };
  const pre = decide(gateBase);
  if (pre.decision === "skip") {
    setStatus(jobId, "skipped", pre.reasons.join("; "));
    logEvent("gate", "info", `skip: ${pre.reasons.join("; ")}`, jobId);
    return { decision: "skip" as const, reasons: pre.reasons };
  }
  if (job.ats === "other") {
    setStatus(jobId, "review", "unsupported ATS — apply manually with the tailored resume");
    return { decision: "review" as const, reasons: ["unsupported ATS"] };
  }

  const dir = jobOutDir(jobId);
  const mayAutoSubmit = !ws.profile.automation.dryRun && (pre.decision === "auto_submit" || humanApproved);
  let finalGate = pre;
  const res = await runApplication(
    job,
    ws,
    {
      submit: mayAutoSubmit && !opts.headed,
      headless: opts.headed ? false : env.headless,
      resumePdf: row.pdf_path,
      coverLetterPdf: path.join(dir, "cover-letter.pdf"),
      coverLetterText: resume.coverLetter,
      outDir: dir,
      llm,
      holdForHumanMs: opts.holdForHumanMs,
    },
    (fields, captcha) => {
      finalGate = decide({ ...gateBase, fields, captcha });
      return finalGate.decision === "auto_submit" || (humanApproved && finalGate.decision !== "skip" && !captcha);
    },
  );
  updateJob(jobId, { apply_json: JSON.stringify(res), gate_json: JSON.stringify(finalGate) });

  if (res.submitted) {
    setStatus(jobId, "submitted", res.confirmation);
    logEvent("applier", "info", `SUBMITTED — ${job.title} @ ${job.company}`, jobId);
  } else if (res.error && !res.fields.length) {
    setStatus(jobId, "failed", res.error);
    logEvent("applier", "error", res.error, jobId);
  } else {
    const why = ws.profile.automation.dryRun ? ["dryRun is on"] : finalGate.reasons;
    setStatus(jobId, "review", why.join("; "));
    logEvent("gate", "info", `review: ${why.join("; ")}`, jobId);
  }
  return { decision: res.submitted ? "submitted" : "review", reasons: finalGate.reasons, result: res };
}

/* ---------------- Full run ---------------- */

export async function runPipeline(opts: { skipScout?: boolean; applyLimit?: number } = {}) {
  const ws = loadWorkspace(true);
  const llm = getLLM();
  const summary: Record<string, unknown> = {};
  if (!opts.skipScout) summary.scout = await scout(ws);
  summary.score = await filterAndScore(ws, llm);

  const toTailor = listJobs({ status: "scored", minScore: ws.profile.automation.minScoreToTailor, limit: 50 });
  let tailored = 0;
  for (const r of toTailor) {
    try {
      await tailorJob(r.id, ws, llm);
      tailored++;
    } catch (e) {
      logEvent("tailor", "error", (e as Error).message, r.id);
    }
  }
  summary.tailored = tailored;

  const toApply = listJobs({ status: ["tailored", "ready"], limit: opts.applyLimit ?? ws.profile.automation.dailyCap * 2 });
  const outcomes: Record<string, number> = {};
  for (const r of toApply) {
    if (submittedToday() >= ws.profile.automation.dailyCap) break;
    try {
      const o = await applyJob(r.id, ws, llm);
      outcomes[o.decision] = (outcomes[o.decision] ?? 0) + 1;
    } catch (e) {
      logEvent("applier", "error", (e as Error).message, r.id);
      outcomes.error = (outcomes.error ?? 0) + 1;
    }
  }
  summary.apply = outcomes;
  logEvent("pipeline", "info", `run complete ${JSON.stringify(summary)}`);
  return summary;
}

export async function notify(text: string) {
  const url = process.env.NOTIFY_WEBHOOK;
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
}
