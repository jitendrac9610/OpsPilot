import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface EvidenceData {
  id?: string;
  hypothesisId?: string;
  type: string;
  payload: any;
  createdAt: Date;
}

export class EvidenceManager {
  private agentRunId: string;
  private evidenceList: EvidenceData[] = [];
  private missingEvidenceList: string[] = [];
  private dbFallback = false;

  constructor(agentRunId: string) {
    this.agentRunId = agentRunId;
  }

  public getEvidence() {
    return this.evidenceList;
  }

  public getMissingEvidence() {
    return this.missingEvidenceList;
  }

  public setMissingEvidence(items: string[]) {
    this.missingEvidenceList = items;
  }

  public async addEvidence(type: string, payload: any, hypothesisId?: string) {
    const ev: EvidenceData = {
      hypothesisId,
      type,
      payload,
      createdAt: new Date()
    };

    try {
      const dbEv = await prisma.evidence.create({
        data: {
          agentRunId: this.agentRunId,
          hypothesisId,
          type,
          payload
        }
      });
      ev.id = dbEv.id;
    } catch (err: any) {
      logger.warn({ err }, "Database evidence save failed. Using in-memory fallback.");
      this.dbFallback = true;
      ev.id = `mock-ev-${Math.random().toString(36).substring(2, 9)}`;
    }

    this.evidenceList.push(ev);
    return ev;
  }
}
