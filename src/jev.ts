import { TypeSafeClient, choice, noul, score, type Question } from "@typesafe-ai/sdk";
import { seriousFindings } from "./gate";
import type { CheckResult, Config, Finding, Intake, Issue, JevPrecheck } from "./types";

export function makeJev(cfg: Config) {
  const client = new TypeSafeClient({ apiKey: cfg.typesafeApiKey, defaultModel: cfg.jevModel, timeout: 60_000 });

  async function intake(issue: Issue): Promise<Intake> {
    const { answers } = await client.systemOne({
      state: { issue: { title: issue.title, body: issue.body } },
      questions: {
        clarity: choice("Could a competent engineer implement this GitHub issue without asking follow-up questions?", {
          clear: "Yes: the expected behavior or change is clear enough to implement and test.",
          needs_info: "No: key details are missing or the request is ambiguous.",
        }),
        kind: choice("What kind of work does this GitHub issue ask for?", {
          bug: "Fix incorrect existing behavior.",
          feature: "Add new behavior.",
          refactor: "Restructure code without changing behavior.",
          unclear: "It is not possible to tell what is being asked.",
        }),
        risk: score("How risky is it to change code for this issue?", [
          "Low: isolated logic that is easy to verify.",
          "Medium: shared code or user-facing behavior.",
          "High: authentication, authorization, payments, data deletion, database migrations, or other security-sensitive code.",
        ]),
      },
    });
    return {
      clarity: { choice: answers.clarity.choice, confidence: answers.clarity.confidence },
      kind: { choice: answers.kind.choice, confidence: answers.kind.confidence },
      risk: { score: answers.risk.score, confidence: answers.risk.confidence },
    };
  }

  const addressesQ = choice("Does this diff implement what the GitHub issue asks for?", {
    yes: "Yes: every requirement in the issue is implemented.",
    partly: "Partly: some requirements are missing or half done.",
    no: "No: the diff does not implement the issue.",
  });
  const unrelatedQ = choice("Does this diff contain changes unrelated to the issue?", {
    none: "No: every change serves the issue. Tests and small necessary refactors count as related.",
    some: "Yes: it changes things the issue did not ask for.",
  });
  const testsQ = score("How well do the tests in this diff cover the changed behavior?", [
    "None: no tests added or updated for the changed behavior.",
    "Weak: tests exist but miss the main behavior.",
    "Adequate: tests cover the main behavior.",
    "Strong: tests cover the main behavior and important edge cases.",
  ]);

  async function precheck(issue: Issue, diff: string, checks: CheckResult[]): Promise<JevPrecheck> {
    const { answers } = await client.systemOne({
      state: {
        issue: { title: issue.title, body: issue.body },
        diff,
        checks_passed: checks.map((c) => c.command),
      },
      questions: { addresses: addressesQ, unrelated: unrelatedQ, tests: testsQ },
    });
    return {
      addresses: {
        choice: answers.addresses.choice,
        confidence: answers.addresses.confidence,
        yes: answers.addresses.probabilities.yes,
      },
      unrelated: { choice: answers.unrelated.choice, confidence: answers.unrelated.confidence },
      tests: { score: answers.tests.score, confidence: answers.tests.confidence },
    };
  }

  /** One probability per serious finding, in `seriousFindings()` order. NaN when missing. */
  async function verifyFindings(issue: Issue, diff: string, findings: Finding[]): Promise<number[]> {
    const serious = seriousFindings(findings);
    if (serious.length === 0) return [];
    const questions: Record<string, Question> = Object.fromEntries(
      serious.map((f, i) => [
        `finding_${i}`,
        noul({
          question: "Is this code review finding a real problem in the diff, not a false alarm and not already handled?",
          finding: { file: f.file, line: f.line, severity: f.severity, title: f.title, detail: f.detail },
        }),
      ]),
    );
    const { answers } = await client.systemOne({
      state: { issue: { title: issue.title, body: issue.body }, diff },
      questions,
    });
    return serious.map((_, i) => {
      const a = answers[`finding_${i}`];
      return a && a.type === "noul" ? a.noul : Number.NaN;
    });
  }

  return { intake, precheck, verifyFindings };
}
