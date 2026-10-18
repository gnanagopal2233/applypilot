import * as cheerio from "cheerio";
import type { AtsKind, JobPosting } from "../../core/types";
import { htmlToText } from "../../core/text";

/**
 * Discovery uses ONLY public, unauthenticated job-board APIs that the ATS vendors
 * publish for exactly this purpose. No login-walled scraping (LinkedIn, Indeed, ...).
 */

const UA = { "User-Agent": "ApplyPilot/0.1 (+https://github.com/; open-source job search assistant)" };

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { ...UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

/* ---------------- Greenhouse ---------------- */
interface GHJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  content?: string;
}
function fromGreenhouse(slug: string, company: string, j: GHJob): JobPosting {
  return {
    id: `greenhouse:${slug}:${j.id}`,
    ats: "greenhouse",
    company,
    title: j.title,
    location: j.location?.name ?? "",
    url: j.absolute_url,
    applyUrl: j.absolute_url,
    description: htmlToText(j.content ?? ""),
    postedAt: j.first_published ?? j.updated_at,
  };
}
export async function fetchGreenhouse(slug: string, company = slug): Promise<JobPosting[]> {
  const data = await getJSON<{ jobs: GHJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return data.jobs.map((j) => fromGreenhouse(slug, company, j));
}

/* ---------------- Lever ---------------- */
interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  createdAt?: number;
  categories?: { location?: string; commitment?: string; team?: string };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string };
  workplaceType?: string;
}
function fromLever(slug: string, company: string, j: LeverJob): JobPosting {
  const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n\n");
  const comp = j.salaryRange?.max ? `${j.salaryRange.currency ?? "USD"} ${j.salaryRange.min ?? ""}-${j.salaryRange.max}` : undefined;
  return {
    id: `lever:${slug}:${j.id}`,
    ats: "lever",
    company,
    title: j.text,
    location: [j.categories?.location, j.workplaceType].filter(Boolean).join(" · "),
    url: j.hostedUrl,
    applyUrl: j.applyUrl || `${j.hostedUrl}/apply`,
    description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n\n"),
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
    compText: comp,
  };
}
export async function fetchLever(slug: string, company = slug): Promise<JobPosting[]> {
  const data = await getJSON<LeverJob[]>(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return data.map((j) => fromLever(slug, company, j));
}

/* ---------------- Ashby ---------------- */
interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  jobUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedAt?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}
function fromAshby(slug: string, company: string, j: AshbyJob): JobPosting {
  return {
    id: `ashby:${slug}:${j.id}`,
    ats: "ashby",
    company,
    title: j.title,
    location: [j.location, j.isRemote ? "Remote" : ""].filter(Boolean).join(" · "),
    url: j.jobUrl,
    applyUrl: j.applyUrl || `${j.jobUrl}/application`,
    description: j.descriptionPlain || htmlToText(j.descriptionHtml ?? ""),
    postedAt: j.publishedAt,
    compText: j.compensation?.scrapeableCompensationSalarySummary || j.compensation?.compensationTierSummary,
  };
}
export async function fetchAshby(slug: string, company = slug): Promise<JobPosting[]> {
  const data = await getJSON<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return data.jobs.filter((j) => j.isListed !== false).map((j) => fromAshby(slug, company, j));
}

export async function fetchBoard(ats: Exclude<AtsKind, "other">, slug: string, company?: string) {
  if (ats === "greenhouse") return fetchGreenhouse(slug, company);
  if (ats === "lever") return fetchLever(slug, company);
  return fetchAshby(slug, company);
}

/* ---------------- Single URL ingestion ---------------- */

export function parseJobUrl(url: string): { ats: AtsKind; slug?: string; externalId?: string } {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  if (/greenhouse\.io$/.test(u.hostname)) {
    const gh = u.searchParams.get("gh_jid");
    const i = parts.indexOf("jobs");
    if (i > 0) return { ats: "greenhouse", slug: parts[i - 1], externalId: parts[i + 1] };
    if (gh && parts[0]) return { ats: "greenhouse", slug: parts[0], externalId: gh };
  }
  if (u.hostname === "jobs.lever.co" && parts.length >= 2) return { ats: "lever", slug: parts[0], externalId: parts[1] };
  if (u.hostname === "jobs.ashbyhq.com" && parts.length >= 2) return { ats: "ashby", slug: parts[0], externalId: parts[1] };
  return { ats: "other" };
}

export async function fetchJobByUrl(url: string): Promise<JobPosting> {
  const p = parseJobUrl(url);
  if (p.ats === "greenhouse" && p.slug && p.externalId) {
    const j = await getJSON<GHJob>(`https://boards-api.greenhouse.io/v1/boards/${p.slug}/jobs/${p.externalId}`);
    return fromGreenhouse(p.slug, p.slug, j);
  }
  if (p.ats === "lever" && p.slug && p.externalId) {
    const j = await getJSON<LeverJob>(`https://api.lever.co/v0/postings/${p.slug}/${p.externalId}?mode=json`);
    return fromLever(p.slug, p.slug, j);
  }
  if (p.ats === "ashby" && p.slug && p.externalId) {
    const all = await fetchAshby(p.slug);
    const hit = all.find((j) => j.id.endsWith(`:${p.externalId}`));
    if (hit) return hit;
  }
  // Unknown ATS: keep the text so we can score/tailor, but it is never auto-submitted.
  const res = await fetch(url, { headers: UA });
  const html = await res.text();
  const $ = cheerio.load(html);
  const title = $("h1").first().text().trim() || $("title").text().trim() || "Untitled role";
  return {
    id: `other:${new URL(url).hostname}:${Buffer.from(url).toString("base64url").slice(-24)}`,
    ats: "other",
    company: new URL(url).hostname.replace(/^www\./, "").split(".")[0],
    title,
    location: "",
    url,
    applyUrl: url,
    description: htmlToText($("main").html() || $("body").html() || ""),
  };
}
