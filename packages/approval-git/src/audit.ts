import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class AuditLogger {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async log(
    orgId: string,
    userId: string | null,
    action: string,
    payload: any
  ): Promise<string> {
    logger.info({ orgId, userId, action, payload }, "Recording audit log entry");

    let auditId = `audit-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const al = await prisma.auditLog.create({
          data: {
            id: auditId,
            orgId,
            userId,
            action,
            payload: payload as any
          }
        });
        auditId = al.id;
      } catch (err: any) {
        logger.warn({ err }, "Database AuditLog creation failed.");
        this.dbFallback = true;
      }
    }

    return auditId;
  }
}
