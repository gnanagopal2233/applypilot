import type { Workspace } from "../../core/config";
import type { FieldPlan } from "../../core/types";

export interface FieldDescriptor {
  apId: string; // our data-ap-id handle
  label: string;
  type: string; // text | email | tel | url | textarea | select | combobox | radio | checkbox | file | number | date
  required: boolean;
  options: string[];
  name?: string;
}

export type Resolved = FieldPlan & { apId: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Rule-based mapping of common ATS fields to profile values. */
export function standardValue(label: string, type: string, ws: Workspace, job: { company: string; title: string }, name?: string): { value: string; source: FieldPlan["source"] } | null {
  const l = norm(label);
  const id = ws.profile.identity;
  const current = ws.experience.roles[0];
  const rules: [RegExp, () => string | undefined, FieldPlan["source"]?][] = [
    [/^(legal )?first name|^given name/, () => id.firstName],
    [/^(legal )?last name|^surname|^family name/, () => id.lastName],
    [/preferred (first )?name/, () => id.preferredName ?? id.firstName],
    [/^(full )?name\b|^your name/, () => `${id.firstName} ${id.lastName}`],
    [/e-?mail/, () => id.email],
    [/phone|mobile/, () => id.phone],
    [/linkedin/, () => id.links.linkedin],
    [/github/, () => id.links.github],
    [/portfolio|personal (web)?site|^website/, () => id.links.portfolio ?? id.links.github],
    [/^(current )?location|^city|where are you (currently )?(based|located)/, () => [id.location.city, id.location.state].filter(Boolean).join(", ")],
    [/current (company|employer)|^company$|^organization$|^org$/, () => current.employer ?? current.company],
    [/current (job )?title|^title$/, () => current.title],
  ];
  if (type === "file") {
    const hay = `${l} ${(name ?? "").toLowerCase()}`; // Greenhouse labels file inputs "Attach"; the id says resume/cover_letter
    if (/resume|\bcv\b/.test(hay)) return { value: "@resume", source: "resume" };
    if (/cover/.test(hay)) return { value: "@cover_letter", source: "cover_letter" };
    return null;
  }
  if (/cover letter/.test(l) && type === "textarea") return { value: "@cover_letter_text", source: "cover_letter" };
  for (const [re, get] of rules) {
    if (re.test(l)) {
      const v = get();
      if (v) return { value: v, source: "profile" };
    }
  }
  const wa = ws.profile.workAuth;
  if (/(legally )?authori[sz]ed to work|eligible to work|right to work/.test(l)) return { value: wa.authorizedUS ? "Yes" : "No", source: "profile" };
  if (/sponsor/.test(l)) return { value: wa.needsSponsorshipNow || wa.needsSponsorshipFuture ? "Yes" : "No", source: "profile" };
  void job;
  return null;
}

export function answerBankValue(label: string, ws: Workspace): string | null {
  for (const a of ws.answers.answers) {
    if (a.match.some((m) => new RegExp(m, "i").test(label))) return a.answer;
  }
  return null;
}

export function isNeverAutoFill(label: string, ws: Workspace) {
  const l = norm(label);
  return ws.answers.neverAutoFill.some((k) => l.includes(k.toLowerCase()));
}

/** Choose the option that best matches an answer ("Yes" -> "Yes, I am authorized..."). */
export function pickOption(answer: string, options: string[]): string | null {
  if (!options.length) return null;
  const a = norm(answer);
  const opts = options.map((o) => ({ o, n: norm(o) }));
  return (
    opts.find((x) => x.n === a)?.o ??
    opts.find((x) => x.n.startsWith(a) || a.startsWith(x.n))?.o ??
    opts.find((x) => x.n.includes(a) || a.includes(x.n))?.o ??
    (/^(yes|y|true)$/.test(a) ? opts.find((x) => /^yes\b/.test(x.n))?.o : undefined) ??
    (/^(no|n|false)$/.test(a) ? opts.find((x) => /^no\b/.test(x.n))?.o : undefined) ??
    (/decline|prefer not/.test(a) ? opts.find((x) => /decline|prefer not|don.t wish|do not wish/.test(x.n))?.o : undefined) ??
    null
  );
}

/** Deterministic resolution; returns fields still needing the LLM separately. */
export function resolveDeterministic(fields: FieldDescriptor[], ws: Workspace, job: { company: string; title: string }) {
  const resolved: Resolved[] = [];
  const pending: FieldDescriptor[] = [];
  for (const f of fields) {
    const base = { apId: f.apId, label: f.label, required: f.required, type: f.type };
    if (isNeverAutoFill(f.label, ws)) {
      resolved.push({ ...base, source: "none", confidence: 0 });
      continue;
    }
    const std = standardValue(f.label, f.type, ws, job, f.name) ?? (() => {
      const a = answerBankValue(f.label, ws);
      return a ? { value: a, source: "answers" as const } : null;
    })();
    if (std) {
      if (f.type === "checkbox" && f.options.length <= 1) {
        const yes = /^(yes|true|agree|i agree)$/i.test(std.value);
        resolved.push({ ...base, value: yes ? "Yes" : "No", source: std.source, confidence: 1 });
      } else if (f.options.length && !std.value.startsWith("@")) {
        const pick = pickOption(std.value, f.options);
        resolved.push({ ...base, value: pick ?? std.value, source: std.source, confidence: pick ? 1 : 0.5 });
      } else {
        resolved.push({ ...base, value: std.value, source: std.source, confidence: f.type === "combobox" ? 0.9 : 1 });
      }
      continue;
    }
    pending.push(f);
  }
  return { resolved, pending };
}
