import { z } from "zod";

/* ---------------- Profile (profile/profile.yaml) ---------------- */

export const ProfileSchema = z.object({
  identity: z.object({
    firstName: z.string(),
    lastName: z.string(),
    preferredName: z.string().optional(),
    email: z.string(),
    phone: z.string(),
    location: z.object({ city: z.string(), state: z.string().optional(), country: z.string().default("United States") }),
    links: z
      .object({ linkedin: z.string().optional(), github: z.string().optional(), portfolio: z.string().optional() })
      .default({}),
  }),
  headline: z.string(),
  workAuth: z.object({
    authorizedUS: z.boolean(),
    needsSponsorshipNow: z.boolean(),
    needsSponsorshipFuture: z.boolean(),
  }),
  preferences: z.object({
    targetTitles: z.array(z.string()).min(1),
    excludeTitleKeywords: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
    remoteOk: z.boolean().default(true),
    minBaseUsd: z.number().optional(),
    maxYearsRequired: z.number().optional(),
    skipIfNoSponsorship: z.boolean().default(false),
    maxPostingAgeDays: z.number().default(30),
  }),
  style: z
    .object({
      // Words that must never appear in anything generated for an application (resume, cover letter, form answers).
      bannedTerms: z.array(z.string()).default([]),
    })
    .default({ bannedTerms: [] }),
  automation: z
    .object({
      autoSubmit: z.boolean().default(false),
      dryRun: z.boolean().default(true),
      minScoreToTailor: z.number().default(60),
      minScoreToAutoSubmit: z.number().default(80),
      dailyCap: z.number().default(25),
      perCompanyCap: z.number().default(2),
    })
    .default({ autoSubmit: false, dryRun: true, minScoreToTailor: 60, minScoreToAutoSubmit: 80, dailyCap: 25, perCompanyCap: 2 }),
});
export type Profile = z.infer<typeof ProfileSchema>;

/* ---------------- Experience bank (profile/experience.yaml) ---------------- */

export const BulletSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const RoleSchema = z.object({
  id: z.string(),
  company: z.string(), // what appears on the resume
  employer: z.string().optional(), // legal/W-2 employer, used for form fields like "current employer"
  title: z.string(),
  location: z.string().optional(),
  start: z.string(),
  end: z.string(),
  bullets: z.array(BulletSchema).min(1),
});

export const ExperienceSchema = z.object({
  summaries: z.array(z.string()).min(1),
  roles: z.array(RoleSchema).min(1),
  skills: z.record(z.string(), z.array(z.string())),
  projects: z
    .array(z.object({ id: z.string().optional(), name: z.string(), text: z.string(), skills: z.array(z.string()).default([]), link: z.string().optional() }))
    .default([]),
  education: z.array(z.object({ school: z.string(), degree: z.string(), location: z.string().optional(), dates: z.string().optional(), details: z.string().optional() })).default([]),
  certifications: z.array(z.string()).default([]),
});
export type Experience = z.infer<typeof ExperienceSchema>;
export type Role = z.infer<typeof RoleSchema>;

/* ---------------- Screening answers (profile/answers.yaml) ---------------- */

export const AnswersSchema = z.object({
  answers: z.array(
    z.object({
      match: z.array(z.string()).min(1), // case-insensitive regexes against the field label
      answer: z.string(),
      note: z.string().optional(),
    }),
  ),
  // Never answered automatically: the field is sent to the review queue.
  neverAutoFill: z.array(z.string()).default(["ssn", "social security", "passport", "a-number", "alien registration", "ead card", "citizenship", "date of birth", "visa expir"]),
});
export type Answers = z.infer<typeof AnswersSchema>;

/* ---------------- Targets (profile/targets.yaml) ---------------- */

export const AtsKind = z.enum(["greenhouse", "lever", "ashby", "other"]);
export type AtsKind = z.infer<typeof AtsKind>;

export const TargetsSchema = z.object({
  companies: z.array(z.object({ name: z.string(), ats: AtsKind.exclude(["other"]), slug: z.string() })),
});
export type Targets = z.infer<typeof TargetsSchema>;

/* ---------------- Jobs ---------------- */

export interface JobPosting {
  id: string; // `${ats}:${slug}:${externalId}`
  ats: AtsKind;
  company: string;
  title: string;
  location: string;
  url: string;
  applyUrl: string;
  description: string; // plain text
  postedAt?: string;
  compText?: string;
}

export type JobStatus =
  | "new"
  | "filtered"
  | "scored"
  | "tailored"
  | "review" // needs a human
  | "ready" // human-approved; next apply run submits
  | "submitted"
  | "failed"
  | "skipped";

/* ---------------- Agent outputs ---------------- */

export const ScoreLLMSchema = z.object({
  roleFit: z.number().min(0).max(10),
  skillsFit: z.number().min(0).max(10),
  seniorityFit: z.number().min(0).max(10),
  domainFit: z.number().min(0).max(10),
  mustHaveGaps: z.array(z.string()),
  strengths: z.array(z.string()),
  summary: z.string(),
});
export type ScoreLLM = z.infer<typeof ScoreLLMSchema>;

export interface ScoreResult {
  score: number; // 0-100
  keywordCoverage: number; // 0-1
  matchedSkills: string[];
  missingSkills: string[];
  llm?: ScoreLLM;
  notes: string[];
}

export const TailorLLMSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  roles: z.array(
    z.object({
      roleId: z.string(),
      bullets: z.array(z.object({ sourceId: z.string(), text: z.string() })),
    }),
  ),
  skillsPriority: z.array(z.string()),
  coverLetter: z.string(),
});
export type TailorLLM = z.infer<typeof TailorLLMSchema>;

export interface TailoredResume {
  headline: string;
  summary: string;
  roles: { roleId: string; company: string; title: string; location?: string; start: string; end: string; bullets: { sourceId: string; text: string }[] }[];
  skills: Record<string, string[]>;
  projects: Experience["projects"];
  education: Experience["education"];
  certifications: string[];
  coverLetter: string;
}

export interface VerifyIssue {
  where: string; // e.g. "summary" | "bullet:<sourceId>" | "coverLetter"
  kind: "unknown_source" | "new_number" | "new_skill" | "unsupported" | "altered_identity";
  detail: string;
  repaired: boolean;
}
export interface VerifyResult {
  pass: boolean;
  issues: VerifyIssue[];
  checkedClaims: number;
}

export type GateDecision = { decision: "auto_submit" | "review" | "skip"; reasons: string[] };

export interface FieldPlan {
  label: string;
  required: boolean;
  type: string;
  value?: string;
  source: "profile" | "answers" | "resume" | "cover_letter" | "llm" | "none";
  confidence: number;
}
