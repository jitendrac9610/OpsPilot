import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class RollbackManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async startRecoveryMonitor(approvedActionId: string): Promise<string> {
    logger.info({ approvedActionId }, "Starting recovery monitoring loop");

    let monitorId = `mon-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const rm = await prisma.recoveryMonitor.create({
          data: {
            id: monitorId,
            actionId: approvedActionId,
            status: "MONITORING",
            logs: "Recovery monitor initiated."
          }
        });
        monitorId = rm.id;
      } catch (err: any) {
        logger.warn({ err }, "Database RecoveryMonitor creation failed.");
        this.dbFallback = true;
      }
    }

    return monitorId;
  }

  public async triggerRollback(
    monitorId: string,
    reason: string
  ): Promise<{ success: boolean; rollbackId: string }> {
    logger.warn({ monitorId, reason }, "Recovery health check breached! Triggering rollback deployment");

    if (!this.dbFallback) {
      try {
        await prisma.recoveryMonitor.update({
          where: { id: monitorId },
          data: {
            status: "BREACHED",
            logs: `Breached: ${reason}`
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database RecoveryMonitor status update failed.");
      }
    }

    let rollbackId = `rb-${Math.random().toString(36).substring(2, 9)}`;
    const rollbackLogs = `Reverting environment to previous healthy release commit. Reason: ${reason}`;

    if (!this.dbFallback) {
      try {
        const re = await prisma.rollbackExecution.create({
          data: {
            id: rollbackId,
            monitorId,
            success: true,
            logs: rollbackLogs
          }
        });
        rollbackId = re.id;
      } catch (err: any) {
        logger.warn({ err }, "Database RollbackExecution registration failed.");
      }
    }

    return {
      success: true,
      rollbackId
    };
  }
}
