import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { scrubbedEnv } from "../proc";
import type { Config, Issue } from "../types";

/** Passes exactly one Claude credential; `scrubbedEnv()` has already removed any others. */
function claudeAuth(cfg: Pick<Config, "anthropicApiKey" | "claudeCodeOauthToken">): Record<string, string> {
  if (cfg.anthropicApiKey) return { ANTHROPIC_API_KEY: cfg.anthropicApiKey };
  if (cfg.claudeCodeOauthToken) return { CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeCodeOauthToken };
  return {};
}

export function agentEnv(cfg: Pick<Config, "anthropicApiKey" | "claudeCodeOauthToken">): Record<string, string> {
  return {
    ...scrubbedEnv(),
    ...claudeAuth(cfg),
    CLAUDE_AGENT_SDK_CLIENT_APP: "agent-gate-loop/0.1.0",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
  };
}

/** A session that threw. `started` is false when it failed before the model answered, so nothing was spent. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly started: boolean,
  ) {
    super(message);
  }
}

const MAX_ERROR_CHARS = 600;

/** Keeps the readable lines of CLI output: drops warnings, stack frames and minified source. */
export function cleanError(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("⚠") &&
        !line.startsWith("at ") &&
        !line.startsWith("::error") &&
        !line.includes("$bunfs") &&
        line.length <= 300,
    );
  const unique = [...new Set(lines)].join("\n");
  return unique.length > MAX_ERROR_CHARS ? `${unique.slice(0, MAX_ERROR_CHARS)}…` : unique;
}

/** Runs one headless session and returns its final result message. */
export async function runSession(prompt: string, options: Options): Promise<SDKResultMessage | null> {
  let result: SDKResultMessage | null = null;
  let started = false;
  const stderr: string[] = [];
  try {
    for await (const msg of query({ prompt, options: { ...options, stderr: (data) => stderr.push(data) } })) {
      if (msg.type === "assistant") started = true;
      if (msg.type === "result") result = msg;
    }
  } catch (err) {
    if (result) return result;
    const message = err instanceof Error ? err.message : String(err);
    throw new SessionError(cleanError(`${message}\n${stderr.join("")}`), started);
  }
  return result;
}

/** What a crashed session cost: nothing if it never started, otherwise its whole budget (the real spend is unknown). */
export function crashCost(err: unknown, budgetUsd: number): { costUsd: number; note: string } {
  if (err instanceof SessionError && !err.started) return { costUsd: 0, note: "" };
  return { costUsd: budgetUsd, note: ` (cost unknown; counted as $${budgetUsd.toFixed(2)})` };
}

export function sessionError(r: SDKResultMessage | null): string | undefined {
  if (!r) return "The agent returned no result.";
  if (r.subtype === "success") return r.is_error ? r.result : undefined;
  return `${r.subtype}: ${r.errors.join("; ")}`;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Removes every occurrence of the closing tag (case-insensitive) so untrusted text cannot break out of its wrapper. */
export function stripTag(text: string, tag: string): string {
  return text.replaceAll(new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi"), "");
}

export function issueBlock(issue: Issue): string {
  const clean = (s: string) => stripTag(s, "issue");
  return ["<issue>", `#${issue.number}: ${clean(issue.title)}`, "", clean(issue.body), "</issue>"].join("\n");
}
