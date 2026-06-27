import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { prisma } from "@opspilot/database";
import { logger, config } from "@opspilot/shared";
import { WorkflowReplayer } from "@opspilot/workflow-core";
import { RepairAttemptExecutor, RepairAttemptResult } from "./loop.js";
import { applyUnifiedDiffs } from "./patchApplier.js";
import { classifyVerification } from "./verifier.js";

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (err: any) {
    throw new Error(`Git command failed: git ${args.join(" ")}. Error: ${err.message}. Output: ${err.stderr || err.stdout}`);
  }
}

function ensureGitRepo(repositoryRoot: string, logs: string[]): void {
  const gitDir = path.join(repositoryRoot, ".git");
  if (!fs.existsSync(gitDir)) {
    logs.push("Initializing temporary Git repository for worktree operations...");
    runGit(["init"], repositoryRoot);
    runGit(["config", "user.name", "OpsPilot"], repositoryRoot);
    runGit(["config", "user.email", "opspilot@local"], repositoryRoot);
    runGit(["add", "."], repositoryRoot);
    runGit(["commit", "-m", "initial snapshot commit"], repositoryRoot);
    logs.push("Temporary Git repository initialized.");
  } else {
    try {
      const status = runGit(["status", "--porcelain"], repositoryRoot).trim();
      if (status) {
        logs.push("Committing uncommitted changes in original repository to allow worktree creation...");
        runGit(["add", "."], repositoryRoot);
        runGit(["commit", "-m", "uncommitted changes backup"], repositoryRoot);
      }
    } catch (err: any) {
      logs.push(`Warning during git status/commit: ${err.message}`);
    }
  }

  try {
    runGit(["rev-parse", "HEAD"], repositoryRoot);
  } catch {
    logs.push("No commits found in Git repository. Creating initial commit...");
    runGit(["add", "."], repositoryRoot);
    runGit(["commit", "-m", "initial commit"], repositoryRoot);
  }
}

export function checkForFalseFixes(diff: string, logs: string[]): boolean {
  if (!diff) return false;
  // 1. Swallow errors: try { ... } catch (e) {} with empty body or only console.log
  const emptyCatchRegex = /catch\s*\([^)]*\)\s*\{\s*(console\.[a-z]+\([^)]*\);?\s*)?\}/gi;
  if (emptyCatchRegex.test(diff)) {
    logs.push("False fix detected: Patch attempts to swallow errors via empty or log-only catch blocks.");
    return true;
  }

  // 2. Remove assertions: removing lines with assert/expect/should/t.true/t.false/t.is
  const assertionLines = diff.split("\n").filter(line => line.startsWith("-"));
  const assertRegex = /\b(assert|expect|should|t\.(true|false|is|deepEqual|fail))\b/i;
  for (const line of assertionLines) {
    if (assertRegex.test(line)) {
      logs.push(`False fix detected: Patch removes assertions (line: "${line.trim()}").`);
      return true;
    }
  }

  // 3. Weaken expected statuses: changing expected response checks to wildcards or weaker constraints
  const weakenStatusRegex = /-\s*.*\.status(Code)?\s*===\s*(200|201)/i;
  if (weakenStatusRegex.test(diff)) {
    logs.push("False fix detected: Patch weakens expected HTTP response status checks.");
    return true;
  }

  // 4. Skip workers: commenting out worker execution or queue additions
  const skipWorkerRegex = /\/\/\s*.*(queue\.add|new\s+Worker|processJob)/gi;
  if (skipWorkerRegex.test(diff)) {
    logs.push("False fix detected: Patch attempts to bypass worker queue additions or processes.");
    return true;
  }

  return false;
}

export function checkForSecurityIssues(diff: string, logs: string[]): boolean {
  if (!diff) return true;
  // 1. Hardcoded credentials: e.g. api_key = "sk_test_..." or secret = "..." on lines starting with "+"
  const addedLines = diff.split("\n").filter(line => line.startsWith("+"));
  const secretKeyRegex = /\b(api_key|apikey|secret|password|private_key|token|auth_token|passwd)\b\s*[:=]\s*["'][^"']{8,}["']/i;
  for (const line of addedLines) {
    if (secretKeyRegex.test(line)) {
      logs.push(`Security issue detected: Hardcoded credential or token exposed (line: "${line.trim()}").`);
      return false; // security success is false
    }
  }

  // 2. Unsafe execution: eval or child_process execution
  const unsafeExecRegex = /\b(eval|exec|execSync)\b\s*\(/i;
  for (const line of addedLines) {
    if (unsafeExecRegex.test(line)) {
      logs.push(`Security issue detected: Unsafe execution method (eval/exec) introduced (line: "${line.trim()}").`);
      return false; // security success is false
    }
  }

  return true; // security success is true
}

export class SandboxRepairAttemptExecutor implements RepairAttemptExecutor {
  constructor(
    private readonly sandboxId: string,
    private readonly remediationPlanId: string
  ) {}

  public async execute(plan: string, attempt: number): Promise<RepairAttemptResult> {
    const logs: string[] = [`Starting SandboxRepairAttemptExecutor for plan: ${plan}, attempt: ${attempt}`];
    const changedFiles: string[] = [];

    let buildSuccess = false;
    let testSuccess = false;
    let replaySuccess = false;
    let replaySkipped = false;
    let patchApplied = false;
    let securitySuccess = true;
    let worktreePath = "";
    let originalRepositoryRoot = "";
    let workspaceJsonPath = "";

    try {
      // 1. Resolve sandbox details and repositoryRoot
      workspaceJsonPath = path.join(config.tempRoot, "sandboxes", this.sandboxId, "opspilot-workspace.json");
      if (!fs.existsSync(workspaceJsonPath)) {
        throw new Error(`Workspace json not found at ${workspaceJsonPath}`);
      }
      const workspaceJson = JSON.parse(fs.readFileSync(workspaceJsonPath, "utf8"));
      originalRepositoryRoot = workspaceJson.repositoryRoot;
      const workspaceDir = path.dirname(workspaceJsonPath);
      logs.push(`Resolved repositoryRoot: ${originalRepositoryRoot}`);

      // 2. Fetch ChangeSet and ChangeSetFiles from DB
      const changeSets = await prisma.changeSet.findMany({
        where: { remediationPlanId: this.remediationPlanId }
      });
      const changeSetIds = changeSets.map(c => c.id);
      const filesToPatch = await prisma.changeSetFile.findMany({
        where: { changeSetId: { in: changeSetIds } }
      });

      if (filesToPatch.length === 0) {
        throw new Error("PATCH_UNAVAILABLE: remediation changeset has no unified diff files to apply.");
      }

      // Safety and Policy: Reject oversized changes
      const maxFiles = 10;
      const maxDiffSize = 100 * 1024; // 100KB
      if (filesToPatch.length > maxFiles) {
        throw new Error(`Oversized patch rejected: too many files modified (${filesToPatch.length} > ${maxFiles})`);
      }
      let totalDiffSize = 0;
      for (const file of filesToPatch) {
        totalDiffSize += file.diff.length;
      }
      if (totalDiffSize > maxDiffSize) {
        throw new Error(`Oversized patch rejected: total patch size exceeds limit (${totalDiffSize} > ${maxDiffSize} bytes)`);
      }

      // Check false-fixes and security issues in the diffs
      for (const file of filesToPatch) {
        if (checkForFalseFixes(file.diff, logs)) {
          throw new Error(`Patch rejected due to false fix detection in ${file.path}`);
        }
        if (!checkForSecurityIssues(file.diff, logs)) {
          securitySuccess = false;
          throw new Error(`Patch rejected due to security gate violation in ${file.path}`);
        }
      }

      // 3. Setup Git Repository and Worktree
      ensureGitRepo(originalRepositoryRoot, logs);
      
      worktreePath = path.join(workspaceDir, "worktrees", `wt-${attempt}`);
      // Ensure the worktree dir parent exists, and the worktree itself doesn't exist
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      fs.rmSync(worktreePath, { recursive: true, force: true });

      logs.push(`Creating temporary Git worktree at ${worktreePath}...`);
      runGit(["worktree", "add", worktreePath], originalRepositoryRoot);

      // 4. Update manifest to point to worktree
      workspaceJson.repositoryRoot = worktreePath;
      fs.writeFileSync(workspaceJsonPath, JSON.stringify(workspaceJson, null, 2), "utf8");
      logs.push(`Workspace manifest updated to point repositoryRoot to worktree: ${worktreePath}`);

      // 5. Apply Diffs in the worktree
      const applied = applyUnifiedDiffs(
        worktreePath,
        filesToPatch.map((file) => ({
          path: file.path,
          diff: file.diff,
          originalHash: file.originalHash
        }))
      );
      changedFiles.push(...applied.changedFiles);
      patchApplied = changedFiles.length > 0;
      logs.push(`Applied unified patch with git apply to ${changedFiles.length} file(s).`);

      // 6. Run Build in Sandbox
      logs.push("Running sandbox compilation build...");
      const buildRes = await fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${this.sandboxId}/build`, {
        method: "POST"
      });
      if (buildRes.ok) {
        buildSuccess = true;
        logs.push("Sandbox compilation build: SUCCESS");
      } else {
        const buildErrText = await buildRes.text();
        logs.push(`Sandbox compilation build: FAILED. Error: ${buildErrText}`);
      }

      // 7. Run Tests in Sandbox (only if build succeeded)
      if (buildSuccess) {
        logs.push("Running sandbox unit tests...");
        const testRes = await fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${this.sandboxId}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "unit" })
        });
        if (testRes.ok) {
          testSuccess = true;
          logs.push("Sandbox unit tests: SUCCESS");
        } else {
          const testErrText = await testRes.text();
          logs.push(`Sandbox unit tests: FAILED. Error: ${testErrText}`);
        }
      }

      // 8. Run Workflow Replay (only if build and tests succeeded)
      if (buildSuccess && testSuccess) {
        logs.push("Running workflow replayer against patched services...");
        
        // Fetch synthetic workflow steps via relations
        const planObj = await prisma.remediationPlan.findUnique({ where: { id: this.remediationPlanId } });
        const diagnosis = await prisma.diagnosis.findUnique({ where: { id: planObj?.diagnosisId } });
        const agentRun = await prisma.agentRun.findUnique({ where: { id: diagnosis?.agentRunId } });
        const workflowRun = await prisma.workflowRun.findUnique({ where: { id: agentRun?.workflowRunId } });
        const workflow = await prisma.syntheticWorkflow.findUnique({ where: { id: workflowRun?.workflowId } });

        if (workflow) {
          // Restart/Run services to apply the patched code
          logs.push("Starting/Running patched services in sandbox...");
          const runRes = await fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${this.sandboxId}/run`, {
            method: "POST"
          });
          const runResult = await runRes.json() as any;
          const apiEndpoint = runResult.endpoints?.find((e: any) => e.kind === "api" || e.kind === "application") || runResult.endpoints?.[0];
          const baseApiUrl = apiEndpoint ? apiEndpoint.externalUrl : "http://localhost:4000";

          const { WorkflowDrivers } = await import("@opspilot/workflow-core");
          const replayer = new WorkflowReplayer(new WorkflowDrivers(baseApiUrl));
          const steps = workflow.steps as any[];
          
          const replayResult = await replayer.replay(steps, {
            correlationId: workflowRun?.correlationId,
            workflowRunId: workflowRun?.id
          });

          replaySuccess = replayResult.success;
          replaySkipped = false;
          logs.push(...replayResult.logs);
          logs.push(`Workflow replay: ${replaySuccess ? "SUCCESS" : "FAILED"}`);

          // Compare behavioral invariants
          if (replayResult.stepResults) {
            logs.push("Comparing behavioral invariants...");
            for (let i = 0; i < replayResult.stepResults.length; i++) {
              const stepRes = replayResult.stepResults[i];
              logs.push(`Step ${i + 1} (${stepRes.type}): Success = ${stepRes.success}, Status = ${stepRes.status ?? "N/A"}`);
              if (!stepRes.success) {
                logs.push(`Warning: Behavioral degradation detected at step ${i + 1}`);
              }
            }
          }
        } else {
          logs.push("Workflow replay: SKIPPED because synthetic workflow steps were not found.");
          replaySkipped = true;
          replaySuccess = false;
        }
      }

    } catch (err: any) {
      logs.push(`Exception in SandboxRepairAttemptExecutor: ${err.message}`);
    } finally {
      // 9. Restore manifest to point to original repositoryRoot
      if (workspaceJsonPath && originalRepositoryRoot) {
        try {
          const workspaceJson = JSON.parse(fs.readFileSync(workspaceJsonPath, "utf8"));
          workspaceJson.repositoryRoot = originalRepositoryRoot;
          fs.writeFileSync(workspaceJsonPath, JSON.stringify(workspaceJson, null, 2), "utf8");
          logs.push("Workspace manifest restored to original repositoryRoot.");
        } catch (err: any) {
          logs.push(`Error restoring workspace manifest: ${err.message}`);
        }
      }

      // 10. Destroy the temporary worktree
      if (worktreePath && originalRepositoryRoot && fs.existsSync(worktreePath)) {
        try {
          logs.push(`Removing temporary Git worktree at ${worktreePath}...`);
          runGit(["worktree", "remove", "--force", worktreePath], originalRepositoryRoot);
          runGit(["worktree", "prune"], originalRepositoryRoot);
          fs.rmSync(worktreePath, { recursive: true, force: true });
          logs.push("Git worktree destroyed.");
        } catch (err: any) {
          logs.push(`Warning: Failed to clean up Git worktree: ${err.message}`);
        }
      }
    }

    const verification = classifyVerification({
      buildSuccess,
      testSuccess,
      replaySuccess,
      securitySuccess,
      replaySkipped
    });
    logs.push(`Verification overall result: ${verification.overallResult}`);

    return {
      patchApplied,
      changedFiles,
      buildSuccess,
      testSuccess,
      replaySuccess,
      replayStatus: verification.replayAfter,
      overallResult: verification.overallResult,
      securitySuccess,
      logs
    };
  }
}

export function applyDiff(originalContent: string, diff: string): string {
  const originalLines = originalContent.split("\n");
  const diffLines = diff.split("\n");
  let resultLines: string[] = [];

  if (!diff.includes("@@") && (diff.startsWith("+") || diff.startsWith("-"))) {
    for (const line of diffLines) {
      if (line.startsWith("+")) {
        resultLines.push(line.substring(1));
      } else if (line.startsWith("-")) {
        // skip
      } else {
        resultLines.push(line);
      }
    }
    return resultLines.join("\n");
  }

  let currentLine = 0;
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("index")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (match) {
        const targetStart = parseInt(match[1], 10) - 1;
        while (currentLine < targetStart && currentLine < originalLines.length) {
          resultLines.push(originalLines[currentLine]);
          currentLine++;
        }
      }
      continue;
    }
    if (line.startsWith("+")) {
      resultLines.push(line.substring(1));
    } else if (line.startsWith("-")) {
      currentLine++;
    } else {
      if (currentLine < originalLines.length) {
        resultLines.push(originalLines[currentLine]);
        currentLine++;
      }
    }
  }
  while (currentLine < originalLines.length) {
    resultLines.push(originalLines[currentLine]);
    currentLine++;
  }
  return resultLines.join("\n");
}
