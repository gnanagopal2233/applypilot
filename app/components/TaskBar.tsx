"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Task = { id: string; label: string; status: "running" | "done" | "error"; startedAt: string; endedAt?: string; error?: string; result?: unknown };

/** Shows the running background task and refreshes the page when it finishes. */
export default function TaskBar() {
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null);
  const lastStatus = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/tasks", { cache: "no-store" });
        const { current } = (await r.json()) as { current: Task | null };
        if (stop) return;
        setTask(current);
        const key = current ? `${current.id}:${current.status}` : null;
        if (lastStatus.current && key !== lastStatus.current && current?.status !== "running") router.refresh();
        if (current?.status === "running") router.refresh();
        lastStatus.current = key;
      } catch {
        /* server restarting */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [router]);

  if (!task) return null;
  const secs = Math.round(((task.endedAt ? Date.parse(task.endedAt) : Date.now()) - Date.parse(task.startedAt)) / 1000);
  return (
    <div className={`taskbar t-${task.status}`} role="status">
      {task.status === "running" ? <span className="spinner" aria-hidden /> : null}
      <b>{task.status === "running" ? "Working" : task.status === "done" ? "Finished" : "Failed"}:</b> {task.label}
      <span className="muted"> · {secs}s</span>
      {task.error ? <div className="bad">{task.error}</div> : null}
      {task.status === "done" && task.result && typeof task.result === "object" ? (
        <div className="muted small">{summarize(task.result)}</div>
      ) : null}
    </div>
  );
}

function summarize(r: unknown): string {
  if (Array.isArray(r)) return `${r.filter((c: { ok?: boolean }) => c.ok).length}/${r.length} checks passed`;
  const o = r as { decision?: string; reasons?: string[]; pdf?: string; result?: { issues?: unknown[] } };
  if (o.decision) return `${o.decision}${o.reasons?.length ? ` — ${o.reasons.join("; ")}` : ""}`;
  if (o.pdf) return `Resume ready · ${o.result?.issues?.length ?? 0} claim(s) repaired`;
  const s = JSON.stringify(r);
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}
