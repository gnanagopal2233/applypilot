import { listJobs, recentEvents, statusCounts, submittedToday } from "../src/core/db";
import { loadWorkspace } from "../src/core/config";
import { llmSettings, profileReady } from "../src/core/settings";
import type { JobStatus } from "../src/core/types";
import { addUrlAction, runPipelineAction, scoutAction } from "./actions";
import Flash from "./components/Flash";

export const dynamic = "force-dynamic";

const ORDER: { s: JobStatus; label: string }[] = [
  { s: "review", label: "needs you" },
  { s: "ready", label: "approved" },
  { s: "tailored", label: "tailored" },
  { s: "scored", label: "scored" },
  { s: "submitted", label: "submitted" },
  { s: "new", label: "new" },
  { s: "filtered", label: "filtered out" },
  { s: "skipped", label: "skipped" },
  { s: "failed", label: "failed" },
];

export default async function Home({ searchParams }: { searchParams: Promise<{ status?: string; msg?: string; error?: string }> }) {
  const { status, msg, error } = await searchParams;

  if (!profileReady()) {
    return (
      <div className="panel hero-panel">
        <h1>Welcome to ApplyPilot</h1>
        <p>Set up three things and you&apos;re ready:</p>
        <ol>
          <li>Your profile, experience bank, saved answers and target companies</li>
          <li>A language model API key (Anthropic, OpenAI, or a local Ollama model)</li>
          <li>Run the setup checks</li>
        </ol>
        <a className="btn primary" href="/settings">
          Go to Settings →
        </a>
      </div>
    );
  }

  const counts = statusCounts();
  const active = (status as JobStatus) || undefined;
  const jobs = listJobs({ status: active ?? ["review", "ready", "tailored", "scored", "submitted"], limit: 300 });
  const events = recentEvents(20);
  const llm = llmSettings();
  let auto = "";
  try {
    const a = loadWorkspace().profile.automation;
    auto = a.dryRun ? "Dry run: forms are filled but never submitted" : a.autoSubmit ? `Auto-submit ON for score ≥ ${a.minScoreToAutoSubmit} · cap ${a.dailyCap}/day` : "Auto-submit OFF: everything goes to review";
  } catch (e) {
    auto = (e as Error).message;
  }

  return (
    <>
      <Flash msg={msg} error={error} />
      {!llm.keySet ? (
        <div className="flash flash-bad">
          No API key set for {llm.provider}. <a href="/settings">Add it in Settings</a>.
        </div>
      ) : null}

      <div className="panel toolbar">
        <div className="toolbar-row">
          <form action={runPipelineAction}>
            <button className="primary">▶ Run full pipeline</button>
          </form>
          <form action={scoutAction}>
            <button>Find new jobs</button>
          </form>
          <form action={addUrlAction} className="addurl">
            <input name="url" type="url" placeholder="Paste a job URL (Greenhouse, Lever, Ashby…)" required />
            <button>Add &amp; score</button>
          </form>
        </div>
        <div className="muted small">{auto}</div>
      </div>

      <div className="stats">
        <div className="stat">
          <span>submitted today</span>
          <b>{submittedToday()}</b>
        </div>
        {ORDER.map(({ s, label }) => (
          <a key={s} href={`/?status=${s}`} className={`stat ${active === s ? "active" : ""} ${s === "review" && counts[s] ? "attention" : ""}`}>
            <span>{label}</span>
            <b>{counts[s] ?? 0}</b>
          </a>
        ))}
      </div>

      <div className="panel">
        <h2>{active ? ORDER.find((o) => o.s === active)?.label ?? active : "pipeline"}</h2>
        {jobs.length === 0 ? (
          <p className="muted">Nothing here yet. Press “Run full pipeline” or paste a job URL above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Score</th>
                <th>Role</th>
                <th>Company</th>
                <th className="hide-sm">Location</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="num">
                    <span className={`score ${j.score === null ? "" : j.score >= 80 ? "hi" : j.score >= 60 ? "mid" : "lo"}`}>{j.score ?? "–"}</span>
                  </td>
                  <td>
                    <a href={`/jobs/${encodeURIComponent(j.id)}`}>{j.title}</a>
                    {j.status_reason ? <div className="muted small">{j.status_reason}</div> : null}
                  </td>
                  <td>{j.company}</td>
                  <td className="muted hide-sm">{j.location}</td>
                  <td>
                    <span className={`chip s-${j.status}`}>{j.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>activity</h2>
        <table>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="muted small nowrap">{e.ts}</td>
                <td>
                  <span className="chip">{e.agent}</span>
                </td>
                <td className={e.level === "error" ? "bad" : e.level === "warn" ? "warn" : ""}>
                  {e.job_id ? <a href={`/jobs/${encodeURIComponent(e.job_id)}`}>{e.message}</a> : e.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
