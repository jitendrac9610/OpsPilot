import { prisma } from "@opspilot/database";

export interface GraphRAGResult {
  nodes: Array<{ id: string; type: string; name: string; metadata: any }>;
  edges: Array<{ source: string; target: string; type: string; evidence: any }>;
  pathsSummary: string;
}

/**
 * Basic tokenizer to match query words with node names and types
 */
function getTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2); // only keep terms with length > 2
}

export class GraphStore {
  /**
   * Traverse nodes and edges for a snapshot to construct an architectural context
   */
  async searchGraph(
    query: string,
    options: { snapshotId: string }
  ): Promise<GraphRAGResult | null> {
    // 1. Get latest architecture version for snapshot
    const archVersion = await prisma.architectureVersion.findFirst({
      where: { snapshotId: options.snapshotId },
      orderBy: { createdAt: "desc" },
    });

    if (!archVersion) {
      return null;
    }

    const versionId = archVersion.id;

    // 2. Fetch all nodes and edges
    const nodes = await prisma.graphNode.findMany({ where: { versionId } });
    const edges = await prisma.graphEdge.findMany({ where: { versionId } });

    if (nodes.length === 0) {
      return { nodes: [], edges: [], pathsSummary: "" };
    }

    // 3. Find match start nodes
    const queryTerms = getTerms(query);
    const startNodeIds = new Set<string>();

    for (const node of nodes) {
      const nodeNameLower = node.name.toLowerCase();
      const nodeTypeLower = node.type.toLowerCase();
      const metadataStr = JSON.stringify(node.metadata || "").toLowerCase();

      // Direct match or term match
      if (
        queryTerms.some(
          (term) =>
            nodeNameLower.includes(term) ||
            nodeTypeLower.includes(term) ||
            metadataStr.includes(term)
        )
      ) {
        startNodeIds.add(node.id);
      }
    }

    // If no node matches query terms, use all services/databases/queues as starting points
    if (startNodeIds.size === 0) {
      for (const node of nodes) {
        if (["service", "database", "queue/topic/event", "external SDK"].includes(node.type)) {
          startNodeIds.add(node.id);
        }
      }
    }

    // 4. Traverse neighbors (1-hop inbound and outbound)
    const activeNodeIds = new Set<string>(startNodeIds);
    const activeEdges: typeof edges = [];

    for (const edge of edges) {
      if (startNodeIds.has(edge.source) || startNodeIds.has(edge.target)) {
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
        activeEdges.push(edge);
      }
    }

    const activeNodes = nodes.filter((n) => activeNodeIds.has(n.id));

    // 5. Construct a textual summary of paths and evidence
    const summaryLines: string[] = [];
    summaryLines.push("### Architecture Subgraph (GraphRAG Context)");
    summaryLines.push("#### Nodes:");
    for (const node of activeNodes) {
      summaryLines.push(`- **${node.name}** (Type: \`${node.type}\`, ID: \`${node.id}\`)`);
    }

    summaryLines.push("\n#### Key Call and Data Flow Paths:");
    const nodeMap = new Map(activeNodes.map((n) => [n.id, n]));

    for (const edge of activeEdges) {
      const srcNode = nodeMap.get(edge.source);
      const tgtNode = nodeMap.get(edge.target);
      if (srcNode && tgtNode) {
        let evidenceDesc = "";
        try {
          const evidence = typeof edge.evidence === "string" ? JSON.parse(edge.evidence) : edge.evidence;
          if (evidence?.file) {
            evidenceDesc = ` (Evidence: [${evidence.file}:${evidence.line || 1}](file:///${evidence.file.replace(/\\/g, "/")}) - ${evidence.description || ""})`;
          }
        } catch {
          // ignore parsing error
        }
        summaryLines.push(
          `- **${srcNode.name}** --[\`${edge.type}\`]--> **${tgtNode.name}**${evidenceDesc}`
        );
      }
    }

    return {
      nodes: activeNodes.map((n) => ({ id: n.id, type: n.type, name: n.name, metadata: n.metadata })),
      edges: activeEdges.map((e) => ({ source: e.source, target: e.target, type: e.type, evidence: e.evidence })),
      pathsSummary: summaryLines.join("\n"),
    };
  }
}
