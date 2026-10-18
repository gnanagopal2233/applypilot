import { logEvent } from "./db";

/**
 * Tiny in-process background task runner for the web app. One task at a time:
 * agents share a browser + SQLite, and serial runs keep traces readable.
 */
export interface Task {
  id: string;
  kind: string;
  label: string;
  status: "running" | "done" | "error";
  startedAt: string;
  endedAt?: string;
  result?: unknown;
  error?: string;
}

type State = { current: Task | null; history: Task[] };
const g = globalThis as unknown as { __applypilotTasks?: State };
const state: State = (g.__applypilotTasks ??= { current: null, history: [] });

export function taskState(): State {
  return state;
}

export function startTask(kind: string, label: string, fn: () => Promise<unknown>): { ok: true; task: Task } | { ok: false; reason: string } {
  if (state.current?.status === "running") return { ok: false, reason: `"${state.current.label}" is still running` };
  const task: Task = { id: `${Date.now()}`, kind, label, status: "running", startedAt: new Date().toISOString() };
  state.current = task;
  logEvent("web", "info", `started: ${label}`);
  fn()
    .then((result) => {
      task.status = "done";
      task.result = result;
    })
    .catch((e: unknown) => {
      task.status = "error";
      task.error = e instanceof Error ? e.message : String(e);
      logEvent("web", "error", `${label} failed: ${task.error}`);
    })
    .finally(() => {
      task.endedAt = new Date().toISOString();
      state.history.unshift(task);
      state.history = state.history.slice(0, 20);
    });
  return { ok: true, task };
}

export function lastTask(kind: string): Task | undefined {
  if (state.current?.kind === kind) return state.current;
  return state.history.find((t) => t.kind === kind);
}
