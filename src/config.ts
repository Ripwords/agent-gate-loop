import type { Config } from "./types";

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function readConfig(get: (name: string) => string): Config {
  const num = (name: string, fallback: number) => {
    const raw = get(name);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Input ${name} must be a number, got "${raw}"`);
    return value;
  };

  const checks = lines(get("checks"));
  if (checks.length === 0) throw new Error("Input checks is required (one command per line)");
  const typesafeApiKey = get("typesafe_api_key");
  if (!typesafeApiKey) throw new Error("Input typesafe_api_key is required");

  return {
    checks,
    maxRounds: num("max_rounds", 2),
    maxCostUsd: num("max_cost_usd", 2),
    fixerModel: get("fixer_model") || "claude-sonnet-5",
    reviewerModel: get("reviewer_model") || "auto",
    jevModel: get("jev_model") || "jev-latest",
    protectedPaths: lines(get("protected_paths") || ".github/**\n.claude/**"),
    maxDiffLines: num("max_diff_lines", 800),
    passThreshold: num("pass_threshold", 0.8),
    minConfidence: num("min_confidence", 0.7),
    smallDiffFiles: num("small_diff_files", 8),
    smallDiffLines: num("small_diff_lines", 200),
    reviewRubric: get("review_rubric").trim(),
    reviewShortlist: get("review_shortlist").trim(),
    anthropicApiKey: get("anthropic_api_key"),
    claudeCodeOauthToken: get("claude_code_oauth_token"),
    typesafeApiKey,
  };
}
