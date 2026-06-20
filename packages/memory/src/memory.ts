import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class MemoryManager {
  private localFallback: Map<string, any[]> = new Map();

  public async createRecord(agentRunId: string, type: string, content: any) {
    logger.debug({ agentRunId, type }, "Creating memory record");
    try {
      return await prisma.memoryRecord.create({
        data: {
          agentRunId,
          type,
          content
        }
      });
    } catch (err: any) {
      logger.warn({ err }, "Database memory write failed. Storing in local fallback.");
      const record = {
        id: `mock-mem-${Math.random().toString(36).substring(2, 9)}`,
        agentRunId,
        type,
        content,
        createdAt: new Date()
      };
      if (!this.localFallback.has(agentRunId)) {
        this.localFallback.set(agentRunId, []);
      }
      this.localFallback.get(agentRunId)!.push(record);
      return record;
    }
  }

  public async getRecords(agentRunId: string, type?: string) {
    logger.debug({ agentRunId, type }, "Retrieving memory records");
    try {
      return await prisma.memoryRecord.findMany({
        where: {
          agentRunId,
          ...(type ? { type } : {})
        },
        orderBy: {
          createdAt: "asc"
        }
      });
    } catch (err: any) {
      logger.warn({ err }, "Database memory read failed. Fetching from local fallback.");
      const list = this.localFallback.get(agentRunId) || [];
      if (type) {
        return list.filter((r) => r.type === type);
      }
      return list;
    }
  }

  public async clearRecords(agentRunId: string) {
    logger.debug({ agentRunId }, "Clearing memory records");
    try {
      await prisma.memoryRecord.deleteMany({
        where: { agentRunId }
      });
    } catch (err: any) {
      logger.warn({ err }, "Database memory clear failed.");
      this.localFallback.delete(agentRunId);
    }
  }
}
