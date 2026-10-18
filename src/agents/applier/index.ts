import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Workspace } from "../../core/config";
import { BM25 } from "../../core/retrieval";
import type { LLM } from "../../core/llm";
import { bannedIn, extractNumbers } from "../../core/text";
import type { JobPosting } from "../../core/types";
import { allBankText } from "../verifier";
import { pickOption, resolveDeterministic, type FieldDescriptor, type Resolved } from "./fieldmap";

export interface ApplyOptions {
  submit: boolean; // false = fill and stop before submitting
  headless: boolean;
  resumePdf: string;
  coverLetterPdf?: string;
  coverLetterText: string;
  outDir: string;
  llm: LLM | null;
  holdForHumanMs?: number; // headed review mode: keep the browser open for the human to submit
}

export interface ApplyResult {
  fields: Resolved[];
  captcha: boolean;
  submitted: boolean;
  confirmation?: string;
  screenshot?: string;
  error?: string;
}

/** Where the actual application form lives for each ATS. */
export function formUrl(job: JobPosting): string {
  const [, slug, ext] = job.id.split(":");
  if (job.ats === "greenhouse") return `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${ext}`;
  if (job.ats === "lever") return job.applyUrl.endsWith("/apply") ? job.applyUrl : `${job.url.replace(/\/$/, "")}/apply`;
  if (job.ats === "ashby") return job.applyUrl.includes("/application") ? job.applyUrl : `${job.url.replace(/\/$/, "")}/application`;
  return job.applyUrl;
}

/* Runs inside the page: enumerate fillable fields and tag them with data-ap-id. */
const COLLECT_FIELDS = `(() => {
  const out = [];
  let n = 0;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 0 || r.height > 0 || el.type === 'file') && s.visibility !== 'hidden'; };
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(' ').map(id => document.getElementById(id)?.innerText || '').join(' ').trim(); if (t) return t; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    const wrap = el.closest('label'); if (wrap) return wrap.innerText;
    const fs = el.closest('fieldset'); if (fs && fs.querySelector('legend')) return fs.querySelector('legend').innerText;
    const box = el.closest('.field, .application-question, .form-group, [class*="question"], [class*="Field"], li, div');
    const l2 = box && box.querySelector('label, .label, [class*="label"], .application-label');
    return (l2 && l2.innerText) || el.placeholder || el.name || '';
  };
  const seenGroups = new Set();
  const rawLabelOverride = new Map();
  document.querySelectorAll('input, textarea, select').forEach((el) => {
    const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('role') === 'combobox' ? 'combobox' : (el.type || 'text'));
    if (['hidden', 'submit', 'button', 'search', 'image', 'reset'].includes(type)) return;
    if (!vis(el) && type !== 'file') return;
    // Skip helper inputs that custom dropdown widgets (react-select etc.) render without a label.
    const rawLabel = labelOf(el).trim();
    const rect = el.getBoundingClientRect();
    if (type !== 'file' && el.tabIndex < 0 && (rect.width <= 4 || rect.height <= 4 || getComputedStyle(el).opacity === '0')) return;
    if (!rawLabel && (el.tabIndex < 0 || el.getAttribute('aria-hidden') === 'true' || /requiredInput|dummy|hidden/i.test(el.className) || el.getBoundingClientRect().width <= 4)) return;
    if (!rawLabel && !el.id && !el.name) return;
    const required = el.required || el.getAttribute('aria-required') === 'true' || /\\*\\s*$/.test(labelOf(el).trim());
    if (type === 'radio' || type === 'checkbox') {
      const group = el.name || el.id;
      const members = el.name ? [...document.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')] : [el];
      if (members.length > 1) {
        if (seenGroups.has(group)) return; seenGroups.add(group);
        const fs = el.closest('fieldset');
        const q = (fs && fs.querySelector('legend')?.innerText) || el.closest('[class*="question"], .field, .form-group')?.querySelector('label, legend, [class*="label"]')?.innerText || group;
        const id = 'ap' + (n++);
        members.forEach((m, i) => m.setAttribute('data-ap-id', id + '_' + i));
        out.push({ apId: id, label: q.trim(), type, required: members.some(m => m.required) || /\\*\\s*$/.test(q.trim()), options: members.map(m => labelOf(m).trim()), name: el.name });
        return;
      }
    }
    const id = 'ap' + (n++);
    el.setAttribute('data-ap-id', id);
    if (type === 'file' && /^(attach|upload|choose file)?$/i.test(rawLabel)) rawLabelOverride.set(el, ((el.id || el.name || 'file').replace(/[_-]+/g, ' ')));
    const options = type === 'select' ? [...el.options].map(o => o.text.trim()).filter(t => t && !/^select|^--|^please/i.test(t)) : (type === 'checkbox' ? [labelOf(el).trim()] : []);
    out.push({ apId: id, label: (rawLabelOverride.get(el) || labelOf(el)).trim().replace(/\\s+/g, ' ').replace(/\\s*\\*\\s*$/, '').slice(0, 300), type, required, options, name: [el.id, el.name].filter(Boolean).join(' ') || undefined });
  });
  return out;
})()`;

const LlmFieldSchema = z.object({
  answers: z.array(z.object({ apId: z.string(), answer: z.string().nullable(), confidence: z.number().min(0).max(1) })),
});

async function resolveWithLlm(pending: FieldDescriptor[], job: JobPosting, ws: Workspace, llm: LLM | null): Promise<Resolved[]> {
  if (!pending.length) return [];
  const blank = (f: FieldDescriptor): Resolved => ({ apId: f.apId, label: f.label, required: f.required, type: f.type, source: "none", confidence: 0 });
  if (!llm) return pending.map(blank);
  const bm = new BM25(ws.answers.answers.map((a, i) => ({ id: String(i), text: `${a.match.join(" ")} ${a.note ?? ""} ${a.answer}` })));
  const facts = [
    `Name: ${ws.profile.identity.firstName} ${ws.profile.identity.lastName}; Location: ${ws.profile.identity.location.city}`,
    `Work authorization: authorized=${ws.profile.workAuth.authorizedUS}, sponsorship now=${ws.profile.workAuth.needsSponsorshipNow}, future=${ws.profile.workAuth.needsSponsorshipFuture}`,
    `Summary: ${ws.experience.summaries[0]}`,
    ...ws.experience.roles.map((r) => `${r.title} @ ${r.company} ${r.start}-${r.end}: ${r.bullets.map((b) => b.text).join(" ")}`),
    `Education: ${ws.experience.education.map((e) => `${e.degree}, ${e.school} (${e.dates ?? ""})`).join("; ")}`,
    `Skills: ${Object.values(ws.experience.skills).flat().join(", ")}`,
  ].join("\n");
  const out = await llm.json({
    name: "form_answers",
    schema: LlmFieldSchema,
    maxTokens: 3000,
    system: `You fill job application forms for a candidate using ONLY the facts provided. Rules:
- If the facts do not determine the answer (personal/legal questions, salary not given, dates not given, anything you'd have to guess), return answer=null.
- For fields with options, the answer MUST be one of the options verbatim.
- Free-text motivation questions ("Why X?"): 2-4 sentences grounded in the facts and the job; no invented numbers or tools; confidence <= 0.85.
- confidence = your probability the answer is correct AND appropriate to submit without human review.${
      ws.profile.style.bannedTerms.length ? `\n- NEVER use these words: ${ws.profile.style.bannedTerms.join(", ")}.` : ""
    }`,
    prompt: `<job>${job.title} at ${job.company}\n${job.description.slice(0, 4000)}</job>\n<facts>\n${facts}\n</facts>\n<fields>\n${pending
      .map((f) => {
        const hints = bm.search(f.label, 2).map((h) => ws.answers.answers[Number(h.id)].answer);
        return JSON.stringify({ apId: f.apId, label: f.label, type: f.type, required: f.required, options: f.options, relatedSavedAnswers: hints });
      })
      .join("\n")}\n</fields>`,
  });
  const bankNums = new Set(extractNumbers(allBankText(ws)));
  return pending.map((f) => {
    const a = out.answers.find((x) => x.apId === f.apId);
    if (!a || a.answer === null) return blank(f);
    let value = a.answer;
    let confidence = a.confidence;
    if (f.options.length) {
      const pick = pickOption(value, f.options);
      if (!pick) return blank(f);
      value = pick;
    }
    if (extractNumbers(value).some((n) => !bankNums.has(n))) confidence = Math.min(confidence, 0.5); // invented number
    if (bannedIn(value, ws.profile.style.bannedTerms).length) confidence = Math.min(confidence, 0.4); // style rule
    return { apId: f.apId, label: f.label, required: f.required, type: f.type, value, source: "llm", confidence };
  });
}

/**
 * A CAPTCHA the user would have to solve (visible checkbox widget or challenge frame).
 * Invisible, score-based badges are not challenges. We never try to solve or evade one:
 * if a challenge is visible the application goes to the human review queue.
 */
async function visibleChallenge(page: import("playwright").Page): Promise<boolean> {
  return page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]')] as HTMLIFrameElement[];
    return frames.some((f) => {
      const r = f.getBoundingClientRect();
      const s = getComputedStyle(f);
      const invisibleBadge = /size=invisible/.test(f.src) || !!f.closest(".grecaptcha-badge");
      return !invisibleBadge && r.width > 50 && r.height > 50 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    });
  });
}

/** Inspect the form, plan every field, fill it, and (only if allowed) submit. */
export async function runApplication(job: JobPosting, ws: Workspace, opts: ApplyOptions, allowSubmit: (fields: Resolved[], captcha: boolean) => boolean): Promise<ApplyResult> {
  const { chromium } = await import("playwright");
  fs.mkdirSync(opts.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: opts.headless, executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  const shot = path.join(opts.outDir, "form.png");
  try {
    await page.goto(formUrl(job), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector("input, textarea, select", { timeout: 20_000 });
    await page.waitForTimeout(1500); // SPAs (Ashby) render fields progressively

    const descriptors = (await page.evaluate(COLLECT_FIELDS)) as FieldDescriptor[];
    const { resolved, pending } = resolveDeterministic(descriptors, ws, job);
    const fields = [...resolved, ...(await resolveWithLlm(pending, job, ws, opts.llm))];

    for (const f of fields) {
      if (!f.value || f.confidence < 0.5) continue;
      const loc = page.locator(`[data-ap-id="${f.apId}"]`);
      try {
        if (f.type === "file") {
          const file = f.value === "@resume" ? opts.resumePdf : f.value === "@cover_letter" ? opts.coverLetterPdf : undefined;
          if (file) await loc.setInputFiles(file);
        } else if (f.type === "select") {
          await loc.selectOption({ label: f.value });
        } else if (f.type === "combobox") {
          await loc.click();
          await loc.fill(f.value);
          await page.waitForTimeout(400);
          await page.keyboard.press("Enter");
        } else if (f.type === "radio" || f.type === "checkbox") {
          const desc = descriptors.find((d) => d.apId === f.apId)!;
          if (desc.options.length > 1) {
            const idx = desc.options.indexOf(f.value);
            if (idx >= 0) await page.locator(`[data-ap-id="${f.apId}_${idx}"]`).check({ force: true });
          } else if (/^(yes|true|i agree|agree|checked)$/i.test(f.value) || f.value === desc.options[0]) {
            await loc.check({ force: true });
          }
        } else {
          const v = f.value === "@cover_letter_text" ? opts.coverLetterText : f.value;
          await loc.fill(v);
        }
      } catch (e) {
        f.confidence = 0;
        f.source = "none";
        f.value = `fill failed: ${(e as Error).message.split("\n")[0]}`;
      }
    }

    const captcha = await visibleChallenge(page);
    await page.screenshot({ path: shot, fullPage: true });

    if (opts.submit && allowSubmit(fields, captcha)) {
      const btn = page.getByRole("button", { name: /submit application|submit|apply/i }).last();
      await btn.click();
      const confirmation = await page
        .getByText(/thank you|application (has been )?(received|submitted)|we('|’)ve received|successfully submitted/i)
        .first()
        .textContent({ timeout: 25_000 })
        .catch(() => null);
      await page.screenshot({ path: path.join(opts.outDir, "after-submit.png"), fullPage: true });
      const challenged = !confirmation && (await visibleChallenge(page));
      return {
        fields,
        captcha: captcha || challenged,
        submitted: !!confirmation,
        confirmation: confirmation ?? undefined,
        screenshot: shot,
        error: confirmation ? undefined : challenged ? "site asked for a CAPTCHA after submit — finish it yourself (apply in browser)" : "no confirmation detected after submit",
      };
    }

    if (!opts.headless && opts.holdForHumanMs) {
      // Review mode: the human checks the filled form and clicks Submit themselves.
      const confirmation = await page
        .getByText(/thank you|application (has been )?(received|submitted)|we('|’)ve received/i)
        .first()
        .textContent({ timeout: opts.holdForHumanMs })
        .catch(() => null);
      return { fields, captcha, submitted: !!confirmation, confirmation: confirmation ?? undefined, screenshot: shot };
    }
    return { fields, captcha, submitted: false, screenshot: shot };
  } catch (e) {
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { fields: [], captcha: false, submitted: false, screenshot: shot, error: (e as Error).message };
  } finally {
    await browser.close();
  }
}
