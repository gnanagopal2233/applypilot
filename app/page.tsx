import { listJobs, recentEvents, statusCounts, submittedToday } from "../src/core/db";
import type { JobStatus } from "../src/core/types";

export const dynamic = "force-dynamic";

const ORDER: JobStatus[] = ["review", "ready", "tailored", "scored", "submitted", "new", "filtered", "skipped", "failed"];

export default async function Home({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const counts = statusCounts();
  const active = (status as JobStatus) || undefined;
  const jobs = listJobs({ status: active ?? ["review", "ready", "tailored", "scored", "submitted"], limit: 200 });
  const events = recentEvents(25);

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span>submitted today</span>
          <b>{submittedToday()}</b>
        </div>
        {ORDER.map((s) => (
          <a key={s} href={`/?status=${s}`} className={`stat ${active === s ? "active" : ""}`}>
            <span>{s}</span>
            <b>{counts[s] ?? 0}</b>
          </a>
        ))}
      </div>

      <div className="panel">
        <h2>{active ? `${active} jobs` : "pipeline"}</h2>
        {jobs.length === 0 ? (
          <p className="muted">
            Nothing here yet. Run <code>npm run cli run</code> (or <code>npm run cli add &lt;url&gt;</code>).
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Score</th>
                <th>Role</th>
                <th>Company</th>
                <th>Location</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="num">{j.score ?? "–"}</td>
                  <td>
                    <a href={`/jobs/${encodeURIComponent(j.id)}`}>{j.title}</a>
                    {j.status_reason ? <div className="muted" style={{ fontSize: 12 }}>{j.status_reason}</div> : null}
                  </td>
                  <td>{j.company}</td>
                  <td className="muted">{j.location}</td>
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
        <h2>agent trace</h2>
        <table>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{e.ts}</td>
                <td>
                  <span className="chip">{e.agent}</span>
                </td>
                <td className={e.level === "error" ? "bad" : e.level === "warn" ? "warn" : ""}>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
