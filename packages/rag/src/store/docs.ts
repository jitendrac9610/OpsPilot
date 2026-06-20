import { prisma } from "@opspilot/database";

export interface DocsRAGResult {
  documents: Array<{ id: string; name: string; version: string; url: string; content: string }>;
  docsSummary: string;
}

export class DocsStore {
  /**
   * Queries DocumentationSource table for version-aware SDK and API references matching the query.
   */
  async searchDocs(
    query: string,
    options: { limit?: number }
  ): Promise<DocsRAGResult> {
    const limit = options.limit ?? 3;
    const summaryLines: string[] = [];

    summaryLines.push("### Official SDK & API Documentation Context");

    // Fetch all documentation sources to score/filter locally
    const allDocs = await prisma.documentationSource.findMany();

    if (allDocs.length === 0) {
      return { documents: [], docsSummary: "No documentation sources found in the database." };
    }

    const queryTerms = query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scoredDocs = allDocs.map((doc) => {
      let score = 0;
      const nameLower = doc.name.toLowerCase();
      const contentLower = doc.content.toLowerCase();

      // Give higher weight to matches in the name/title of the documentation
      for (const term of queryTerms) {
        if (nameLower.includes(term)) {
          score += 10;
        }
        // Count content matches
        const regex = new RegExp(term, "g");
        const count = (contentLower.match(regex) || []).length;
        score += count * 0.5;
      }

      return { doc, score };
    });

    // Sort by score descending and filter out zero-scores if query terms existed
    let results = scoredDocs;
    if (queryTerms.length > 0) {
      results = scoredDocs.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    }

    const topDocs = results.slice(0, limit).map((r) => r.doc);

    if (topDocs.length > 0) {
      for (const doc of topDocs) {
        summaryLines.push(`#### Doc Source: ${doc.name} (v${doc.version})`);
        summaryLines.push(`Source URL: ${doc.url}`);
        // Truncate content snippet to keep context size manageable (first 400 chars)
        const snippet = doc.content.length > 400 ? `${doc.content.substring(0, 400)}...` : doc.content;
        summaryLines.push("```markdown");
        summaryLines.push(snippet);
        summaryLines.push("```");
      }
    } else {
      summaryLines.push("No highly relevant framework or SDK documentation matched the search query.");
    }

    return {
      documents: topDocs.map((d) => ({ id: d.id, name: d.name, version: d.version, url: d.url, content: d.content })),
      docsSummary: summaryLines.join("\n"),
    };
  }
}
