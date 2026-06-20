import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface PlanSteps {
  action: string;
  file?: string;
  content?: string;
}

export class RemediationPlanManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async generatePlans(
    diagnosisId: string,
    title: string,
    description: string,
    steps: PlanSteps[]
  ): Promise<{ planId: string; alternatives: string[] }> {
    logger.info({ diagnosisId, title }, "Generating remediation plans based on incident diagnosis");

    let planId = `plan-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const plan = await prisma.remediationPlan.create({
          data: {
            id: planId,
            diagnosisId,
            title,
            description,
            steps: steps as any,
            status: "GENERATED"
          }
        });
        planId = plan.id;
      } catch (err: any) {
        logger.warn({ err }, "Database RemediationPlan creation failed.");
        this.dbFallback = true;
      }
    }

    const alternatives = [
      "Alternative A: Modify configuration files in env variables",
      "Alternative B: Wrap execution logic in try/catch block with retry intervals"
    ];

    if (!this.dbFallback) {
      try {
        for (const alt of alternatives) {
          await prisma.remediationAlternative.create({
            data: {
              planId,
              description: alt,
              score: 85.0
            }
          });
        }
      } catch (err: any) {
        logger.warn({ err }, "Failed to write RemediationAlternative entries to database");
      }
    }

    return { planId, alternatives };
  }
}
