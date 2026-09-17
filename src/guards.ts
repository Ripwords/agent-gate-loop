import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";
import { git } from "./proc";
import { scanShortlist } from "./shortlist";
import type { GuardOutput, GuardResult, ShortlistHit, ShortlistRule } from "./types";

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

export const isProtected = (path: string, globs: string[]) => globs.some((g) => new Glob(g).match(path));

interface Change {
  status: string;
  path: string;
}

function parseNameStatus(out: string): Change[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status ?? "", path: rest.join("\t") };
    });
}

/** Stages everything, reverts protected paths, and measures the diff against `base`. */
export async function runGuards(
  repo: string,
  base: string,
  protectedPaths: string[],
  maxDiffLines: number,
  rules: ShortlistRule[],
): Promise<GuardOutput> {
  await git(repo, ["add", "-A"]);
  const changes = parseNameStatus(await git(repo, ["diff", "--cached", "--name-status", "--no-renames", base]));

  const touched = changes.filter((c) => isProtected(c.path, protectedPaths));
  for (const c of touched) {
    if (c.status === "A") {
      await git(repo, ["rm", "--cached", "--quiet", "--", c.path]);
      await rm(join(repo, c.path), { force: true });
    } else {
      await git(repo, ["checkout", base, "--", c.path]);
    }
  }

  const changesWithRenames = parseNameStatus(await git(repo, ["diff", "--cached", "--name-status", "-M", base]));
  const deletedTests = changesWithRenames.filter((c) => c.status === "D" && TEST_FILE.test(c.path) && !isProtected(c.path, protectedPaths));
  const numstat = await git(repo, ["diff", "--cached", "--numstat", base]);
  const diffLines = numstat
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const [added, removed] = line.split("\t");
      return sum + (Number(added) || 0) + (Number(removed) || 0);
    }, 0);
  const diff = await git(repo, ["diff", "--cached", base]);
  const list = (cs: Change[]) => cs.map((c) => c.path).join(", ");
  const filesChanged = numstat.split("\n").filter(Boolean).length;
  const hits = await scanShortlist(repo, base, rules);
  const hardHits = hits.filter((h) => h.rule.severity === "hard");
  const judgementHits = hits.filter((h) => h.rule.severity === "judgement");

  const results: GuardResult[] = [
    {
      name: "protected_paths",
      ok: touched.length === 0,
      detail: touched.length
        ? `You edited protected files, which were reverted: ${list(touched)}. Do not change these paths.`
        : "No protected files touched.",
    },
    {
      name: "deleted_tests",
      ok: deletedTests.length === 0,
      detail: deletedTests.length
        ? `You deleted existing test files: ${list(deletedTests)}. Restore them and fix the code instead.`
        : "No tests deleted.",
    },
    {
      name: "diff_size",
      ok: diffLines <= maxDiffLines,
      detail:
        diffLines <= maxDiffLines
          ? `${diffLines} lines changed.`
          : `The change is ${diffLines} lines; the limit is ${maxDiffLines}. Make a smaller, focused change.`,
    },
    {
      name: "empty_diff",
      ok: diffLines > 0,
      detail: diffLines > 0 ? "Changes present." : "No code was changed. Implement the issue.",
    },
    {
      name: "shortlist",
      ok: hardHits.length === 0,
      detail: hardHits.length ? shortlistDetail(hardHits) : "No repo review rules broken.",
    },
  ];
  return { results, diff, diffLines, filesChanged, judgementHits };
}

const MAX_LISTED_HITS = 20;

function shortlistDetail(hits: ShortlistHit[]): string {
  const listed = hits.slice(0, MAX_LISTED_HITS).map((h) => {
    const fix = h.rule.fix ? ` Fix: ${h.rule.fix}` : "";
    return `- ${h.file}:${h.line} breaks "${h.rule.name}": \`${h.text}\`.${fix}`;
  });
  const more = hits.length > MAX_LISTED_HITS ? [`- …and ${hits.length - MAX_LISTED_HITS} more.`] : [];
  return ["Your change breaks this repo's review rules:", ...listed, ...more].join("\n");
}
