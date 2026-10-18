"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadWorkspace } from "../src/core/config";
import { getJob, setStatus, updateJob } from "../src/core/db";
import { runDoctor } from "../src/core/doctor";
import { getLLM } from "../src/core/llm";
import { createProfileFromExamples, PROFILE_FILES, saveProfileFile, updateEnv, type ProfileFile } from "../src/core/settings";
import { startTask } from "../src/core/tasks";
import { addJobByUrl, applyJob, filterAndScore, runPipeline, scout, tailorJob } from "../src/agents/pipeline";
import { scoreJob } from "../src/agents/scorer";

function back(path: string, msg?: string, error?: string): never {
  revalidatePath(path);
  const q = new URLSearchParams();
  if (msg) q.set("msg", msg);
  if (error) q.set("error", error);
  redirect(q.size ? `${path}?${q}` : path);
}

function launch(kind: string, label: string, fn: () => Promise<unknown>, returnTo: string) {
  const r = startTask(kind, label, fn);
  back(returnTo, r.ok ? `Started: ${label}` : undefined, r.ok ? undefined : r.reason);
}

/* ---------------- Pipeline ---------------- */

export async function runPipelineAction() {
  launch("pipeline", "Full run (find → score → tailor → check → apply)", () => runPipeline(), "/");
}

export async function scoutAction() {
  launch("scout", "Find new jobs + score", async () => ({ ...(await scout()), ...(await filterAndScore(loadWorkspace(true), getLLM())) }), "/");
}

export async function addUrlAction(form: FormData) {
  const url = String(form.get("url") || "").trim();
  if (!/^https?:\/\//.test(url)) back("/", undefined, "Paste a full job URL starting with https://");
  launch(
    "add",
    `Add job ${url}`,
    async () => {
      const job = await addJobByUrl(url);
      const s = await scoreJob(job, loadWorkspace(true), getLLM());
      updateJob(job.id, { score: s.score, score_json: JSON.stringify(s), status: "scored" });
      return { id: job.id, score: s.score };
    },
    "/",
  );
}

/* ---------------- Per job ---------------- */

export async function jobAction(form: FormData) {
  const id = String(form.get("id"));
  const action = String(form.get("action"));
  const path = `/jobs/${encodeURIComponent(id)}`;
  const job = getJob(id);
  if (!job) back("/", undefined, "Job not found");

  switch (action) {
    case "approve":
      setStatus(id, job.tailored_json ? "ready" : "scored", "approved in web app");
      back(path, job.tailored_json ? "Approved — it will be submitted on the next run (or press Apply now)" : "Approved — tailor it next");
    case "skip":
      setStatus(id, "skipped", "skipped in web app");
      back(path, "Skipped");
    case "reset":
      setStatus(id, job.tailored_json ? "tailored" : "new", "re-queued in web app");
      back(path, "Re-queued");
    case "tailor":
      launch("tailor", `Tailor ${job.title} @ ${job.company}`, () => tailorJob(id, loadWorkspace(true), getLLM()), path);
    case "apply":
      launch(
        "apply",
        `Apply ${job.title} @ ${job.company}`,
        async () => {
          const ws = loadWorkspace(true);
          if (!getJob(id)?.tailored_json) await tailorJob(id, ws, getLLM());
          return applyJob(id, ws, getLLM());
        },
        path,
      );
    case "apply_browser":
      launch(
        "apply",
        `Fill form in browser — ${job.company}`,
        async () => {
          const ws = loadWorkspace(true);
          if (!getJob(id)?.tailored_json) await tailorJob(id, ws, getLLM());
          return applyJob(id, ws, getLLM(), { headed: true, holdForHumanMs: 15 * 60_000 });
        },
        path,
      );
    default:
      back(path, undefined, `Unknown action ${action}`);
  }
}

/* ---------------- Settings ---------------- */

export async function saveFileAction(form: FormData) {
  const name = String(form.get("file")) as ProfileFile;
  if (!(name in PROFILE_FILES)) back("/settings", undefined, "Unknown file");
  const r = saveProfileFile(name, String(form.get("content") ?? ""));
  loadWorkspace(true);
  revalidatePath("/settings");
  const q = new URLSearchParams({ file: name, ...(r.ok ? { msg: `Saved ${name}` } : { error: `${name}: ${r.error}` }) });
  redirect(`/settings?${q}`);
}

export async function createProfileAction() {
  createProfileFromExamples();
  back("/settings", "Created your profile from the examples. Edit each file below.");
}

export async function saveModelAction(form: FormData) {
  const provider = String(form.get("provider") || "anthropic");
  const key = String(form.get("apiKey") || "").trim();
  updateEnv({
    LLM_PROVIDER: provider,
    LLM_MODEL: String(form.get("model") || "").trim() || undefined,
    [provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]: provider === "ollama" ? undefined : key || undefined,
    OLLAMA_BASE_URL: provider === "ollama" ? String(form.get("baseUrl") || "").trim() || undefined : undefined,
  });
  back("/settings", "Model settings saved");
}

export async function doctorAction() {
  launch("doctor", "Run setup checks", () => runDoctor(), "/settings");
}
