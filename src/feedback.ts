import type { RoundRecord } from "./types";

export const failureSignature = (r: RoundRecord) =>
  r.decision.failures
    .map((f) => f.rule)
    .sort()
    .join("\n");

export function buildFeedback(r: RoundRecord): string {
  const out = [`Problems found after round ${r.round}:`, ""];

  const guards = r.guards.results.filter((g) => !g.ok);
  if (guards.length > 0) {
    out.push("### Rule violations");
    for (const g of guards) out.push(`- ${g.detail}`);
    out.push("");
  }

  const failed = r.checks.find((c) => !c.ok);
  if (failed) {
    out.push("### Failing check", "", `Command: \`${failed.command}\` (exit ${failed.exitCode})`, "", "```", failed.output, "```", "");
  }

  const confirmed = r.decision.findings.filter((c) => c.status === "confirmed");
  if (confirmed.length > 0) {
    out.push("### Review findings to fix");
    for (const { finding: f } of confirmed) out.push(`- **${f.title}** (${f.file}:${f.line}, ${f.severity}): ${f.detail}`);
    out.push("");
  }

  const judge = r.decision.failures.filter((f) => f.rule.startsWith("jev:"));
  if (judge.length > 0) {
    out.push("### Independent judge");
    for (const f of judge) out.push(`- ${f.reason}`);
    out.push("");
  }

  return out.join("\n");
}
