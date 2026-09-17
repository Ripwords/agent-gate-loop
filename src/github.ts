import { Octokit } from "@octokit/rest";
import { git } from "./proc";
import type { Issue } from "./types";

export const RESULT_LABELS = ["agent:passed", "agent:escalated", "agent:failed", "agent:high-risk"];

const LABEL_COLORS: Record<string, string> = {
  "agent:passed": "2da44e",
  "agent:escalated": "d4a72c",
  "agent:failed": "cf222e",
  "agent:high-risk": "8250df",
};

const hasStatus = (err: unknown, status: number) =>
  typeof err === "object" && err !== null && "status" in err && err.status === status;

export interface PrRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
}

export interface UpsertPrResult {
  number: number;
  draftUnsupported: boolean;
}

const DRAFT_UNSUPPORTED_NOTE =
  "\n\n> Note: draft PRs are not available on this repository's plan, so this PR is open. Check the agent:* label before merging.";

export function makeGitHub(token: string, ownerRepo: string) {
  const [owner = "", repo = ""] = ownerRepo.split("/");
  const octokit = new Octokit({ auth: token });

  async function setDraft(nodeId: string, isDraft: boolean, wantDraft: boolean) {
    if (isDraft === wantDraft) return;
    const mutation = wantDraft
      ? "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { clientMutationId } }"
      : "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }";
    await octokit.graphql(mutation, { id: nodeId });
  }

  return {
    async getIssue(issueNumber: number): Promise<Issue> {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      return { number: issueNumber, title: data.title, body: data.body ?? "" };
    },

    async canWrite(username: string): Promise<boolean> {
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
        return data.permission === "admin" || data.permission === "write";
      } catch (err) {
        if (hasStatus(err, 404)) return false;
        throw err;
      }
    },

    async comment(issueNumber: number, body: string): Promise<void> {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },

    async upsertPr(req: PrRequest): Promise<UpsertPrResult> {
      for (const name of req.labels) {
        try {
          await octokit.rest.issues.createLabel({ owner, repo, name, color: LABEL_COLORS[name] ?? "ededed" });
        } catch (err) {
          if (!hasStatus(err, 422)) throw err;
        }
      }

      const { data: open } = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${req.head}`, state: "open" });
      const existing = open[0];
      let prNumber: number;
      let draftUnsupported = false;
      if (existing) {
        prNumber = existing.number;
        await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, title: req.title, body: req.body });
        try {
          await setDraft(existing.node_id, existing.draft ?? false, req.draft);
        } catch (err) {
          // Only the draft-conversion direction is known to fail on plans without draft PR
          // support; a failure converting a draft back to ready is a real error.
          if (!req.draft) throw err;
          draftUnsupported = true;
        }
      } else {
        try {
          const { data } = await octokit.rest.pulls.create({
            owner,
            repo,
            head: req.head,
            base: req.base,
            title: req.title,
            body: req.body,
            draft: req.draft,
          });
          prNumber = data.number;
        } catch (err) {
          if (!req.draft || !hasStatus(err, 422)) throw err;
          const { data } = await octokit.rest.pulls.create({
            owner,
            repo,
            head: req.head,
            base: req.base,
            title: req.title,
            body: req.body,
            draft: false,
          });
          prNumber = data.number;
          draftUnsupported = true;
        }
      }

      if (draftUnsupported) {
        await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body: `${req.body}${DRAFT_UNSUPPORTED_NOTE}` });
      }

      for (const name of RESULT_LABELS.filter((l) => !req.labels.includes(l))) {
        try {
          await octokit.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name });
        } catch (err) {
          if (!hasStatus(err, 404)) throw err;
        }
      }
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: req.labels });
      return { number: prNumber, draftUnsupported };
    },
  };
}

export async function pushBranch(repoDir: string, token: string, ownerRepo: string, branch: string): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${ownerRepo}.git`;
  await git(repoDir, ["push", "--force", "--no-verify", "--quiet", url, `HEAD:refs/heads/${branch}`]);
}
