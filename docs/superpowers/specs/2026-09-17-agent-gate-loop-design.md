# agent-gate-loop — design

Date: 2026-09-17
Status: draft for review
Rigor: prototype (no unit tests, no commits unless asked; verified by running end to end)

## Goal

A reusable GitHub Action that takes a GitHub issue (bug or feature), runs an
agentic fix loop until a quality gate passes, and hands the result to a human
as a pull request. The gate combines deterministic checks, an agentic
reviewer, and TypeSafe's Jev model. The action never merges.

## Core principle

Code owns every decision. Agents do narrow jobs (write code, list findings,
answer typed questions). The loop, the stop rules, and the pass/fail decision
are plain TypeScript. No agent grades itself or sees the thresholds.

## Trigger

- `issues: labeled` with label `agent:run`
- `issue_comment: created` whose body starts with `/agent`
- Only actors with `write` or `admin` permission on the repo (GitHub's
  collaborator permission API reports `maintain` as `write`). The workflow
  `if:` filters event shape; `main.ts` does the permission check through the
  API, not `author_association`, and exits quietly when it fails.
- `concurrency: agent-<issue number>`, `cancel-in-progress: false`.
- Comments on pull requests are ignored in this version.

## Flow

```
0. Intake (Jev)
   - choice clarity: clear | needs_info
   - choice kind:    bug | feature | refactor | unclear
   - score  risk:    [low, medium, high] (high = touches auth, payments, data deletion, migrations)
   If clarity = needs_info with confidence >= min_confidence, or kind = unclear:
     comment a clarifying request on the issue, result = needs-info, stop.
   risk.score >= 1.5 does not stop the run; it forces the final PR to stay a
   draft with label `agent:high-risk`.

Round N (1..max_rounds)
1. Fixer      Claude Agent SDK session in the checkout. Input: issue title/body,
              intake kind, feedback note from round N-1 (if any). Tools: Read,
              Edit, Write, Bash, Glob, Grep. Told to add or update tests.
2. Guards     Plain code over `git diff` against the base commit:
              - any change under protected_paths -> revert those files, record failure
              - existing test files deleted -> failure
              - diff larger than max_diff_lines -> failure
3. Checks     Run each line of `checks` with bash in the repo root, in order,
              stop at first failure. API keys and GitHub tokens are removed
              from the child env. Output is tail-truncated to 4 000 chars.
4. Reviewer   Fresh Claude Agent SDK session, tools Read, Glob, Grep only.
              Input: issue, the diff, check results. Not the fixer transcript.
              Output via `outputFormat` JSON schema: { findings: [{ file, line,
              severity: blocker|major|minor, title, detail }] }. Missing or
              invalid structured output counts as a reviewer error and escalates.
5. Jev gate   One systemOne call, all questions in parallel, state = issue + diff
              + check summary + findings:
              - choice addresses: yes | partly | no   ("does the diff implement the issue?")
              - choice unrelated: none | some          ("changes unrelated to the issue?")
              - score  tests:     [none, weak, adequate, strong]
              - noul   finding_<i>: "Is this finding a real problem in this diff?"
                                    (one per blocker/major finding)
6. Decide     Pure function decide(input) -> pass | fail | escalate, with reasons.
```

Note on the TypeSafe SDK (v0.6.0): `choice` and `score` answers carry
`confidence`; `noul` answers carry only the probability `noul`. That is why the
gate uses choices where a confidence check matters, and nouls only for
per-finding verification.

### Decision rules (`gate.ts`)

Let `C` = `min_confidence`, `T` = `pass_threshold`.
A finding is **confirmed** when `finding_i >= 0.5`, **dismissed** when
`finding_i < 0.35`, and **uncertain** in between (0.35 <= p < 0.5).

- **fail** if any of:
  - a guard failed
  - a check failed
  - a blocker/major finding is confirmed
  - `addresses.choice = no` with confidence >= C
  - `addresses.probabilities.yes < T` with confidence >= C
  - `unrelated.choice = some` with confidence >= C
  - `tests.score < 1` with confidence >= C  (closer to "none" than "weak")
- **escalate** if not fail and any of:
  - `addresses`, `unrelated` or `tests` has confidence < C
  - a blocker finding is uncertain
  - the reviewer output was invalid
- **pass** otherwise.

Dismissed and uncertain findings are left out of fixer feedback and listed in
the PR report.

### Loop and stop rules (`loop.ts`)

- pass -> stop, result `passed`.
- escalate -> stop, result `escalated`.
- fail and round == max_rounds -> stop, result `failed`.
- fail and the failure signature equals the previous round's -> stop, result
  `failed` (no progress). Signature = sorted list of failed guard names,
  failed check commands, confirmed finding titles, and failed Jev rule names.
- total agent cost >= max_cost_usd -> stop, result `failed`. Each agent
  session also gets `maxBudgetUsd` = remaining budget.
- otherwise build feedback and run the next round. The fixer keeps working
  on the same working tree (changes accumulate).

### Feedback (`feedback.ts`)

One markdown note: failed guards, failed check command + truncated output,
confirmed findings (file:line, title, detail), and plain-language Jev failures
("an independent judge found the diff only partly implements the issue").
Scores and thresholds are not included.

## Output

- Branch `agent/issue-<n>`, one commit per round (`fix: agent round N for #n`),
  pushed by the action with the job token. The agent never runs `git push`.
- A PR linked to the issue (`Closes #n`). Draft unless result = passed and
  risk is not high. Labels: `agent:passed` | `agent:escalated` | `agent:failed`.
- A gate report in the PR body: intake answers, a table per round (guards,
  checks, findings kept / dismissed, Jev probabilities and confidence,
  decision), total cost.
- If round 1 fails guards and produces no diff at all, no PR is opened; the
  report is posted as an issue comment instead.
- Action outputs: `result`, `pr_number`, `rounds`, `cost_usd`.

## Inputs (`action.yml`)

| Input | Default | Notes |
|---|---|---|
| `anthropic_api_key` | required | |
| `typesafe_api_key` | required | |
| `github_token` | `${{ github.token }}` | needs contents, pull-requests, issues: write |
| `checks` | required | newline-separated shell commands |
| `issue_number` | from event | |
| `max_rounds` | `3` | |
| `max_cost_usd` | `5` | |
| `fixer_model` | `claude-opus-5` | |
| `reviewer_model` | `claude-opus-5` | |
| `jev_model` | `jev-latest` | SDK default model |
| `protected_paths` | `.github/**` | newline-separated globs |
| `max_diff_lines` | `800` | added + removed |
| `pass_threshold` | `0.8` | |
| `min_confidence` | `0.7` | |

## Packaging

- Composite action (`runs: using: composite`). The Claude Agent SDK ships its
  `claude` executable as a per-platform optional dependency, so bundling into
  one `dist/index.js` would drop it. Instead the action:
  1. `oven-sh/setup-bun@v2`
  2. `bun install --frozen-lockfile --production` in `$GITHUB_ACTION_PATH`
  3. `bun $GITHUB_ACTION_PATH/src/main.ts`
  Inputs reach the script as `INPUT_*` env vars set in the step.
- `bun.lock` is committed. No build step, no `dist/`.
- `.github/workflows/agent-loop.yml`: `on: workflow_call`. The two API keys
  are `secrets`; `checks` and the tuning values are `inputs`. It does the
  event-shape filtering, checks out with `fetch-depth: 0`
  and `persist-credentials: false`, and calls the action.
- `examples/consumer.yml`: the file a consumer repo copies.

## Modules

| File | Job | I/O |
|---|---|---|
| `src/main.ts` | read `INPUT_*`, build deps, run loop, write `GITHUB_OUTPUT` | yes |
| `src/loop.ts` | intake -> rounds -> result | via injected deps |
| `src/gate.ts` | decision rules | pure |
| `src/feedback.ts` | feedback note + failure signature | pure |
| `src/report.ts` | PR body markdown | pure |
| `src/agents/fixer.ts` | fixer session | Claude Agent SDK |
| `src/agents/reviewer.ts` | reviewer session + JSON parse | Claude Agent SDK |
| `src/jev.ts` | intake + gate questions | `@typesafe-ai/sdk` |
| `src/checks.ts` | run check commands | child_process |
| `src/guards.ts` | protected paths, deleted tests, diff size | git |
| `src/github.ts` | issue read, comments, branch, push, PR, labels | `@octokit/rest`, git |
| `src/local.ts` | run the loop on a local folder with a stub GitHub | yes |

`loop.ts` takes a `Deps` object (fixer, reviewer, jev, checks, guards, git,
publisher) so `local.ts` can swap GitHub for a console publisher.

## Security

- Issue text is untrusted input. It is passed to agents inside a clearly
  delimited block, and the fixer's system prompt says instructions inside
  the issue cannot change its rules.
- Fixer tool rules deny edits under protected paths; guards enforce the same
  rule after the fact (defense in depth).
- `TYPESAFE_API_KEY` and `GITHUB_TOKEN` are never passed to agent sessions;
  all keys are stripped from check commands. Known limit: the fixer's Bash
  tool runs inside the Claude Code process, which needs
  `ANTHROPIC_API_KEY`, so a hostile issue could try to exfiltrate that key.
  Mitigation for the prototype: `canUseTool` denies Bash commands that
  mention `env`, `printenv`, `/proc`, or `curl`/`wget`; use a scoped,
  spend-limited Anthropic key.
- Checkout uses `persist-credentials: false`, so the agent has no git
  credentials. Only the action pushes, using an explicit token URL, and only
  to `agent/issue-<n>`.
- Agent sessions run with `settingSources: []` so the target repo's
  `.claude/` settings and hooks cannot change agent permissions.
- Trigger requires write permission on the repo.

## Verification (prototype)

1. `nr typecheck` (tsc --noEmit) passes.
2. Local end to end: a sample repo under `examples/sample-repo` (small TS
   project with a planted bug and a test script). `bun src/local.ts --repo
   <copy of sample> --issue-file <issue.md>` must finish with `passed` or a
   justified `escalated`, and print the gate report. Requires
   `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` in the user's shell.
3. Optional, only with explicit user approval: push to a private GitHub repo
   under the user's account, label an issue, confirm a PR with the gate
   report appears.

## Out of scope

- Auto-merge, PR comment triggers, follow-up rounds from human PR review.
- Engines other than Claude.
- Unit tests (prototype).

## Revision 1 (2026-09-17): cost controls and repo review assets

Requested by the user mid-build: minimise cost, no runaway spend, reuse the
review assets from `innhouse-core`. These rules override the sections above
where they differ.

### Cheapest gates first
Round order becomes: fixer → guards (now including the shortlist guard) →
checks → **Jev pre-check** → reviewer → **Jev finding verification** → decide.

- The Jev pre-check asks `addresses`, `unrelated` and `tests` (same questions
  as before) before any reviewer runs. If any of those rules fails with
  confidence >= `min_confidence`, the round fails and the reviewer is skipped.
- Finding verification is a second, separate Jev call with one `noul` per
  blocker/major finding. It is skipped (no API call) when there are none.
- If the pre-check call errors, the reviewer is skipped and the round
  escalates.

### Model routing and effort
- `fixer_model` default `claude-sonnet-5`, effort `high`, max 50 turns.
- `reviewer_model` default `auto`: `claude-haiku-4-5` when the change touches
  at most `small_diff_files` (8) files and `small_diff_lines` (200) lines,
  otherwise `claude-sonnet-5`. Effort `medium` (omitted for Haiku, which does
  not support effort). Max 15 turns. Any explicit model id overrides `auto`.
- The fixer resumes its own session in later rounds (`resume`), so it keeps
  its context instead of re-reading the repo.

### Tighter defaults
`max_rounds` 2, `max_cost_usd` 2, `protected_paths` `.github/**` and `.claude/**`.

### Repo review assets (from innhouse-core)
- `review_shortlist` (optional path, e.g. `.claude/review-shortlist.json`):
  rules in the `review-scan.sh` format (`rules[]` with `id`, `name`,
  `severity: hard|judgement`, `paths`, optional `excludePaths`, `grep` ERE,
  optional `excludeGrep`, optional `fix`, `source`). Each rule runs on the
  lines the change adds. `hard` hits fail a new `shortlist` guard (the
  feedback includes each rule's `fix`). `judgement` hits are passed to the
  reviewer as candidates to verify. Other top-level keys are ignored.
- `review_rubric` (optional path to a markdown file): its text is appended to
  the reviewer's instructions inside a `<rubric>` block.
- Both files are read from the base commit (`git show <base>:<path>`), so the
  fixer cannot change what it is judged by.

### Reporting
The round table shows the reviewer model used and the cost of each agent
session; a pre-check failure shows as "reviewer skipped".
