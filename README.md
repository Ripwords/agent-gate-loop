# agent-gate-loop

A GitHub Action that turns an issue into a pull request. An AI agent writes the change, and a gate
checks it before a human sees it. The gate has four parts:

1. **Guards.** No edits to protected paths, no deleted tests, a size limit, and at least one change.
2. **Your checks.** Your own typecheck, lint and test commands.
3. **Reviewer.** A separate, read-only Claude session that lists findings.
4. **Jev** ([TypeSafe](https://docs.typesafe.ai)). Checks each finding, and asks whether the change
   does what the issue asked, whether it touches unrelated code, and how good the tests are.

If the gate fails, the agent gets one merged feedback note and tries again, up to `max_rounds`.
If Jev is unsure, the loop stops and a human decides. The action never merges.

```
issue ─► Jev intake ─► fixer ─► guards ─► checks ─► reviewer ─► Jev gate ─► decide
                          ▲                                                  │
                          └──────────── feedback (on fail) ◄─────────────────┘
                                         pass / escalate / out of rounds ─► PR + report
```

## Use it

Copy [`examples/consumer.yml`](examples/consumer.yml) to `.github/workflows/agent.yml`, then add
the repository secret `TYPESAFE_API_KEY` plus either `ANTHROPIC_API_KEY` (pay-per-use) or
`CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription, from `claude setup-token`). These are the same
names Claude Code's GitHub setup uses. If both are set, the API key is used. To start a run, label an issue
`agent:run` or comment `/agent` on it. Only people with write access can trigger runs.

In the repo's **Settings → Actions → General**, turn on **Allow GitHub Actions to create and approve
pull requests**. Without it, the default token cannot open the PR.

> **Prototype.** Known gaps before unattended use: the agent can still change `.git/config` through
> its shell, and check commands can read the job's GitHub token and TypeSafe key from the parent
> process. Use it only on issues written by people you trust.

Checks run before each commit, and the agent commits every non-ignored file in the working tree.
Make sure build output and coverage folders are listed in `.gitignore`, or they will end up in the
diff and the PR.

For a different toolchain, call the action directly from your own job, after your setup steps:

```yaml
- uses: actions/checkout@v5
  with: { fetch-depth: 0, persist-credentials: false }
- uses: Ripwords/agent-gate-loop@main
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}          # or:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    typesafe_api_key: ${{ secrets.TYPESAFE_API_KEY }}
    checks: |
      go test ./...
```

See [`action.yml`](action.yml) for every input.

## Results

| Result | Meaning | PR |
|---|---|---|
| `passed` | Every gate passed | ready for review, unless the issue is high risk |
| `escalated` | Jev was unsure, or the reviewer failed | draft |
| `failed` | Out of rounds or budget, or the same problems repeated | draft |
| `needs-info` | The issue is too vague | none; the action comments on the issue |

## Cost controls

The loop is built to spend as little as possible:

- **Cheap gates first.** Guards, your checks, and a single Jev pre-check call run before any AI reviewer. If Jev is confident the change misses the issue, adds unrelated edits, or has no tests, the reviewer is skipped.
- **Right-sized models.** The fixer uses `claude-sonnet-5`. The reviewer (`reviewer_model: auto`) uses `claude-haiku-4-5` for small changes (≤ `small_diff_files` files and ≤ `small_diff_lines` lines) and `claude-sonnet-5` otherwise.
- **Hard caps.** `max_rounds` (default 2) and `max_cost_usd` (default 2) stop the loop. The remaining budget is passed to each agent session as its spend limit. `max_cost_usd` counts Claude spend only; TypeSafe (Jev) calls are billed separately and are not included.
- **The fixer keeps its context** between rounds instead of re-reading the repo.
- **Your repo's rules, for free.** `review_shortlist` points at a JSON file of grep rules run on the added lines: `hard` rules fail the round with the rule's fix text, `judgement` rules go to the reviewer as things to check. `review_rubric` points at a markdown rubric that the reviewer follows. Both are read from the base commit.

```yaml
    with:
      review_shortlist: .claude/review-shortlist.json
      review_rubric: docs/evals/review-pr/rubric.md
```

## Security notes

- Use a spend-limited Anthropic key. The agent's shell runs in the same process that holds the credential. A subscription token cannot be spend-limited, and a leak exposes your whole Claude plan.
- The agent never receives the TypeSafe key or the GitHub token. Check commands receive no
  secret-looking environment variables.
- A PR opened with the default `GITHUB_TOKEN` does not trigger your other workflows. To run CI on
  agent PRs, pass `AGENT_GITHUB_TOKEN`.
- On private repos without draft PR support, non-passing runs open a normal PR marked by the
  `agent:*` label instead of a draft.

## Run locally

```bash
ni
cp .env.example .env.local
nr e2e                         # runs the loop on examples/sample-repo
nr local --repo ../some-repo --issue-file issue.md --check "bun test"
# optional: --review-shortlist .claude/review-shortlist.json --review-rubric docs/rubric.md
```

Fill in `TYPESAFE_API_KEY`, plus `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (or neither, to use your local Claude Code login). Bun loads `.env.local` and `.env`; both are gitignored.

The issue file's first line is the title (`# Title`). The rest is the body.
