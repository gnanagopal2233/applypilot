import cron from "node-cron";
import "./core/config";
import { logEvent } from "./core/db";
import { notify, runPipeline } from "./agents/pipeline";

/**
 * Long-running scheduler. Failures are loud: they're logged, sent to NOTIFY_WEBHOOK,
 * and visible on the dashboard — a run that silently produces 0 jobs is a bug.
 */
const schedule = process.env.CRON || "5 9 * * 1-5";
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const summary = await runPipeline();
    await notify(`✅ ApplyPilot: ${JSON.stringify(summary)}`);
  } catch (e) {
    const msg = (e as Error).message;
    logEvent("worker", "error", `run failed: ${msg}`);
    await notify(`❌ ApplyPilot run failed: ${msg}`);
  } finally {
    running = false;
  }
}

console.log(`ApplyPilot worker: schedule "${schedule}" (local time). Ctrl+C to stop.`);
cron.schedule(schedule, tick);
if (process.argv.includes("--now")) tick();
