import { describe, expect, it } from "vitest";
import { verifyDeterministic } from "../src/agents/verifier";
import type { TailoredResume } from "../src/core/types";
import { exampleWorkspace } from "./helpers";

const ws = exampleWorkspace();
const roleBase = (id: string) => {
  const r = ws.experience.roles.find((x) => x.id === id)!;
  return { roleId: r.id, company: r.company, title: r.title, location: r.location, start: r.start, end: r.end };
};
const resume = (bullet: { sourceId: string; text: string }, extra: Partial<TailoredResume> = {}): TailoredResume => ({
  headline: ws.profile.headline,
  summary: ws.experience.summaries[0],
  roles: [{ ...roleBase("acme"), bullets: [bullet] }, { ...roleBase("globex"), bullets: [{ sourceId: "globex.1", text: ws.experience.roles[1].bullets[0].text }] }],
  skills: ws.experience.skills,
  projects: [],
  education: [],
  certifications: [],
  coverLetter: "I build grounded LLM tools for customers.",
  ...extra,
});

describe("verifier (deterministic)", () => {
  it("accepts a faithful rephrase", () => {
    const r = verifyDeterministic(resume({ sourceId: "acme.1", text: "Shipped a RAG support assistant (TypeScript, PostgreSQL, pgvector) over 4,000 SOPs, reducing ticket resolution time 30%." }), ws);
    expect(r.issues).toEqual([]);
  });
  it("catches an inflated metric and reverts it", () => {
    const r = verifyDeterministic(resume({ sourceId: "acme.1", text: "Built a RAG assistant over 4,000 SOPs, cutting resolution time by 60%." }), ws);
    expect(r.issues[0].kind).toBe("new_number");
    expect(r.resume.roles[0].bullets[0].text).toBe(ws.experience.roles[0].bullets[0].text);
  });
  it("catches a fabricated tool", () => {
    const r = verifyDeterministic(resume({ sourceId: "acme.3", text: "Designed RBAC and audit logging on Kubernetes that passed SOC 2." }), ws);
    expect(r.issues.some((i) => i.kind === "new_skill" && i.detail.includes("Kubernetes"))).toBe(true);
  });
  it("drops bullets that cite unknown or foreign sources", () => {
    const r = verifyDeterministic(resume({ sourceId: "globex.2", text: "Automated CI/CD with GitHub Actions." }), ws);
    expect(r.issues[0].kind).toBe("unknown_source");
  });
  it("repairs a summary that invents numbers", () => {
    const r = verifyDeterministic(resume({ sourceId: "acme.2", text: ws.experience.roles[0].bullets[1].text }, { summary: "Engineer with 12 years of experience." }), ws);
    expect(r.issues.some((i) => i.where === "summary")).toBe(true);
    expect(r.resume.summary).toBe(ws.experience.summaries[0]);
  });
  it("restores tampered role identity", () => {
    const t = resume({ sourceId: "acme.1", text: ws.experience.roles[0].bullets[0].text });
    t.roles[0].title = "Senior Staff Engineer";
    const r = verifyDeterministic(t, ws);
    expect(r.resume.roles[0].title).toBe("Software Engineer");
  });
});
