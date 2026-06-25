import { prisma } from "@opspilot/database";

export interface RuntimeRAGResult {
  stepRuns: any[];
  failureBoundaries: any[];
  incidentEvents: any[];
  telemetrySummary: string;
}

export class RuntimeStore {
  /**
   * Retrieves log clusters, trace telemetry, and container/Kubernetes events associated with a failing workflow or incident.
   */
  async searchRuntime(
    query: string,
    options: { workflowRunId?: string; incidentId?: string; limit?: number }
  ): Promise<RuntimeRAGResult> {
    const limit = options.limit ?? 5;
    const stepRuns: any[] = [];
    const failureBoundaries: any[] = [];
    const incidentEvents: any[] = [];
    const summaryLines: string[] = [];

    summaryLines.push("### Runtime Telemetry & Logs Context");

    // 1. Fetch Workflow Step Runs and Failure Boundaries
    if (options.workflowRunId) {
      const dbStepRuns = await prisma.workflowStepRun.findMany({
        where: { workflowRunId: options.workflowRunId },
      });

      const dbBoundaries = await prisma.failureBoundary.findMany({
        where: { workflowRunId: options.workflowRunId },
      });

      stepRuns.push(...dbStepRuns);
      failureBoundaries.push(...dbBoundaries);

      if (dbBoundaries.length > 0) {
        summaryLines.push("#### Localized Failure Boundaries:");
        for (const boundary of dbBoundaries) {
          summaryLines.push(`- **Failed Stage**: \`${boundary.failedStage}\` - **Reason**: ${boundary.reason} (Artifact: failureBoundary/\`${boundary.id}\`)`);
        }
      }

      const failedSteps = dbStepRuns.filter((r) => r.status === "FAILED" || r.error);
      if (failedSteps.length > 0) {
        summaryLines.push("\n#### Failed Workflow Steps & Logs:");
        for (const run of failedSteps.slice(0, limit)) {
          summaryLines.push(`- **Step Run ID**: \`${run.id}\` (Status: \`${run.status}\`) (Artifact: workflowStepRun/\`${run.id}\`)`);
          if (run.error) {
            summaryLines.push(`  - **Error**: \`${run.error}\``);
          }
          if (run.logs && run.logs.length > 0) {
            summaryLines.push("  - **LogsSnippet**:");
            for (const log of run.logs.slice(-5)) { // get last 5 log lines
              summaryLines.push(`    > ${log}`);
            }
          }
        }
      }
    }

    // 2. Fetch Incident Events
    if (options.incidentId) {
      const dbEvents = await prisma.incidentEvent.findMany({
        where: { incidentId: options.incidentId },
        orderBy: { timestamp: "asc" },
      });

      // Filter by query terms if query is provided
      const queryLower = query.toLowerCase();
      const matchedEvents = queryLower
        ? dbEvents.filter((e) => e.message.toLowerCase().includes(queryLower) || e.type.toLowerCase().includes(queryLower))
        : dbEvents;

      incidentEvents.push(...matchedEvents);

      if (matchedEvents.length > 0) {
        summaryLines.push("\n#### Incident Event Timeline:");
        for (const evt of matchedEvents.slice(0, limit * 2)) {
          summaryLines.push(
            `- [${evt.timestamp.toISOString()}] [${evt.type.toUpperCase()}] ${evt.message} (Artifact: incidentEvent/\`${evt.id}\`)`
          );
        }
      }
    }

    // 3. Fallback: Search all incident events / workflow failures if no ids specified
    if (!options.workflowRunId && !options.incidentId && query) {
      const matchedStepRuns = await prisma.workflowStepRun.findMany({
        where: {
          OR: [
            { error: { contains: query, mode: "insensitive" } },
            { logs: { has: query } }, // Postgres array search
          ],
        },
        take: limit,
      });

      stepRuns.push(...matchedStepRuns);

      if (matchedStepRuns.length > 0) {
        summaryLines.push("#### Matching Log/Error Signatures:");
        for (const run of matchedStepRuns) {
          summaryLines.push(`- Run: \`${run.workflowRunId}\` | Error: ${run.error}`);
        }
      }
    }

    if (summaryLines.length === 1) {
      summaryLines.push("No active runtime failure logs or incident event telemetry found.");
    }

    return {
      stepRuns,
      failureBoundaries,
      incidentEvents,
      telemetrySummary: summaryLines.join("\n"),
    };
  }
}
