import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface VerificationGatesConfig {
  runBuild: boolean;
  runTests: boolean;
  runReplay: boolean;
  checkSecurity: boolean;
}

export class VerificationGates {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async evaluateGates(
    remediationPlanId: string,
    config: VerificationGatesConfig,
    buildSuccess: boolean,
    testSuccess: boolean,
    replaySuccess: boolean
  ): Promise<{ success: boolean; runId: string }> {
    logger.info({ remediationPlanId, config }, "Evaluating verification gates for remediation plan");

    let planId = `vp-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const vp = await prisma.verificationPlan.create({
          data: {
            id: planId,
            remediationPlanId,
            config: config as any
          }
        });
        planId = vp.id;
      } catch (err: any) {
        logger.warn({ err }, "Database VerificationPlan creation failed.");
        this.dbFallback = true;
      }
    }

    const success = (!config.runBuild || buildSuccess) &&
                    (!config.runTests || testSuccess) &&
                    (!config.runReplay || replaySuccess);

    let runId = `vr-${Math.random().toString(36).substring(2, 9)}`;
    const logs = `Gates check build: ${buildSuccess}, tests: ${testSuccess}, replay: ${replaySuccess}`;

    if (!this.dbFallback) {
      try {
        const vr = await prisma.verificationRun.create({
          data: {
            id: runId,
            verificationPlanId: planId,
            success,
            logs
          }
        });
        runId = vr.id;

        const assertions = [
          { name: "Build Compilation", passed: buildSuccess },
          { name: "Unit/E2E Test Execution", passed: testSuccess },
          { name: "Workflow Replay", passed: replaySuccess }
        ];

        for (const ass of assertions) {
          await prisma.verificationAssertion.create({
            data: {
              runId,
              name: ass.name,
              passed: ass.passed
            }
          });
        }

        await prisma.riskAssessment.create({
          data: {
            remediationPlanId,
            score: success ? 10.0 : 80.0, 
            analysis: success ? "Fix verified and passing all validation gates." : "Verification failed. High regression risk."
          }
        });

      } catch (err: any) {
        logger.warn({ err }, "Database verification logging failed.");
      }
    }

    return { success, runId };
  }
}
