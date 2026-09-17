export type Severity = "blocker" | "major" | "minor";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  title: string;
  detail: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
}

export interface Config {
  checks: string[];
  maxRounds: number;
  maxCostUsd: number;
  fixerModel: string;
  reviewerModel: string;
  jevModel: string;
  protectedPaths: string[];
  maxDiffLines: number;
  passThreshold: number;
  minConfidence: number;
  /** Reviewer uses the small model when the change is within both limits. */
  smallDiffFiles: number;
  smallDiffLines: number;
  /** Path (at the base commit) of a markdown rubric for the reviewer, or "". */
  reviewRubric: string;
  /** Path (at the base commit) of a review-shortlist.json file, or "". */
  reviewShortlist: string;
  /** Set this or `claudeCodeOauthToken`. Both empty means the local Claude login (local runs only). */
  anthropicApiKey: string;
  /** Claude subscription token from `claude setup-token`. Used only when `anthropicApiKey` is empty. */
  claudeCodeOauthToken: string;
  typesafeApiKey: string;
}

export interface AgentRun {
  ok: boolean;
  costUsd: number;
  error?: string;
}

export interface ReviewRun extends AgentRun {
  /** `null` when the reviewer did not return valid structured output. */
  findings: Finding[] | null;
  /** Model that ran the review; "" when the reviewer was skipped. */
  model: string;
}

export type GuardName = "protected_paths" | "deleted_tests" | "diff_size" | "empty_diff" | "shortlist";

export interface GuardResult {
  name: GuardName;
  ok: boolean;
  detail: string;
}

export interface ShortlistRule {
  id: string;
  name: string;
  /** hard = fail the round; judgement = pass to the reviewer to verify. */
  severity: "hard" | "judgement";
  /** Globs; empty means every file. */
  paths: string[];
  excludePaths: string[];
  /** POSIX ERE, matched against each added line. */
  grep: string;
  excludeGrep?: string;
  fix?: string;
}

export interface ShortlistHit {
  rule: ShortlistRule;
  file: string;
  line: number;
  text: string;
}

export interface GuardOutput {
  results: GuardResult[];
  diff: string;
  diffLines: number;
  filesChanged: number;
  /** Judgement-severity shortlist hits, for the reviewer to verify. */
  judgementHits: ShortlistHit[];
}

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface Rated<T extends string> {
  choice: T;
  confidence: number;
}

export interface Intake {
  clarity: Rated<"clear" | "needs_info">;
  kind: Rated<"bug" | "feature" | "refactor" | "unclear">;
  /** 0 = low, 1 = medium, 2 = high (expected value, may be fractional). */
  risk: { score: number; confidence: number };
}

export interface JevVerdict {
  addresses: Rated<"yes" | "partly" | "no"> & { yes: number };
  unrelated: Rated<"none" | "some">;
  /** 0 = none, 1 = weak, 2 = adequate, 3 = strong. */
  tests: { score: number; confidence: number };
  /** One probability per serious finding, in `seriousFindings()` order. NaN when missing. */
  findingProbs: number[];
}

/** The Jev answers asked before the reviewer runs. */
export type JevPrecheck = Omit<JevVerdict, "findingProbs">;

export type FindingStatus = "confirmed" | "uncertain" | "dismissed" | "minor";

export interface ClassifiedFinding {
  finding: Finding;
  status: FindingStatus;
  p: number | null;
}

export type Outcome = "pass" | "fail" | "escalate";

export interface Failure {
  rule: string;
  reason: string;
}

export interface Decision {
  outcome: Outcome;
  failures: Failure[];
  notes: string[];
  findings: ClassifiedFinding[];
}

export interface RoundRecord {
  round: number;
  fixer: AgentRun;
  guards: GuardOutput;
  checks: CheckResult[];
  review: ReviewRun | null;
  jev: JevVerdict | null;
  decision: Decision;
}

export type Result = "passed" | "escalated" | "failed" | "needs-info";

export interface LoopOutcome {
  result: Result;
  stopReason: string;
  intake: Intake;
  rounds: RoundRecord[];
  costUsd: number;
  highRisk: boolean;
  hasDiff: boolean;
}
