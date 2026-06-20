import { prisma } from "@opspilot/database";

export interface ProjectRAGResult {
  memories: any[];
  projectSummary: string;
}

export class ProjectStore {
  /**
   * Queries MemoryRecord table for runbooks, coding conventions, and operational command policies.
   */
  async searchProjectKnowledge(
    query: string,
    options: { limit?: number }
  ): Promise<ProjectRAGResult> {
    const limit = options.limit ?? 3;
    const summaryLines: string[] = [];

    summaryLines.push("### Project & Team Operational Knowledge Context");

    // Fetch project and policy memory records
    const records = await prisma.memoryRecord.findMany({
      where: {
        type: { in: ["project", "policy"] },
      },
    });

    if (records.length === 0) {
      return { memories: [], projectSummary: "No team runbooks or operational policy records found." };
    }

    const queryTerms = query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scoredRecords = records.map((record) => {
      let score = 0;
      const contentStr = JSON.stringify(record.content || "").toLowerCase();

      for (const term of queryTerms) {
        // Count content matches
        const regex = new RegExp(term, "g");
        const count = (contentStr.match(regex) || []).length;
        score += count * 2;
      }

      return { record, score };
    });

    let results = scoredRecords;
    if (queryTerms.length > 0) {
      results = scoredRecords.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    }

    const topRecords = results.slice(0, limit).map((r) => r.record);

    if (topRecords.length > 0) {
      for (const record of topRecords) {
        summaryLines.push(`#### Record ID: \`${record.id}\` (Type: \`${record.type}\`)`);
        
        let contentDisplay = "";
        try {
          const content = typeof record.content === "string" ? JSON.parse(record.content) : record.content;
          if (content.title || content.description) {
            contentDisplay = `Title: ${content.title || ""}\nDescription: ${content.description || ""}`;
          } else {
            contentDisplay = JSON.stringify(content, null, 2);
          }
        } catch {
          contentDisplay = JSON.stringify(record.content);
        }
        
        summaryLines.push("```json");
        summaryLines.push(contentDisplay);
        summaryLines.push("```");
      }
    } else {
      summaryLines.push("No highly relevant project runbooks or operational policies matched the query.");
    }

    return {
      memories: topRecords,
      projectSummary: summaryLines.join("\n"),
    };
  }
}
