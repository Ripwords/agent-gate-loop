import { Glob } from "bun";
import { z } from "zod";
import { exec, git } from "./proc";
import type { ShortlistHit, ShortlistRule } from "./types";

const RuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  severity: z.enum(["hard", "judgement"]),
  paths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  grep: z.string().min(1),
  excludeGrep: z.string().optional(),
  fix: z.string().optional(),
});
const ShortlistFile = z.object({ rules: z.array(RuleSchema) });

const POSIX_CLASSES: Record<string, string> = {
  "[:space:]": "\\s",
  "[:digit:]": "\\d",
  "[:alpha:]": "a-zA-Z",
  "[:alnum:]": "a-zA-Z0-9",
  "[:upper:]": "A-Z",
  "[:lower:]": "a-z",
  "[:punct:]": "!-\\/:-@\\[-`{-~",
};

/** Turns a grep -E pattern into a JS RegExp (POSIX classes only; the rest is compatible). */
export function ereToRegExp(pattern: string): RegExp {
  let source = pattern;
  for (const [cls, js] of Object.entries(POSIX_CLASSES)) source = source.replaceAll(cls, js);
  return new RegExp(source);
}

/** Reads a file as it was at the base commit, so the fixer cannot change it. */
export async function readAtBase(repo: string, base: string, path: string): Promise<string> {
  const r = await exec(["git", "show", `${base}:${path}`], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`Could not read ${path} at the base commit.`);
  return r.stdout;
}

export async function loadShortlist(repo: string, base: string, path: string): Promise<ShortlistRule[]> {
  if (!path) return [];
  const raw = await readAtBase(repo, base, path);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid review shortlist ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ShortlistFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid review shortlist ${path}: ${parsed.error.message}`);
  for (const rule of parsed.data.rules) {
    ereToRegExp(rule.grep);
    if (rule.excludeGrep) ereToRegExp(rule.excludeGrep);
  }
  return parsed.data.rules;
}

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** Parses `git diff -U0` output into the lines the change adds. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let line = 0;
  let inHeader = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHeader = true;
      file = "";
      continue;
    }
    if (inHeader && raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "";
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(raw);
    if (hunk) {
      inHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (!inHeader && file && raw.startsWith("+")) out.push({ file, line: line++, text: raw.slice(1) });
  }
  return out;
}

const matchesAny = (path: string, globs: string[]) => globs.some((g) => new Glob(g).match(path));

/** Runs every rule over the staged change's added lines. Call after `git add -A`. */
export async function scanShortlist(repo: string, base: string, rules: ShortlistRule[]): Promise<ShortlistHit[]> {
  if (rules.length === 0) return [];
  const lines = addedLines(await git(repo, ["diff", "--cached", "-U0", "--no-color", "--no-renames", "--diff-filter=d", base]));
  const hits: ShortlistHit[] = [];
  for (const rule of rules) {
    const grep = ereToRegExp(rule.grep);
    const exclude = rule.excludeGrep ? ereToRegExp(rule.excludeGrep) : null;
    for (const l of lines) {
      if (rule.paths.length > 0 && !matchesAny(l.file, rule.paths)) continue;
      if (matchesAny(l.file, rule.excludePaths)) continue;
      if (!grep.test(l.text) || exclude?.test(l.text)) continue;
      hits.push({ rule, file: l.file, line: l.line, text: l.text.trim() });
    }
  }
  return hits;
}
