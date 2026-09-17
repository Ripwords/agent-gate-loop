import { makeFixer } from "./agents/fixer";
import { makeReviewer } from "./agents/reviewer";
import { runChecks } from "./checks";
import { runGuards } from "./guards";
import { makeJev } from "./jev";
import type { Deps } from "./loop";
import { git } from "./proc";
import { loadShortlist, readAtBase } from "./shortlist";
import type { Config, Issue } from "./types";

export async function configureGitIdentity(repo: string): Promise<void> {
  await git(repo, ["config", "user.name", "agent-gate-loop[bot]"]);
  await git(repo, ["config", "user.email", "agent-gate-loop@users.noreply.github.com"]);
}

/** Checks out the work branch and returns the base commit sha. */
export async function prepareRepo(repo: string, branch: string): Promise<string> {
  const dirty = await git(repo, ["status", "--porcelain"]);
  if (dirty.trim()) throw new Error(`Working tree at ${repo} is not clean.`);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["checkout", "-q", "-B", branch]);
  return base;
}

export async function buildDeps(repo: string, base: string, issue: Issue, cfg: Config, log: (message: string) => void): Promise<Deps> {
  const rules = await loadShortlist(repo, base, cfg.reviewShortlist);
  if (rules.length > 0) log(`Loaded ${rules.length} review shortlist rules from ${cfg.reviewShortlist}`);
  const rubric = cfg.reviewRubric ? await readAtBase(repo, base, cfg.reviewRubric) : "";
  if (rubric) log(`Loaded review rubric from ${cfg.reviewRubric}`);
  const jev = makeJev(cfg);
  return {
    intake: jev.intake,
    precheck: jev.precheck,
    verifyFindings: jev.verifyFindings,
    fix: makeFixer(repo, cfg),
    review: makeReviewer(repo, cfg, rubric),
    guards: () => runGuards(repo, base, cfg.protectedPaths, cfg.maxDiffLines, rules),
    checks: () => runChecks(repo, cfg.checks),
    commitRound: async (round) => {
      await git(repo, ["add", "-A"]);
      const staged = await git(repo, ["diff", "--cached", "--name-only"]);
      if (staged.trim()) await git(repo, ["commit", "-q", "--no-verify", "-m", `fix: agent round ${round} for #${issue.number}`]);
    },
    hasDiff: async () => (await git(repo, ["diff", "--name-only", base, "HEAD"])).trim().length > 0,
    log,
  };
}
