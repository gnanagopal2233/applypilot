import fs from "node:fs";
import path from "node:path";
import type { Profile, TailoredResume } from "../core/types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** ATS-safe, single-column resume HTML (real text, no tables/columns/icons). */
export function resumeHtml(r: TailoredResume, p: Profile): string {
  const id = p.identity;
  const contact = [
    [id.location.city, id.location.state].filter(Boolean).join(", "),
    id.email,
    id.phone,
    id.links.linkedin,
    id.links.github,
    id.links.portfolio,
  ]
    .filter(Boolean)
    .map((x) => esc(String(x)))
    .join(" &nbsp;|&nbsp; ");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(id.firstName)} ${esc(id.lastName)} — Resume</title>
<style>
  @page { size: Letter; margin: 0.45in 0.55in; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 10pt; color: #111; line-height: 1.32; margin: 0; }
  h1 { font-size: 18pt; margin: 0; letter-spacing: .5px; }
  .headline { font-weight: 600; margin: 2px 0 2px; }
  .contact { font-size: 9pt; color: #333; margin-bottom: 6px; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #999; margin: 10px 0 4px; padding-bottom: 1px; }
  .role { margin-top: 6px; }
  .role-head { display: flex; justify-content: space-between; font-weight: 600; }
  .role-sub { font-style: italic; color: #333; font-size: 9.5pt; }
  ul { margin: 2px 0 0 16px; padding: 0; }
  li { margin: 1px 0; }
  .skills div { margin: 1px 0; }
</style></head><body>
<h1>${esc(id.firstName)} ${esc(id.lastName)}</h1>
<div class="headline">${esc(r.headline)}</div>
<div class="contact">${contact}</div>
<h2>Summary</h2><div>${esc(r.summary)}</div>
<h2>Skills</h2><div class="skills">${Object.entries(r.skills)
    .map(([k, v]) => `<div><b>${esc(k)}:</b> ${v.map(esc).join(", ")}</div>`)
    .join("")}</div>
<h2>Experience</h2>${r.roles
    .map(
      (role) => `<div class="role"><div class="role-head"><span>${esc(role.title)} — ${esc(role.company)}</span><span>${esc(role.start)} – ${esc(role.end)}</span></div>
${role.location ? `<div class="role-sub">${esc(role.location)}</div>` : ""}<ul>${role.bullets.map((b) => `<li>${esc(b.text)}</li>`).join("")}</ul></div>`,
    )
    .join("")}
${r.projects.length ? `<h2>Projects</h2><ul>${r.projects.map((p) => `<li><b>${esc(p.name)}:</b> ${esc(p.text)}</li>`).join("")}</ul>` : ""}
${r.education.length ? `<h2>Education</h2>${r.education.map((e) => `<div><b>${esc(e.school)}</b> — ${esc(e.degree)}${e.dates ? ` (${esc(e.dates)})` : ""}${e.details ? ` · ${esc(e.details)}` : ""}</div>`).join("")}` : ""}
${r.certifications.length ? `<h2>Certifications</h2><div>${r.certifications.map(esc).join(" • ")}</div>` : ""}
</body></html>`;
}

export async function renderPdf(html: string, outFile: string): Promise<string> {
  const { chromium } = await import("playwright");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outFile, format: "Letter", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
  return outFile;
}
