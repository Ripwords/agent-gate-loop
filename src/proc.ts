export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export async function exec(cmd: string[], opts: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Runs git and returns stdout. The error names only the subcommand, so tokens in args never leak. */
export async function git(cwd: string, args: string[]): Promise<string> {
  // Never run the repo's hooks: they could be changed by the agent, and would run with our env.
  const r = await exec(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: scrubbedEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed (${r.exitCode}): ${r.stderr.trim()}`);
  return r.stdout;
}

const SECRET_NAME = /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** process.env without secret-looking variables or action inputs. */
export function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_NAME.test(key) || key.startsWith("INPUT_")) continue;
    out[key] = value;
  }
  return out;
}
