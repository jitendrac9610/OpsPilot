import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface PlanStepData {
  index: number;
  description: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
}

export class Planner {
  private agentRunId: string;
  private goal: string;
  private version = 1;
  private steps: PlanStepData[] = [];
  private dbFallback = false;

  constructor(agentRunId: string, goal: string) {
    this.agentRunId = agentRunId;
    this.goal = goal;
  }

  public getSteps() {
    return this.steps;
  }

  public getVersion() {
    return this.version;
  }

  public async initializePlan(stepsDescription: string[]) {
    this.steps = stepsDescription.map((desc, i) => ({
      index: i + 1,
      description: desc,
      status: "PENDING"
    }));

    try {
      const plan = await prisma.plan.create({
        data: {
          agentRunId: this.agentRunId,
          goal: this.goal,
          version: this.version
        }
      });

      for (const step of this.steps) {
        await prisma.planStep.create({
          data: {
            planId: plan.id,
            index: step.index,
            description: step.description,
            status: step.status
          }
        });
      }
    } catch (err: any) {
      logger.warn({ err }, "Database plan initialization failed. Using in-memory fallback.");
      this.dbFallback = true;
    }
  }

  public async updateStepStatus(index: number, status: "PENDING" | "COMPLETED" | "FAILED") {
    const step = this.steps.find((s) => s.index === index);
    if (step) {
      step.status = status;
    }

    if (!this.dbFallback) {
      try {
        const plan = await prisma.plan.findFirst({
          where: { agentRunId: this.agentRunId, version: this.version },
          orderBy: { createdAt: "desc" }
        });
        if (plan) {
          await prisma.planStep.updateMany({
            where: { planId: plan.id, index },
            data: { status }
          });
        }
      } catch (err: any) {
        logger.warn({ err }, "Database plan step update failed.");
      }
    }
  }

  public async replan(reason: string, newSteps: string[]) {
    this.version++;
    logger.info({ reason, version: this.version }, "Replanning...");

    this.steps = newSteps.map((desc, i) => ({
      index: i + 1,
      description: desc,
      status: "PENDING"
    }));

    if (!this.dbFallback) {
      try {
        const plan = await prisma.plan.create({
          data: {
            agentRunId: this.agentRunId,
            goal: this.goal,
            version: this.version
          }
        });

        for (const step of this.steps) {
          await prisma.planStep.create({
            data: {
              planId: plan.id,
              index: step.index,
              description: step.description,
              status: step.status
            }
          });
        }
      } catch (err: any) {
        logger.warn({ err }, "Database replanning save failed.");
      }
    }
  }
}
