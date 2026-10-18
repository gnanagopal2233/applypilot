import { describe, expect, it } from "vitest";
import { BM25 } from "../src/core/retrieval";
import { containsTerm, extractNumbers, htmlToText } from "../src/core/text";
import { applyHardFilters, maxYearsRequired, parseCompCeilingUsd } from "../src/agents/filters";
import { parseJobUrl } from "../src/agents/sources";
import { decide } from "../src/agents/gate";
import { pickOption, resolveDeterministic } from "../src/agents/applier/fieldmap";
import type { JobPosting, ScoreResult, VerifyResult } from "../src/core/types";
import { exampleWorkspace } from "./helpers";

const ws = exampleWorkspace();
const job = (over: Partial<JobPosting> = {}): JobPosting => ({
  id: "greenhouse:acme:1",
  ats: "greenhouse",
  company: "Acme",
  title: "Forward Deployed Engineer",
  location: "Remote - US",
  url: "https://job-boards.greenhouse.io/acme/jobs/1",
  applyUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
  description: "Build LLM apps with TypeScript and RAG for enterprise customers. 3+ years of experience.",
  ...over,
});

describe("text utils", () => {
  it("matches terms with symbols and word boundaries", () => {
    expect(containsTerm("We use Node.js and C++", "Node.js")).toBe(true);
    expect(containsTerm("We use C++", "C")).toBe(false);
    expect(containsTerm("PostgreSQL", "SQL")).toBe(false);
  });
  it("normalises numbers and ignores years", () => {
    expect(extractNumbers("Handled 1,000+ shipments, cut time ~40% in 2024, saved $30K")).toEqual(["1000", "40%", "30k"]);
  });
  it("unescapes greenhouse html", () => {
    expect(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;")).toContain("Hello & welcome");
  });
});

describe("BM25 retrieval", () => {
  it("ranks the relevant bullet first", () => {
    const bm = new BM25([
      { id: "a", text: "Built RAG assistant with pgvector" },
      { id: "b", text: "Migrated billing app to AWS ECS" },
    ]);
    expect(bm.search("retrieval augmented generation RAG pgvector")[0].id).toBe("a");
  });
});

describe("hard filters", () => {
  it("passes a matching job", () => expect(applyHardFilters(job(), ws.profile).pass).toBe(true));
  it("rejects excluded titles", () => expect(applyHardFilters(job({ title: "Staff Forward Deployed Engineer" }), ws.profile).pass).toBe(false));
  it("rejects over-experienced requirements", () => expect(applyHardFilters(job({ description: "10+ years of experience required" }), ws.profile).pass).toBe(false));
  it("rejects no-sponsorship postings when sponsorship is needed", () => {
    const p = structuredClone(ws.profile);
    p.workAuth.needsSponsorshipFuture = true;
    p.preferences.skipIfNoSponsorship = true;
    expect(applyHardFilters(job({ description: "We are unable to sponsor visas for this role." }), p).pass).toBe(false);
  });
  it("parses comp and years", () => {
    expect(parseCompCeilingUsd("$140,000 - $185,000")).toBe(185000);
    expect(parseCompCeilingUsd("150k–190k")).toBe(190000);
    expect(maxYearsRequired("5+ years of professional experience")).toBe(5);
  });
});

describe("url parsing", () => {
  it("recognises ATS urls", () => {
    expect(parseJobUrl("https://job-boards.greenhouse.io/anthropic/jobs/123")).toMatchObject({ ats: "greenhouse", slug: "anthropic", externalId: "123" });
    expect(parseJobUrl("https://jobs.lever.co/palantir/abc-def")).toMatchObject({ ats: "lever", slug: "palantir", externalId: "abc-def" });
    expect(parseJobUrl("https://jobs.ashbyhq.com/openai/xyz")).toMatchObject({ ats: "ashby", slug: "openai" });
    expect(parseJobUrl("https://careers.example.com/1").ats).toBe("other");
  });
});

describe("confidence gate", () => {
  const score: ScoreResult = { score: 90, keywordCoverage: 1, matchedSkills: [], missingSkills: [], notes: [] };
  const verify: VerifyResult = { pass: true, issues: [], checkedClaims: 8 };
  const auto = structuredClone(ws.profile);
  auto.automation.autoSubmit = true;
  const base = { job: job(), profile: auto, score, verify, submittedToday: 0, submittedToCompany30d: 0 };

  it("auto-submits only when everything is confident", () => {
    expect(decide({ ...base, fields: [{ label: "Email", required: true, type: "email", value: "x", source: "profile", confidence: 1 }] }).decision).toBe("auto_submit");
  });
  it("routes unknown required fields to review", () => {
    expect(decide({ ...base, fields: [{ label: "Visa expiry", required: true, type: "text", source: "none", confidence: 0 }] }).decision).toBe("review");
  });
  it("routes CAPTCHA to review", () => expect(decide({ ...base, captcha: true }).decision).toBe("review"));
  it("respects caps", () => {
    expect(decide({ ...base, submittedToday: 999 }).decision).toBe("review");
    expect(decide({ ...base, submittedToCompany30d: 5 }).decision).toBe("skip");
  });
  it("never auto-submits when autoSubmit is off", () => expect(decide({ ...base, profile: ws.profile }).decision).toBe("review"));
});

describe("form field mapping", () => {
  it("maps standard fields and saved answers", () => {
    const { resolved, pending } = resolveDeterministic(
      [
        { apId: "1", label: "First Name *", type: "text", required: true, options: [] },
        { apId: "2", label: "Resume/CV", type: "file", required: true, options: [] },
        { apId: "3", label: "Will you now or in the future require visa sponsorship?", type: "select", required: true, options: ["Yes", "No"] },
        { apId: "4", label: "How did you hear about us?", type: "text", required: false, options: [] },
        { apId: "5", label: "Social Security Number", type: "text", required: true, options: [] },
        { apId: "6", label: "Describe a hard technical problem you solved", type: "textarea", required: true, options: [] },
      ],
      ws,
      { company: "Acme", title: "FDE" },
    );
    const by = Object.fromEntries(resolved.map((r) => [r.apId, r]));
    expect(by["1"].value).toBe("Alex");
    expect(by["2"].value).toBe("@resume");
    expect(by["3"].value).toBe("No");
    expect(by["4"].source).toBe("answers");
    expect(by["5"].source).toBe("none");
    expect(pending.map((p) => p.apId)).toEqual(["6"]);
  });
  it("picks the best option", () => {
    expect(pickOption("Yes", ["Yes, I am authorized", "No"])).toBe("Yes, I am authorized");
    expect(pickOption("Decline to self-identify", ["Male", "Female", "I don't wish to answer"])).toBe("I don't wish to answer");
  });
});
