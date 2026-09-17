import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readConfig } from "./config";
import { runLoop } from "./loop";
import { renderReport } from "./report";
import type { Issue } from "./types";
import { buildDeps, configureGitIdentity, prepareRepo } from "./wire";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    "issue-file": { type: "string" },
    check: { type: "string", multiple: true },
    "max-rounds": { type: "string" },
    "max-cost-usd": { type: "string" },
    "review-rubric": { type: "string" },
    "review-shortlist": { type: "string" },
  },
});

if (!values.repo || !values["issue-file"] || !values.check?.length) {
  console.error(
    "Usage: bun src/local.ts --repo <dir> --issue-file <file.md> --check <cmd> [--check <cmd>] [--max-rounds N] [--max-cost-usd N] [--review-rubric <path>] [--review-shortlist <path>]",
  );
  process.exit(2);
}

const repo = realpathSync(resolve(values.repo));
const [firstLine = "", ...rest] = (await readFile(values["issue-file"], "utf8")).split("\n");
const issue: Issue = { number: 0, title: firstLine.replace(/^#\s*/, "").trim(), body: rest.join("\n").trim() };

const inputs: Record<string, string | undefined> = {
  checks: values.check.join("\n"),
  max_rounds: values["max-rounds"],
  max_cost_usd: values["max-cost-usd"],
  review_rubric: values["review-rubric"],
  review_shortlist: values["review-shortlist"],
  fixer_model: process.env.FIXER_MODEL,
  reviewer_model: process.env.REVIEWER_MODEL,
  anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  claude_code_oauth_token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  typesafe_api_key: process.env.TYPESAFE_API_KEY,
};
const cfg = readConfig((name) => inputs[name] ?? "");

await configureGitIdentity(repo);
const base = await prepareRepo(repo, "agent/local");
const started = Date.now();
const outcome = await runLoop(issue, cfg, await buildDeps(repo, base, issue, cfg, (m) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${m}`)));
const report = renderReport(outcome);
await writeFile(join(repo, ".git", "agent-report.md"), report);
console.log(`\n${report}`);
console.log(`Report saved to ${join(repo, ".git", "agent-report.md")}. Diff: git -C ${repo} diff ${base.slice(0, 8)} HEAD`);
process.exit(outcome.result === "passed" || outcome.result === "escalated" ? 0 : 1);
