import { appendFile, readFile } from "node:fs/promises";
import { readConfig } from "./config";
import { makeGitHub, pushBranch } from "./github";
import { runLoop } from "./loop";
import { renderReport } from "./report";
import { buildDeps, configureGitIdentity, prepareRepo } from "./wire";

interface IssueEvent {
  label?: { name: string };
  comment?: { body: string };
  issue: { number: number; pull_request?: unknown };
  sender: { login: string };
  repository: { default_branch: string };
}

const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function setOutputs(values: Record<string, string>) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  await appendFile(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function main() {
  const event = JSON.parse(await readFile(requireEnv("GITHUB_EVENT_PATH"), "utf8")) as IssueEvent;
  const triggered = event.label?.name === "agent:run" || event.comment?.body.trim().startsWith("/agent") === true;
  if (!triggered || event.issue.pull_request) {
    console.log("Event is not an agent trigger on an issue; skipping.");
    await setOutputs({ result: "skipped" });
    return;
  }

  const ownerRepo = requireEnv("GITHUB_REPOSITORY");
  const token = input("github_token");
  if (!token) throw new Error("Input github_token is required");
  const gh = makeGitHub(token, ownerRepo);
  if (!(await gh.canWrite(event.sender.login))) {
    console.log(`@${event.sender.login} does not have write access; skipping.`);
    await setOutputs({ result: "skipped" });
    return;
  }

  const cfg = readConfig(input);
  if (!cfg.anthropicApiKey && !cfg.claudeCodeOauthToken)
    throw new Error("Set one of the inputs anthropic_api_key or claude_code_oauth_token");
  if (cfg.anthropicApiKey && cfg.claudeCodeOauthToken)
    console.log("Both anthropic_api_key and claude_code_oauth_token are set; using anthropic_api_key.");
  const repo = requireEnv("GITHUB_WORKSPACE");
  const issueNumber = Number(input("issue_number")) || event.issue.number;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${ownerRepo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const issue = await gh.getIssue(issueNumber);
  await gh.comment(issueNumber, `🤖 Agent loop started. [Run log](${runUrl})`);

  const branch = `agent/issue-${issueNumber}`;
  await configureGitIdentity(repo);
  const base = await prepareRepo(repo, branch);
  const outcome = await runLoop(issue, cfg, await buildDeps(repo, base, issue, cfg, (m) => console.log(m)));
  const report = renderReport(outcome, runUrl);

  let prNumber = "";
  if (outcome.result === "needs-info") {
    await gh.comment(issueNumber, `${report}\nPlease add the missing details, then comment \`/agent\` to try again.`);
  } else if (!outcome.hasDiff) {
    await gh.comment(issueNumber, report);
  } else {
    await pushBranch(repo, token, ownerRepo, branch);
    const labels = [`agent:${outcome.result}`, ...(outcome.highRisk ? ["agent:high-risk"] : [])];
    const { number: n } = await gh.upsertPr({
      head: branch,
      base: event.repository.default_branch,
      title: `Agent: ${issue.title}`,
      body: `Closes #${issueNumber}\n\n${report}`,
      draft: outcome.result !== "passed" || outcome.highRisk,
      labels,
    });
    prNumber = String(n);
    await gh.comment(issueNumber, `🤖 Agent loop finished: **${outcome.result}**. See #${n}.`);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, report);
  await setOutputs({
    result: outcome.result,
    pr_number: prNumber,
    rounds: String(outcome.rounds.length),
    cost_usd: outcome.costUsd.toFixed(2),
  });
}

main().catch((err: unknown) => {
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
