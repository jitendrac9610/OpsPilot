import { logger } from "@opspilot/shared";
import { VerificationGates, VerificationGatesConfig } from "./gates.js";

export interface RepairAttemptResult {
  patchApplied: boolean;
  changedFiles: string[];
  buildSuccess: boolean;
  testSuccess: boolean;
  replaySuccess: boolean;
  replayStatus?: "PASSED" | "FAILED" | "SKIPPED";
  overallResult?: "PASSED" | "FAILED" | "INCONCLUSIVE";
  securitySuccess: boolean;
  logs: string[];
}

export interface RepairAttemptExecutor {
  execute(plan: string, attempt: number): Promise<RepairAttemptResult>;
}

export interface RepairLoopPolicy {
  maxChangedFiles?: number;
  allowedPathPrefixes?: string[];
}

export class AlternativeRepairLoop {
  private readonly gates = new VerificationGates(true);

  constructor(
    private readonly executor?: RepairAttemptExecutor,
    private readonly policy: RepairLoopPolicy = {}
  ) {}

  public async runRepairLoop(
    remediationPlanId: string,
    gatesConfig: VerificationGatesConfig,
    alternativePlans: string[],
    maxAttempts = 3
  ): Promise<{ success: boolean; attemptCount: number; finalLogs: string[] }> {
    logger.info({ remediationPlanId, maxAttempts }, "Starting evidence-backed repair loop");
    if (!this.executor) {
      return {
        success: false,
        attemptCount: 0,
        finalLogs: ["VERIFICATION_EXECUTOR_NOT_CONFIGURED: No patch/build/test/replay executor was provided."]
      };
    }

    const finalLogs: string[] = [];
    let attemptCount = 0;
    for (const plan of alternativePlans.slice(0, maxAttempts)) {
      attemptCount++;
      finalLogs.push(`Attempt ${attemptCount}: ${plan}`);
      const result = await this.executor.execute(plan, attemptCount);
      finalLogs.push(...result.logs);

      const policyFailure = this.validatePatchPolicy(result);
      if (policyFailure) {
        finalLogs.push(policyFailure);
        continue;
      }
      if (!result.patchApplied) {
        finalLogs.push("PATCH_NOT_APPLIED: Verification cannot pass without an applied sandbox patch.");
        continue;
      }
      if (gatesConfig.checkSecurity && !result.securitySuccess) {
        finalLogs.push("SECURITY_REGRESSION_DETECTED");
        continue;
      }
      if (gatesConfig.runReplay && result.replayStatus === "SKIPPED") {
        finalLogs.push("WORKFLOW_REPLAY_SKIPPED_INCONCLUSIVE: missing replay evidence cannot satisfy verification gates.");
        continue;
      }

      const evaluation = await this.gates.evaluateGates(
        remediationPlanId,
        gatesConfig,
        result.buildSuccess,
        result.testSuccess,
        result.replaySuccess
      );
      if (evaluation.success) {
        finalLogs.push(`Attempt ${attemptCount} passed build, targeted tests, and workflow replay.`);
        return { success: true, attemptCount, finalLogs };
      }
      finalLogs.push(`Attempt ${attemptCount} failed one or more verification gates.`);
    }

    return { success: false, attemptCount, finalLogs };
  }

  private validatePatchPolicy(result: RepairAttemptResult): string | undefined {
    const maxChangedFiles = this.policy.maxChangedFiles ?? 10;
    if (result.changedFiles.length > maxChangedFiles) {
      return `CHANGED_FILE_BUDGET_EXCEEDED: ${result.changedFiles.length} files changed; limit is ${maxChangedFiles}.`;
    }
    if (this.policy.allowedPathPrefixes?.length) {
      const unsupported = result.changedFiles.find((file) =>
        !this.policy.allowedPathPrefixes!.some((prefix) => file.startsWith(prefix))
      );
      if (unsupported) return `UNSUPPORTED_FILE_MODIFIED: ${unsupported}`;
    }
    return undefined;
  }
}
