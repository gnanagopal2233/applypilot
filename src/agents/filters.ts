import type { JobPosting, Profile } from "../core/types";
import { containsTerm } from "../core/text";

/**
 * Deterministic hard filters. Cheap, explainable, and run BEFORE any LLM call
 * so we never pay tokens (or risk an application) on a job that can't work.
 */
export interface FilterResult {
  pass: boolean;
  reasons: string[];
}

const NO_SPONSOR = [
  /no (visa )?sponsorship/i,
  /(unable|not able|cannot|can't|will not|won't|do not|does not) (to )?(provide |offer )?(visa )?sponsor/i,
  /without (the )?(need for )?(current or future )?(visa )?sponsorship/i,
  /must be (a )?u\.?s\.? citizen/i,
  /u\.?s\.? citizenship (is )?required/i,
  /(active|current) (security )?clearance/i,
  /green card holders? only/i,
];

export function titleMatches(title: string, profile: Profile): { ok: boolean; reason?: string } {
  const t = title.toLowerCase();
  const bad = profile.preferences.excludeTitleKeywords.find((k) => containsTerm(t, k));
  if (bad) return { ok: false, reason: `title contains excluded keyword "${bad}"` };
  const good = profile.preferences.targetTitles.some((target) => {
    const words = target.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hit = words.filter((w) => t.includes(w)).length;
    return hit >= Math.max(1, Math.ceil(words.length * 0.6));
  });
  return good ? { ok: true } : { ok: false, reason: "title does not match any target title" };
}

export function parseCompCeilingUsd(text: string): number | undefined {
  const nums = [...text.matchAll(/\$?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])/g)].map((m) => {
    const raw = m[1].replace(/[,\s]/g, "");
    return /k$/i.test(raw) ? parseFloat(raw) * 1000 : parseInt(raw, 10);
  });
  const plausible = nums.filter((n) => n >= 30000 && n <= 2_000_000);
  return plausible.length ? Math.max(...plausible) : undefined;
}

export function maxYearsRequired(text: string): number | undefined {
  const ys = [...text.matchAll(/(\d{1,2})\+?\s*(?:-\s*\d{1,2}\s*)?years?(?:['’]s)?\s+(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|hands-on\s+)?(?:experience|exp\b)/gi)].map((m) =>
    parseInt(m[1], 10),
  );
  return ys.length ? Math.min(...ys) : undefined; // the stated minimum
}

export function applyHardFilters(job: JobPosting, profile: Profile): FilterResult {
  const reasons: string[] = [];
  const tm = titleMatches(job.title, profile);
  if (!tm.ok) reasons.push(tm.reason!);

  const prefs = profile.preferences;
  if (prefs.locations.length) {
    const loc = job.location.toLowerCase();
    const remote = /remote|anywhere|distributed/.test(loc) || /\bremote\b/i.test(job.title);
    const locOk = prefs.locations.some((l) => loc.includes(l.toLowerCase())) || (prefs.remoteOk && remote) || loc === "";
    if (!locOk) reasons.push(`location "${job.location}" not in preferences`);
  }

  if (prefs.skipIfNoSponsorship && profile.workAuth.needsSponsorshipFuture) {
    const hit = NO_SPONSOR.find((re) => re.test(job.description));
    if (hit) reasons.push(`posting excludes sponsorship (${hit.source})`);
  }

  if (prefs.minBaseUsd) {
    const ceiling = parseCompCeilingUsd(`${job.compText ?? ""}\n${job.description}`);
    if (ceiling && ceiling < prefs.minBaseUsd) reasons.push(`comp ceiling $${ceiling} < minimum $${prefs.minBaseUsd}`);
  }

  if (prefs.maxYearsRequired !== undefined) {
    const yrs = maxYearsRequired(job.description);
    if (yrs !== undefined && yrs > prefs.maxYearsRequired) reasons.push(`requires ${yrs}+ years (max ${prefs.maxYearsRequired})`);
  }

  if (job.postedAt && prefs.maxPostingAgeDays) {
    const age = (Date.now() - new Date(job.postedAt).getTime()) / 864e5;
    if (age > prefs.maxPostingAgeDays) reasons.push(`posting is ${Math.round(age)} days old`);
  }

  return { pass: reasons.length === 0, reasons };
}
