import { logger } from "@opspilot/shared";

export class UnsupportedWorkflowStepError extends Error {
  constructor(public readonly stepType: string) {
    super(`Unsupported workflow step type: ${stepType}`);
    this.name = "UnsupportedWorkflowStepError";
  }
}

export function getAffectedTables(plan: any, contracts: any[]): string[] {
  const affectedTables = new Set<string>();
  if (plan && Array.isArray(plan.steps)) {
    for (const step of plan.steps) {
      if (step.config?.contractId) {
        const contract = contracts.find(c => c.id === step.config.contractId);
        if (contract) {
          if (Array.isArray(contract.prisma) && contract.prisma.length > 0) {
            for (const p of contract.prisma) {
              if (p.model) affectedTables.add(p.model);
            }
          } else {
            const pathSegments = contract.path.split("/").filter(Boolean);
            const resource = pathSegments.find((s: string) => !s.startsWith(":") && !s.startsWith("{") && s !== "api" && s !== "v1");
            if (resource) affectedTables.add(resource);
          }
        }
      }
    }
  }
  if (affectedTables.size === 0) {
    affectedTables.add("User");
  }
  return [...affectedTables];
}

export async function runDatabaseCleanup(
  assertionEngine: any,
  affectedTables: string[],
  variables: Record<string, any>
): Promise<void> {
  logger.info({ affectedTables }, "Starting database cleanup for affected tables");
  for (const table of affectedTables) {
    const candidates = [
      `${table.toLowerCase()}s.id`,
      `${table.toLowerCase()}.id`,
      `${table}.id`
    ];
    let foundId: any = undefined;
    for (const candidate of candidates) {
      if (variables[candidate]) {
        foundId = variables[candidate];
        break;
      }
    }

    if (foundId) {
      logger.info({ table, id: foundId }, "Cleaning up generated database record");
      try {
        await assertionEngine.assertDBState({
          action: "cleanup",
          table,
          whereClause: { id: foundId }
        });
      } catch (err: any) {
        logger.warn({ table, id: foundId, err: err.message }, "Database cleanup action failed");
      }
    }
  }
}
