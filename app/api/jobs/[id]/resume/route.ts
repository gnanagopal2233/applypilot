import fs from "node:fs";
import path from "node:path";
import { getJob } from "../../../../../src/core/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = getJob(decodeURIComponent((await params).id));
  if (!job?.pdf_path || !fs.existsSync(job.pdf_path)) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(job.pdf_path)), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${path.basename(job.pdf_path)}"` },
  });
}
