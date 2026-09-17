import type {
  CheckResult,
  ClassifiedFinding,
  Decision,
  Failure,
  Finding,
  FindingStatus,
  GuardResult,
  JevPrecheck,
  JevVerdict,
  ReviewRun,
} from "./types";

export const seriousFindings = (findings: Finding[]) => findings.filter((f) => f.severity !== "minor");

export function classify(p: number): FindingStatus {
  if (p >= 0.5) return "confirmed";
  if (p >= 0.35) return "uncertain";
  return "dismissed";
}

export interface GateInput {
  guards: GuardResult[];
  checks: CheckResult[];
  review: ReviewRun | null;
  jev: JevVerdict | null;
  jevError?: string;
  passThreshold: number;
  minConfidence: number;
}

/** Failures from the Jev pre-check; only confident answers count. */
export function precheckFailures(jev: JevPrecheck, passThreshold: number, minConfidence: number): Failure[] {
  const failures: Failure[] = [];
  const sure = (x: { confidence: number }) => x.confidence >= minConfidence;
  if (sure(jev.addresses) && (jev.addresses.choice === "no" || jev.addresses.yes < passThreshold))
    failures.push({ rule: "jev:addresses", reason: "An independent judge found the change does not fully implement the issue." });
  if (sure(jev.unrelated) && jev.unrelated.choice === "some")
    failures.push({ rule: "jev:unrelated", reason: "An independent judge found changes unrelated to the issue." });
  if (sure(jev.tests) && jev.tests.score < 1)
    failures.push({ rule: "jev:tests", reason: "An independent judge found no meaningful tests for the changed behavior." });
  return failures;
}

export function decide(input: GateInput): Decision {
  const failures: Failure[] = [];
  for (const g of input.guards) if (!g.ok) failures.push({ rule: `guard:${g.name}`, reason: g.detail });
  for (const c of input.checks)
    if (!c.ok) failures.push({ rule: `check:${c.command}`, reason: `\`${c.command}\` exited with ${c.exitCode}.` });
  if (failures.length > 0) return { outcome: "fail", failures, notes: [], findings: [] };

  if (input.jev) {
    const pre = precheckFailures(input.jev, input.passThreshold, input.minConfidence);
    if (pre.length > 0) return { outcome: "fail", failures: pre, notes: [], findings: [] };
  }

  const review = input.review;
  if (!review?.findings) {
    const why = review?.error ? `: ${review.error}` : "";
    return { outcome: "escalate", failures, notes: [`The reviewer did not return valid findings${why}.`], findings: [] };
  }

  const jev = input.jev;
  if (!jev) {
    const findings: ClassifiedFinding[] = review.findings.map((f) => ({
      finding: f,
      status: f.severity === "minor" ? "minor" : "uncertain",
      p: null,
    }));
    const why = input.jevError ? `: ${input.jevError}` : "";
    return { outcome: "escalate", failures, notes: [`The Jev gate was unavailable${why}.`], findings };
  }

  const serious = seriousFindings(review.findings);
  const findings: ClassifiedFinding[] = review.findings.map((f) => {
    if (f.severity === "minor") return { finding: f, status: "minor", p: null };
    const p = jev.findingProbs[serious.indexOf(f)];
    if (p === undefined || !Number.isFinite(p)) return { finding: f, status: "uncertain", p: null };
    return { finding: f, status: classify(p), p };
  });

  for (const c of findings)
    if (c.status === "confirmed")
      failures.push({ rule: `finding:${c.finding.title}`, reason: `Confirmed review finding: ${c.finding.title}` });

  const C = input.minConfidence;
  const sure = (x: { confidence: number }) => x.confidence >= C;
  if (failures.length > 0) return { outcome: "fail", failures, notes: [], findings };

  const notes: string[] = [];
  if (!sure(jev.addresses)) notes.push("Jev is unsure whether the issue is fully implemented.");
  if (!sure(jev.unrelated)) notes.push("Jev is unsure whether there are unrelated changes.");
  if (!sure(jev.tests)) notes.push("Jev is unsure about test quality.");
  for (const c of findings)
    if (c.status === "uncertain" && c.finding.severity === "blocker")
      notes.push(`Unclear whether this blocker is real: ${c.finding.title}`);
  if (notes.length > 0) return { outcome: "escalate", failures, notes, findings };

  return { outcome: "pass", failures, notes: ["All gates passed."], findings };
}
