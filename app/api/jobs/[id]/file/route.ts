import fs from "node:fs";
import path from "node:path";
import { getJob } from "../../../../../src/core/db";
import { jobOutDir } from "../../../../../src/agents/pipeline";

const TYPES: Record<string, string> = { "cover-letter.pdf": "application/pdf", "form.png": "image/png", "after-submit.png": "image/png", "cover-letter.txt": "text/plain; charset=utf-8" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!getJob(id) || !TYPES[name]) return new Response("not found", { status: 404 });
  const file = path.join(jobOutDir(id), name);
  if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { "Content-Type": TYPES[name] } });
}
