import { buildFeedback, failureSignature } from "./feedback";
import { decide, precheckFailures } from "./gate";
import type {
  AgentRun,
  CheckResult,
  Config,
  Finding,
  GuardOutput,
  Intake,
  Issue,
  JevPrecheck,
  JevVerdict,
  LoopOutcome,
  Result,
  ReviewRun,
  RoundRecord,
} from "./types";

export interface Deps {
  intake(issue: Issue): Promise<Intake>;
  fix(issue: Issue, intake: Intake, feedback: string | null, budgetUsd: number): Promise<AgentRun>;
  guards(): Promise<GuardOutput>;
  checks(): Promise<CheckResult[]>;
  review(issue: Issue, change: GuardOutput, checks: CheckResult[], budgetUsd: number): Promise<ReviewRun>;
  precheck(issue: Issue, diff: string, checks: CheckResult[]): Promise<JevPrecheck>;
  verifyFindings(issue: Issue, diff: string, findings: Finding[]): Promise<number[]>;
  commitRound(round: number): Promise<void>;
  hasDiff(): Promise<boolean>;
  log(message: string): void;
}

export type LoopConfig = Pick<Config, "maxRounds" | "maxCostUsd" | "passThreshold" | "minConfidence">;

const HIGH_RISK = 1.5;

export async function runLoop(issue: Issue, cfg: LoopConfig, deps: Deps): Promise<LoopOutcome> {
  const intake = await deps.intake(issue);
  const highRisk = intake.risk.score >= HIGH_RISK;
  deps.log(`Intake: ${intake.clarity.choice}, ${intake.kind.choice}, risk ${intake.risk.score.toFixed(2)}`);

  const rounds: RoundRecord[] = [];
  let costUsd = 0;
  const remaining = () => cfg.maxCostUsd - costUsd;
  const finish = async (result: Result, stopReason: string): Promise<LoopOutcome> => ({
    result,
    stopReason,
    intake,
    rounds,
    costUsd,
    highRisk,
    hasDiff: await deps.hasDiff(),
  });

  const needsInfo = intake.clarity.choice === "needs_info" && intake.clarity.confidence >= cfg.minConfidence;
  if (intake.kind.choice === "unclear" || needsInfo) return finish("needs-info", "The issue is not specific enough to implement.");

  let feedback: string | null = null;
  for (let round = 1; round <= cfg.maxRounds; round++) {
    deps.log(`Round ${round}: fixer`);
    const fixer = await deps.fix(issue, intake, feedback, remaining());
    costUsd += fixer.costUsd;
    if (fixer.error) deps.log(`Round ${round}: fixer error: ${fixer.error}`);

    deps.log(`Round ${round}: guards and checks`);
    const guards = await deps.guards();
    const guardsOk = guards.results.every((g) => g.ok);
    const checks = guardsOk ? await deps.checks() : [];
    const checksOk = checks.every((c) => c.ok);

    const skippedForBudget = guardsOk && checksOk && remaining() <= 0;
    let review: ReviewRun | null = null;
    let jev: JevVerdict | null = null;
    let jevError: string | undefined;
    if (guardsOk && checksOk && remaining() > 0) {
      deps.log(`Round ${round}: Jev pre-check`);
      let pre: JevPrecheck | null = null;
      try {
        pre = await deps.precheck(issue, guards.diff, checks);
      } catch (err) {
        jevError = err instanceof Error ? err.message : String(err);
      }
      if (!pre) {
        review = { ok: false, costUsd: 0, error: `skipped: Jev pre-check failed: ${jevError}`, findings: null, model: "" };
      } else if (precheckFailures(pre, cfg.passThreshold, cfg.minConfidence).length > 0) {
        deps.log(`Round ${round}: Jev pre-check failed, reviewer skipped`);
        jev = { ...pre, findingProbs: [] };
      } else {
        deps.log(`Round ${round}: reviewer`);
        review = await deps.review(issue, guards, checks, remaining());
        costUsd += review.costUsd;
        jev = { ...pre, findingProbs: [] };
        if (review.findings) {
          deps.log(`Round ${round}: Jev finding check`);
          try {
            jev = { ...pre, findingProbs: await deps.verifyFindings(issue, guards.diff, review.findings) };
          } catch (err) {
            jevError = err instanceof Error ? err.message : String(err);
            jev = null;
          }
        }
      }
    } else if (skippedForBudget) {
      review = { ok: false, costUsd: 0, error: "skipped: agent budget used up", findings: null, model: "" };
    }

    const decision = decide({
      guards: guards.results,
      checks,
      review,
      jev,
      jevError,
      passThreshold: cfg.passThreshold,
      minConfidence: cfg.minConfidence,
    });
    const record: RoundRecord = { round, fixer, guards, checks, review, jev, decision };
    rounds.push(record);
    await deps.commitRound(round);
    deps.log(`Round ${round}: ${decision.outcome}`);

    if (decision.outcome === "pass") return finish("passed", `The gate passed in round ${round}.`);
    if (skippedForBudget || (decision.outcome === "fail" && remaining() <= 0)) return finish("failed", `Agent cost reached the $${cfg.maxCostUsd} limit.`);
    if (decision.outcome === "escalate") return finish("escalated", decision.notes.join(" "));
    if (round === cfg.maxRounds) return finish("failed", `The gate was still failing after ${round} rounds.`);
    const previous = rounds.at(-2);
    if (previous && failureSignature(previous) === failureSignature(record)) {
      return finish("failed", "The same problems came back twice in a row, so the loop stopped.");
    }
    if (remaining() <= 0) return finish("failed", `Agent cost reached the $${cfg.maxCostUsd} limit.`);
    feedback = buildFeedback(record);
  }
  return finish("failed", "No rounds ran.");
}
