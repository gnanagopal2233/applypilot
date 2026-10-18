import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadWorkspace } from "../core/config";
import { getJob, jobEvents, listJobs, rowToPosting, setStatus, statusCounts, updateJob } from "../core/db";
import { getLLM } from "../core/llm";
import { addJobByUrl, applyJob, filterAndScore, scout, tailorJob } from "../agents/pipeline";
import { scoreJob } from "../agents/scorer";

/**
 * MCP server: lets Claude (Desktop, Code, Cowork) drive ApplyPilot conversationally —
 * "find FDE roles posted this week, tailor the top 3, show me what needs review".
 * stdout is the protocol channel, so agent logs are silenced.
 */
process.env.APPLYPILOT_QUIET = "1";

const server = new McpServer({ name: "applypilot", version: "0.1.0" });
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

const JobStatusEnum = z.enum(["new", "filtered", "scored", "tailored", "review", "ready", "submitted", "failed", "skipped"]);

server.registerTool("pipeline_status", { description: "Counts of jobs by pipeline status." }, async () => text(statusCounts()));

server.registerTool(
  "list_jobs",
  {
    description: "List jobs, best score first.",
    inputSchema: { status: z.array(JobStatusEnum).optional(), minScore: z.number().optional(), limit: z.number().default(20) },
  },
  async ({ status, minScore, limit }) =>
    text(
      listJobs({ status, minScore, limit }).map((r) => ({ id: r.id, company: r.company, title: r.title, location: r.location, score: r.score, status: r.status, reason: r.status_reason, url: r.url })),
    ),
);

server.registerTool("get_job", { description: "Full detail for one job: JD, score breakdown, tailored resume, verifier report, form plan, trace.", inputSchema: { id: z.string() } }, async ({ id }) => {
  const r = getJob(id);
  if (!r) return text(`No job ${id}`);
  const parse = (s: string | null) => (s ? JSON.parse(s) : null);
  return text({ ...rowToPosting(r), status: r.status, reason: r.status_reason, score: parse(r.score_json), tailored: parse(r.tailored_json), verify: parse(r.verify_json), gate: parse(r.gate_json), apply: parse(r.apply_json), trace: jobEvents(id).slice(-30) });
});

server.registerTool("scout_jobs", { description: "Pull fresh postings from all target boards, then filter and score them." }, async () => {
  const s = await scout();
  const f = await filterAndScore(loadWorkspace(), getLLM());
  return text({ ...s, ...f });
});

server.registerTool("add_job_url", { description: "Add and score a single job posting by URL.", inputSchema: { url: z.string().url() } }, async ({ url }) => {
  const job = await addJobByUrl(url);
  const s = await scoreJob(job, loadWorkspace(), getLLM());
  updateJob(job.id, { score: s.score, score_json: JSON.stringify(s), status: "scored" });
  return text({ id: job.id, score: s.score, summary: s.llm?.summary, gaps: s.llm?.mustHaveGaps });
});

server.registerTool("tailor_job", { description: "Tailor + verify the resume and cover letter for a job; renders PDFs.", inputSchema: { id: z.string() } }, async ({ id }) => {
  const r = await tailorJob(id, loadWorkspace(), getLLM());
  return text({ pdf: r.pdf, repairedClaims: r.result.issues, headline: r.resume.headline, summary: r.resume.summary });
});

server.registerTool("approve_job", { description: "Human approval: mark a reviewed job ready to submit.", inputSchema: { id: z.string() } }, async ({ id }) => {
  setStatus(id, "ready", "approved via MCP");
  return text(`approved ${id}`);
});

server.registerTool("skip_job", { description: "Skip a job.", inputSchema: { id: z.string(), reason: z.string().optional() } }, async ({ id, reason }) => {
  setStatus(id, "skipped", reason ?? "skipped via MCP");
  return text(`skipped ${id}`);
});

server.registerTool("apply_job", { description: "Run the confidence gate and apply to a tailored job (submits only if the gate passes or it was approved).", inputSchema: { id: z.string() } }, async ({ id }) =>
  text(await applyJob(id, loadWorkspace(), getLLM())),
);

await server.connect(new StdioServerTransport());
