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

    // 3. Find match start nodes and compute initial scores
    const queryTerms = getTerms(query);
    const nodeScores = new Map<string, number>();

    for (const node of nodes) {
      const nodeNameLower = node.name.toLowerCase();
      const nodeTypeLower = node.type.toLowerCase();
      const metadataStr = JSON.stringify(node.metadata || "").toLowerCase();

      let score = 0;
      if (queryTerms.length > 0) {
        for (const term of queryTerms) {
          if (nodeNameLower === term) {
            score += 2.0;
          } else if (nodeNameLower.includes(term)) {
            score += 1.0;
          }
          if (nodeTypeLower.includes(term)) {
            score += 0.5;
          }
          if (metadataStr.includes(term)) {
            score += 0.3;
          }
        }
      }
      if (score > 0) {
        nodeScores.set(node.id, score);
      }
    }

    // If no node matches query terms, use all services/databases/queues as starting points
    if (nodeScores.size === 0) {
      for (const node of nodes) {
        if (["service", "database", "queue/topic/event", "external SDK"].includes(node.type)) {
          nodeScores.set(node.id, 0.1);
        }
      }
    }

    // 4. Traverse neighbors (1-hop inbound and outbound) and propagate scores
    const activeNodeIds = new Set<string>(nodeScores.keys());
    const activeEdges: typeof edges = [];

    for (const edge of edges) {
      const hasSrc = nodeScores.has(edge.source);
      const hasTgt = nodeScores.has(edge.target);
      if (hasSrc || hasTgt) {
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
        activeEdges.push(edge);

        // Propagate score to the neighbor
        if (hasSrc && !hasTgt) {
          const propagated = (nodeScores.get(edge.source) || 0) * 0.5;
          nodeScores.set(edge.target, Math.max(nodeScores.get(edge.target) || 0, propagated));
        } else if (hasTgt && !hasSrc) {
          const propagated = (nodeScores.get(edge.target) || 0) * 0.5;
          nodeScores.set(edge.source, Math.max(nodeScores.get(edge.source) || 0, propagated));
        }
      }
    }

    // Filter and sort active nodes by score descending
    const activeNodes = nodes
      .filter((n) => activeNodeIds.has(n.id))
      .map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        metadata: n.metadata,
        score: nodeScores.get(n.id) || 0,
      }))
      .sort((a, b) => b.score - a.score);

    // 5. Construct a textual summary of paths and evidence
    const summaryLines: string[] = [];
    summaryLines.push("### Architecture Subgraph (GraphRAG Context)");
    summaryLines.push("#### Nodes:");
    for (const node of activeNodes) {
      summaryLines.push(`- **${node.name}** (Type: \`${node.type}\`, ID: \`${node.id}\`, Score: ${node.score.toFixed(2)})`);
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
      nodes: activeNodes,
      edges: activeEdges.map((e) => ({ source: e.source, target: e.target, type: e.type, evidence: e.evidence })),
      pathsSummary: summaryLines.join("\n"),
    };
  }
}
