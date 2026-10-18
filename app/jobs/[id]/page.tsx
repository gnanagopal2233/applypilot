import { notFound } from "next/navigation";
import { getJob, jobEvents } from "../../../src/core/db";
import { loadWorkspace } from "../../../src/core/config";
import { resumeHtml } from "../../../src/render/resume";
import type { FieldPlan, GateDecision, ScoreResult, TailoredResume, VerifyResult } from "../../../src/core/types";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const job = getJob(id);
  if (!job) notFound();
  const parse = <T,>(s: string | null) => (s ? (JSON.parse(s) as T) : null);
  const score = parse<ScoreResult>(job.score_json);
  const tailored = parse<TailoredResume>(job.tailored_json);
  const verify = parse<VerifyResult>(job.verify_json);
  const gate = parse<GateDecision>(job.gate_json);
  const apply = parse<{ fields: FieldPlan[]; captcha: boolean; error?: string }>(job.apply_json);
  let preview: string | null = null;
  try {
    if (tailored) preview = resumeHtml(tailored, loadWorkspace().profile);
  } catch {
    preview = null;
  }
  const events = jobEvents(id);
  const action = `/api/jobs/${encodeURIComponent(id)}/action`;

  return (
    <>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{job.title}</h1>
            <div className="muted">
              {job.company} · {job.location} · <a href={job.url ?? "#"} target="_blank">posting ↗</a>
            </div>
            <div style={{ marginTop: 6 }}>
              <span className={`chip s-${job.status}`}>{job.status}</span> {job.status_reason ? <span className="muted">{job.status_reason}</span> : null}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 34, fontWeight: 800 }}>{job.score ?? "–"}</div>
            <div className="muted">fit score</div>
          </div>
        </div>
        <form method="post" action={action} className="actions" style={{ marginTop: 12 }}>
          <button className="primary" name="action" value="approve">Approve → submit on next run</button>
          <button name="action" value="skip">Skip</button>
          <button name="action" value="reset">Re-queue</button>
          {job.pdf_path ? (
            <a href={`/api/jobs/${encodeURIComponent(id)}/resume`} target="_blank">
              <button type="button">Download tailored PDF</button>
            </a>
          ) : null}
        </form>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>scorer</h2>
          {score ? (
            <>
              {score.llm ? (
                <>
                  <p>{score.llm.summary}</p>
                  <p className="muted">
                    skills {score.llm.skillsFit}/10 · role {score.llm.roleFit}/10 · seniority {score.llm.seniorityFit}/10 · domain {score.llm.domainFit}/10
                  </p>
                  {score.llm.mustHaveGaps.length ? <p className="warn">Gaps: {score.llm.mustHaveGaps.join("; ")}</p> : null}
                </>
              ) : null}
              <p>
                <b>Matched:</b> {score.matchedSkills.join(", ") || "—"}
              </p>
              {score.missingSkills.length ? (
                <p>
                  <b>JD mentions you don&apos;t list:</b> {score.missingSkills.join(", ")}
                </p>
              ) : null}
              {score.notes.map((n) => (
                <p key={n} className="muted">{n}</p>
              ))}
            </>
          ) : (
            <p className="muted">Not scored yet.</p>
          )}
        </div>

        <div className="panel">
          <h2>verifier + gate</h2>
          {verify ? (
            <>
              <p className={verify.issues.length ? "warn" : "ok"}>
                {verify.checkedClaims} claims checked · {verify.issues.length} repaired (reverted to source text)
              </p>
              <ul className="issues">
                {verify.issues.map((i, k) => (
                  <li key={k}>
                    <b>{i.where}</b> — {i.kind}: {i.detail}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">Not tailored yet.</p>
          )}
          {gate ? (
            <p style={{ marginTop: 10 }}>
              <b>Gate:</b> <span className={gate.decision === "auto_submit" ? "ok" : "warn"}>{gate.decision}</span> — {gate.reasons.join("; ")}
            </p>
          ) : null}
        </div>
      </div>

      {apply?.fields?.length ? (
        <div className="panel">
          <h2>form plan {apply.captcha ? <span className="warn">(CAPTCHA detected)</span> : null}</h2>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th>Source</th>
                <th>Conf.</th>
              </tr>
            </thead>
            <tbody>
              {apply.fields.map((f, i) => (
                <tr key={i}>
                  <td>
                    {f.label} {f.required ? <span className="bad">*</span> : null}
                  </td>
                  <td style={{ maxWidth: 420 }}>{f.value ?? <span className="bad">— needs you —</span>}</td>
                  <td>
                    <span className="chip">{f.source}</span>
                  </td>
                  <td className={f.confidence >= 0.8 ? "ok" : "warn"}>{Math.round(f.confidence * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid2">
        <div className="panel">
          <h2>tailored resume</h2>
          {preview ? <iframe className="resume" srcDoc={preview} title="resume" /> : <p className="muted">Run tailor to generate.</p>}
        </div>
        <div className="panel">
          <h2>job description</h2>
          <pre className="jd">{job.description}</pre>
          {tailored ? (
            <>
              <h2 style={{ marginTop: 14 }}>cover letter</h2>
              <pre className="jd">{tailored.coverLetter}</pre>
            </>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <h2>trace</h2>
        <table>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="muted">{e.ts}</td>
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
