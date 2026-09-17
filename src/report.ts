import type { LoopOutcome, Result, RoundRecord } from "./types";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

const RESULT_LINE: Record<Result, string> = {
  passed: "✅ Gate passed. Ready for human review.",
  escalated: "🟡 Escalated. The gate could not decide, so a human should judge.",
  failed: "❌ Gate failed. The agent could not satisfy the gate.",
  "needs-info": "❓ The issue needs more detail before the agent can work on it.",
};

export function renderReport(o: LoopOutcome, runUrl?: string): string {
  const lines = [
    "## Agent gate report",
    "",
    `**Result:** ${RESULT_LINE[o.result]}`,
    `**Why it stopped:** ${o.stopReason}`,
    `**Rounds:** ${o.rounds.length} · **Agent cost:** ${usd(o.costUsd)}${runUrl ? ` · [run log](${runUrl})` : ""}`,
    "",
  ];
  if (o.highRisk) lines.push("> ⚠️ Jev rated this issue high risk, so this PR stays a draft.", "");
  lines.push(
    "### Intake",
    "",
    `- Clarity: ${o.intake.clarity.choice} (${pct(o.intake.clarity.confidence)} confidence)`,
    `- Kind: ${o.intake.kind.choice} (${pct(o.intake.kind.confidence)} confidence)`,
    `- Risk: ${o.intake.risk.score.toFixed(2)} of 2 (${pct(o.intake.risk.confidence)} confidence)`,
    "",
  );
  for (const r of o.rounds) lines.push(...renderRound(r));
  return lines.join("\n");
}

function renderRound(r: RoundRecord): string[] {
  const d = r.decision;
  const out = [`### Round ${r.round}: ${d.outcome}`, "", "| Stage | Result |", "|---|---|"];
  out.push(`| Fixer | ${r.fixer.ok ? "done" : cell(`error: ${r.fixer.error ?? "unknown"}`)} (${usd(r.fixer.costUsd)}) |`);
  out.push(`| Guards | ${r.guards.results.map((g) => `${g.ok ? "✅" : "❌"} ${g.name}`).join(", ")} (${r.guards.diffLines} lines changed) |`);
  if (r.guards.judgementHits.length > 0) out.push(`| Shortlist candidates | ${r.guards.judgementHits.length} sent to the reviewer |`);
  out.push(`| Checks | ${r.checks.map((c) => `${c.ok ? "✅" : "❌"} \`${cell(c.command)}\``).join(", ") || "not run"} |`);
  if (r.review) {
    const summary = r.review.findings ? `${r.review.findings.length} findings` : cell(r.review.error ?? "invalid output");
    const model = r.review.model ? ` · ${r.review.model}` : "";
    out.push(`| Reviewer | ${summary} (${usd(r.review.costUsd)}${model}) |`);
  } else if (r.jev && d.failures.some((f) => f.rule.startsWith("jev:"))) {
    out.push("| Reviewer | skipped: the Jev pre-check failed |");
  }
  if (r.jev) {
    const j = r.jev;
    out.push(`| Jev: implements issue | ${j.addresses.choice} (P(yes) ${pct(j.addresses.yes)}, ${pct(j.addresses.confidence)} confidence) |`);
    out.push(`| Jev: unrelated changes | ${j.unrelated.choice} (${pct(j.unrelated.confidence)} confidence) |`);
    out.push(`| Jev: tests | ${j.tests.score.toFixed(2)} of 3 (${pct(j.tests.confidence)} confidence) |`);
  }
  out.push("");
  if (d.findings.length > 0) {
    out.push("| Finding | Severity | Jev P(real) | Status |", "|---|---|---|---|");
    for (const c of d.findings)
      out.push(`| ${cell(c.finding.title)} (\`${cell(c.finding.file)}:${c.finding.line}\`) | ${c.finding.severity} | ${c.p === null ? "–" : pct(c.p)} | ${c.status} |`);
    out.push("");
  }
  for (const f of d.failures) out.push(`- ❌ ${f.reason}`);
  for (const n of d.notes) out.push(`- ${n}`);
  out.push("");
  return out;
}
