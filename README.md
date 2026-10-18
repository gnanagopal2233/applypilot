# ApplyPilot

**An open-source, multi-agent job application pilot that doesn't make things up.**

ApplyPilot finds roles on public company job boards, scores how well each one fits, tailors your resume and cover letter from a bank of your *real* experience (RAG), verifies every claim against its source, and applies on its own **only when every confidence check passes**. Everything else goes to a review queue.

Built with TypeScript, Next.js, Playwright, SQLite and any LLM (Claude, OpenAI, or local via Ollama). It also ships an **MCP server**, so you can run your job search from Claude by chatting with it.

```
 targets.yaml ──► Scout ──► Hard filters ──► Scorer ──► Tailor (RAG) ──► Verifier ──► Gate ──┬─► Applier ──► submitted
 (public ATS                (sponsorship,    (LLM rubric  (retrieve real   (no new #s,   (score,   │  (Playwright,
  APIs)                      comp, years,     + keyword    bullets, rewrite  tools, or     caps,     │   ATS adapters,
                             title, age)      coverage)    with citations)  claims)       fields)   └─► review queue ──► you
```

## Why it's different

Most auto-apply bots optimise for volume. They scrape LinkedIn, fill forms with whatever the LLM says, and submit hundreds a day. That leads to banned accounts, made-up skills on resumes, and recruiters who learn to ignore you. ApplyPilot is built the other way round.

| Problem with auto-apply bots | What ApplyPilot does |
|---|---|
| The LLM invents metrics, tools and responsibilities | **Every bullet cites a source bullet id.** A deterministic verifier rejects new numbers or tools, and an LLM entailment check rejects inflated claims like "contributed" becoming "led". Anything that fails is reverted to your original wording. |
| Scraping LinkedIn or Indeed gets accounts banned | Discovery uses only the **public job-board APIs** from Greenhouse, Lever and Ashby. No logins, and no scraping behind a login. |
| Bots answer screening questions by guessing | Answers come from your profile, then your saved `answers.yaml`, then an LLM that can only use your facts. If none of those can answer, **the job goes to review**. Sensitive fields such as SSN, passport or date of birth are never auto-filled. |
| CAPTCHAs get bypassed | A CAPTCHA is detected and the job is **sent to a human**. ApplyPilot never solves or evades it. |
| Runs fail silently for weeks | `doctor` checks the setup, every run is traced, and failures post to a webhook. |
| Spam volume | Daily cap, cap per company per 30 days, and a score threshold to auto-submit. |

## Quick start

```bash
git clone https://github.com/<you>/applypilot && cd applypilot
npm install
npx playwright install chromium
npm run cli init          # copies examples/profile/* -> profile/ (gitignored) and .env
# edit profile/*.yaml and add your API key to .env
npm run doctor            # validates profile, key, browser, and every job board
npm run pipeline          # scout -> score -> tailor -> verify -> gate -> apply
npm run dev               # dashboard at http://localhost:3000
```

Start with `automation.dryRun: true`. It fills forms and stops, so you can look at the screenshots and form plans in the dashboard. Once you trust it, set `autoSubmit: true` and `dryRun: false`.

## Your profile (gitignored)

| File | What goes in it |
|---|---|
| `profile/profile.yaml` | Identity, work authorization, target titles, filters, automation thresholds |
| `profile/experience.yaml` | Your **experience bank**: every true bullet, tagged with skills. Write more than fits on one resume, because retrieval picks the right ones for each job. |
| `profile/answers.yaml` | Saved screening answers (regex → answer) and fields that must never be auto-filled |
| `profile/targets.yaml` | Company boards to scout (`greenhouse`/`lever`/`ashby` + slug) |

## Commands

| Command | What it does |
|---|---|
| `npm run pipeline` | Full run |
| `npm run worker` | Scheduled runs (`CRON` in `.env`, default weekdays at 9:05) |
| `npm run cli add <url>` | Add and score one posting |
| `npm run cli tailor <id>` | Tailored resume and cover letter PDFs plus a verifier report |
| `npm run cli apply <id> --headed` | Opens a real browser, fills the form, and **you** click Submit |
| `npm run cli approve <id>` | Approve a job from the review queue; the next run submits it |
| `npm run cli list` / `status` | Queue and counts |
| `npm test` | Unit tests (filters, retrieval, gate, field mapping, verifier) |
| `npm run eval [-- --llm]` | Hallucination eval for the verifier |

## Use it from Claude (MCP)

Add this to your MCP client config (Claude Desktop, Claude Code, Cowork):

```json
{
  "mcpServers": {
    "applypilot": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"], "cwd": "/path/to/applypilot" }
  }
}
```

Tools: `pipeline_status`, `list_jobs`, `get_job`, `scout_jobs`, `add_job_url`, `tailor_job`, `approve_job`, `skip_job`, `apply_job`.

You can then ask something like: *"Scout new roles, show me forward-deployed jobs scoring over 80, and tailor the top three."*

## Architecture

| Layer | Implementation |
|---|---|
| Agents | `src/agents/*`: scout, filters, scorer, tailor, verifier, gate, applier, pipeline orchestration |
| LLM | `src/core/llm.ts`: one `LLM.json({schema})` interface with Zod-validated structured output (Anthropic tool use, or OpenAI-compatible JSON mode) and a retry on validation failure |
| Retrieval | `src/core/retrieval.ts`: BM25 plus optional dense embeddings, fused with Reciprocal Rank Fusion, with an embedding cache in SQLite |
| Storage and tracing | `src/core/db.ts`: SQLite (jobs, per-agent event trace, embeddings) |
| Applier | `src/agents/applier/*`: Playwright. It enumerates fields by accessible label, resolves them in the order rules → saved answers → grounded LLM, fills the form, detects CAPTCHAs, and confirms submission |
| UI | `app/*`: Next.js dashboard with the queue, score breakdown, verifier issues, form plan with confidence for each field, resume preview, and trace |
| Interfaces | CLI (`src/cli.ts`), worker (`src/worker.ts`), MCP server (`src/mcp/server.ts`) |

**Eval results (deterministic layer, `npm run eval`):** 6 of 7 fabrications caught, and 0 of 5 faithful rewrites reverted. The one it misses is scope inflation, which the LLM entailment layer exists to catch.

## Responsible use

- Only apply to jobs you'd take, and keep the caps low.
- You are responsible for everything submitted in your name. Review the dashboard often.
- Respect each site's terms. ApplyPilot avoids login-walled boards and CAPTCHAs on purpose. Please keep it that way in forks.

## License

MIT
