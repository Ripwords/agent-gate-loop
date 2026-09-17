import { exec, scrubbedEnv } from "./proc";
import type { CheckResult } from "./types";

const MAX_OUTPUT_CHARS = 4000;
const TIMEOUT_MS = 15 * 60_000;

/** Runs each command in order with secrets removed from env; stops at the first failure. */
export async function runChecks(repo: string, commands: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const r = await exec(["bash", "-c", `{\n${command}\n} 2>&1`], { cwd: repo, env: scrubbedEnv(), timeoutMs: TIMEOUT_MS });
    const output = r.stdout.length > MAX_OUTPUT_CHARS ? `…(truncated)\n${r.stdout.slice(-MAX_OUTPUT_CHARS)}` : r.stdout;
    results.push({ command, ok: r.exitCode === 0, exitCode: r.exitCode, output });
    if (r.exitCode !== 0) break;
  }
  return results;
}
