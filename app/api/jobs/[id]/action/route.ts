import { NextResponse } from "next/server";
import { getJob, setStatus } from "../../../../../src/core/db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const form = await req.formData();
  const action = String(form.get("action"));
  if (action === "approve") setStatus(id, job.tailored_json ? "ready" : "scored", "approved in dashboard");
  else if (action === "skip") setStatus(id, "skipped", "skipped in dashboard");
  else if (action === "reset") setStatus(id, job.tailored_json ? "tailored" : "new", "re-queued in dashboard");
  else return NextResponse.json({ error: "unknown action" }, { status: 400 });
  return NextResponse.redirect(new URL(`/jobs/${encodeURIComponent(id)}`, req.url), 303);
}
