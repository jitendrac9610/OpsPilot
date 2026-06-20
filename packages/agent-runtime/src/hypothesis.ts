import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface HypothesisData {
  id?: string;
  description: string;
  confidence: number;
  status: "SUPPORTED" | "CONTRADICTED" | "NEUTRAL";
}

export class HypothesisEngine {
  private agentRunId: string;
  private hypotheses: HypothesisData[] = [];
  private dbFallback = false;

  constructor(agentRunId: string) {
    this.agentRunId = agentRunId;
  }

  public getHypotheses() {
    return this.hypotheses;
  }

  public async addHypothesis(description: string, confidence: number) {
    const hyp: HypothesisData = {
      description,
      confidence,
      status: "NEUTRAL"
    };

    try {
      const dbHyp = await prisma.hypothesis.create({
        data: {
          agentRunId: this.agentRunId,
          description,
          confidence,
          status: "NEUTRAL"
        }
      });
      hyp.id = dbHyp.id;
    } catch (err: any) {
      logger.warn({ err }, "Database hypothesis save failed. Using in-memory fallback.");
      this.dbFallback = true;
      hyp.id = `mock-hyp-${Math.random().toString(36).substring(2, 9)}`;
    }

    this.hypotheses.push(hyp);
    return hyp;
  }

  public async updateHypothesis(id: string, updates: Partial<Pick<HypothesisData, "confidence" | "status">>) {
    const hyp = this.hypotheses.find((h) => h.id === id);
    if (hyp) {
      if (updates.confidence !== undefined) hyp.confidence = updates.confidence;
      if (updates.status !== undefined) hyp.status = updates.status;
    }

    if (!this.dbFallback) {
      try {
        await prisma.hypothesis.update({
          where: { id },
          data: {
            confidence: updates.confidence,
            status: updates.status
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database hypothesis update failed.");
      }
    }
  }
}
