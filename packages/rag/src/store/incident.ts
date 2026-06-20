import { prisma } from "@opspilot/database";

export interface IncidentRAGResult {
  postmortems: any[];
  incidentSummary: string;
}

export class IncidentStore {
  /**
   * Queries historical Postmortem records for past verified fixes and root cause summaries.
   */
  async searchIncidents(
    query: string,
    options: { limit?: number }
  ): Promise<IncidentRAGResult> {
    const limit = options.limit ?? 3;
    const summaryLines: string[] = [];

    summaryLines.push("### Historical Incident Memory & Postmortems Context");

    const allPostmortems = await prisma.postmortem.findMany();

    if (allPostmortems.length === 0) {
      return { postmortems: [], incidentSummary: "No historical incident postmortems found in the database." };
    }

    const queryTerms = query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    // Score postmortems by query match overlap in summary and rootCause
    const scoredPostmortems = await Promise.all(
      allPostmortems.map(async (pm) => {
        let score = 0;
        const summaryLower = pm.summary.toLowerCase();
        const rootCauseLower = pm.rootCause.toLowerCase();

        // Get matching incident title
        const incident = await prisma.incident.findUnique({
          where: { id: pm.incidentId },
        });
        const titleLower = incident ? incident.title.toLowerCase() : "";

        for (const term of queryTerms) {
          if (titleLower.includes(term)) {
            score += 15;
          }
          if (rootCauseLower.includes(term)) {
            score += 8;
          }
          if (summaryLower.includes(term)) {
            score += 4;
          }
        }

        return { pm, incident, score };
      })
    );

    let results = scoredPostmortems;
    if (queryTerms.length > 0) {
      results = scoredPostmortems.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    }

    const topPostmortems = results.slice(0, limit);

    if (topPostmortems.length > 0) {
      for (const item of topPostmortems) {
        const title = item.incident ? item.incident.title : `Incident ${item.pm.incidentId}`;
        summaryLines.push(`#### Historical Incident: ${title}`);
        summaryLines.push(`- **Root Cause**: ${item.pm.rootCause}`);
        summaryLines.push(`- **Summary**: ${item.pm.summary}`);

        let actionsStr = "";
        try {
          const actions = typeof item.pm.actions === "string" ? JSON.parse(item.pm.actions) : item.pm.actions;
          if (Array.isArray(actions)) {
            actionsStr = actions.map((a: any) => `- ${a.description || a}`).join("\n");
          }
        } catch {
          // ignore
        }

        if (actionsStr) {
          summaryLines.push(`- **Remediation Actions Taken**:\n${actionsStr}`);
        }
      }
    } else {
      summaryLines.push("No highly similar past incidents or postmortems matched the query.");
    }

    return {
      postmortems: topPostmortems.map((t) => ({ ...t.pm, title: t.incident?.title })),
      incidentSummary: summaryLines.join("\n"),
    };
  }
}
