import type { FieldPlan, GateDecision, JobPosting, Profile, ScoreResult, VerifyResult } from "../core/types";

export interface GateInput {
  job: JobPosting;
  profile: Profile;
  score: ScoreResult;
  verify: VerifyResult;
  submittedToday: number;
  submittedToCompany30d: number;
  humanApproved?: boolean;
  fields?: FieldPlan[]; // present once the form has been inspected
  captcha?: boolean;
}

/**
 * Confidence gate. Auto-submit happens ONLY when every condition holds; anything
 * uncertain goes to the human review queue. This is the single place that decides.
 */
export function decide(i: GateInput): GateDecision {
  const a = i.profile.automation;
  const reasons: string[] = [];
  const review = (r: string) => reasons.push(r);

  if (i.score.score < a.minScoreToTailor) return { decision: "skip", reasons: [`score ${i.score.score} < ${a.minScoreToTailor}`] };
  if (i.submittedToCompany30d >= a.perCompanyCap) return { decision: "skip", reasons: [`already applied ${i.submittedToCompany30d}x to ${i.job.company} in 30 days`] };

  if (i.submittedToday >= a.dailyCap) review(`daily cap ${a.dailyCap} reached`);
  if (i.humanApproved) {
    // Human approval overrides confidence checks, but never hard blockers.
  } else {
    if (!a.autoSubmit) review("autoSubmit is off in profile.yaml");
    if (i.score.score < a.minScoreToAutoSubmit) review(`score ${i.score.score} < auto threshold ${a.minScoreToAutoSubmit}`);
    if (!i.verify.pass) review("verifier found unrepaired claims");
    const repairs = i.verify.issues.filter((x) => x.repaired).length;
    if (repairs > 2) review(`${repairs} claims had to be repaired — worth a human look`);
    if (i.job.ats === "other") review("unsupported ATS — manual apply");
    const lowConf = (i.fields ?? []).filter((f) => f.required && (f.source === "none" || f.confidence < 0.8));
    if (lowConf.length) review(`required fields not confidently answered: ${lowConf.map((f) => f.label).slice(0, 5).join("; ")}`);
  }
  if (i.captcha) review("CAPTCHA present — needs a human");

  return reasons.length ? { decision: "review", reasons } : { decision: "auto_submit", reasons: ["all confidence checks passed"] };
}
