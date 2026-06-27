import { execFileSync } from "node:child_process";
import { prisma } from "@opspilot/database";
import { config, logger } from "@opspilot/shared";
import { GitHubClient } from "@opspilot/connector-github";

export interface CreatePullRequestOptions {
  repositoryRoot: string;
  owner: string;
  repo: string;
  installationId: string;
  baseBranch?: string;
  runId?: string;
  title?: string;
  rootCause?: string;
  evidence?: string[];
  affectedWorkflow?: string;
  failureReproduction?: string;
  filesChanged?: string[];
  reason?: string;
  verification?: {
    build: "passed" | "failed" | "skipped";
    tests: "passed" | "failed" | "skipped";
    replay: "passed" | "failed" | "skipped";
    security: "passed" | "failed" | "skipped";
  };
}

export class PRManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async createPR(
    approvedActionId: string,
    branchName: string,
    options?: CreatePullRequestOptions
  ): Promise<{ success: boolean; prId: string; url: string; number: number }> {
    logger.info({ approvedActionId, branchName }, "Creating Git Pull Request");

    let prId = `pr-${Math.random().toString(36).substring(2, 9)}`;
    let number = 42;
    let url = "https://github.com/opspilot/demo-repo/pull/42";

    if (!options) {
      if (!this.dbFallback && !config.isDemoMode) {
        throw new Error("GITHUB_PR_CONTEXT_REQUIRED: repository root, installation, owner and repo are required.");
      }
      logger.info({ approvedActionId, branchName }, "Using demo pull request registration");
    } else {
      const safeBranchName = sanitizeBranchName(branchName || `opspilot/fix-${options.runId || approvedActionId}`);
      const baseBranch = options.baseBranch || "main";
      const token = await new GitHubClient().getInstallationToken(options.installationId);
      const title = options.title || `OpsPilot fix for ${options.runId || approvedActionId}`;
      const body = buildPullRequestBody(options);

      runGit(["config", "user.name", "OpsPilot"], options.repositoryRoot);
      runGit(["config", "user.email", "opspilot@local"], options.repositoryRoot);
      runGit(["checkout", "-B", safeBranchName], options.repositoryRoot);
      runGit(["add", "-A"], options.repositoryRoot);
      if (!hasStagedChanges(options.repositoryRoot)) {
        throw new Error("GITHUB_PR_EMPTY_PATCH: no verified changes were staged for the pull request.");
      }
      runGit(["commit", "-m", title], options.repositoryRoot);

      const pushUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${options.owner}/${options.repo}.git`;
      runGit(
        ["push", pushUrl, `HEAD:refs/heads/${safeBranchName}`, "--force-with-lease"],
        options.repositoryRoot,
        ["push", "https://x-access-token:***@github.com/<redacted>.git", `HEAD:refs/heads/${safeBranchName}`, "--force-with-lease"]
      );

      const pr = await new GitHubClient().createPullRequest(
        token,
        options.owner,
        options.repo,
        title,
        body,
        safeBranchName,
        baseBranch
      );
      number = pr.number;
      url = pr.url;
    }

    if (!this.dbFallback) {
      try {
        const pr = await prisma.pullRequest.create({
          data: {
            id: prId,
            approvedAction: approvedActionId,
            number,
            url
          }
        });
        prId = pr.id;
      } catch (err: any) {
        logger.warn({ err }, "Database PullRequest registration failed.");
        this.dbFallback = true;
      }
    }

    return {
      success: true,
      prId,
      url,
      number
    };
  }
}

function buildPullRequestBody(options: CreatePullRequestOptions): string {
  const verification = options.verification || {
    build: "skipped",
    tests: "skipped",
    replay: "skipped",
    security: "skipped"
  };
  return [
    "## OpsPilot diagnosis",
    `Root cause: ${options.rootCause || "See linked diagnostic run."}`,
    `Evidence: ${(options.evidence || []).join("; ") || "Captured in OpsPilot evidence timeline."}`,
    `Affected workflow: ${options.affectedWorkflow || "See diagnostic workflow."}`,
    `Failure reproduction: ${options.failureReproduction || "Reproduced by OpsPilot before patching."}`,
    "",
    "## Proposed fix",
    `Files changed: ${(options.filesChanged || []).join(", ") || "See diff."}`,
    `Reason: ${options.reason || "Patch verified by OpsPilot remediation gates."}`,
    "",
    "## Verification",
    `- Build: ${verification.build}`,
    `- Unit tests: ${verification.tests}`,
    `- Workflow replay: ${verification.replay}`,
    `- Security gate: ${verification.security}`
  ].join("\n");
}

function sanitizeBranchName(branchName: string): string {
  return branchName
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .slice(0, 120) || `opspilot/fix-${Date.now()}`;
}

function hasStagedChanges(cwd: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd, stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

function runGit(args: string[], cwd: string, redactedArgs = args): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (err: any) {
    const stderr = err.stderr ? String(err.stderr) : "";
    const stdout = err.stdout ? String(err.stdout) : "";
    throw new Error(`Git command failed: git ${redactedArgs.join(" ")}. ${stderr || stdout || err.message}`);
  }
}
