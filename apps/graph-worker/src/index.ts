import express, { Request, Response, NextFunction } from "express";
import { logger, EventBus, generateId, generateCorrelationId, generateIdempotencyKey, OpsPilotError } from "@opspilot/shared";
import { prisma } from "@opspilot/database";
import { buildArchitectureGraph } from "@opspilot/repository-intelligence";

const app = express();
app.use(express.json());

app.post("/graph", async (req: Request, res: Response, next: NextFunction) => {
  const { repositoryId, commitSha, snapshotId, projectRoot, files } = req.body;
  if (!repositoryId || !commitSha || !snapshotId || !projectRoot || !files) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: "repositoryId, commitSha, snapshotId, projectRoot, and files are required" });
  }

  logger.info({ repositoryId, commitSha, snapshotId }, "Starting architecture graph generation");

  try {
    // 1. Create ArchitectureVersion record
    const archVersion = await prisma.architectureVersion.create({
      data: {
        snapshotId
      }
    });

    // 2. Build Graph nodes & edges
    const graph = buildArchitectureGraph(projectRoot, snapshotId, files);

    // 3. Persist GraphNodes
    for (const node of graph.nodes) {
      await prisma.graphNode.create({
        data: {
          id: `${archVersion.id}_${node.id}`,
          versionId: archVersion.id,
          type: node.type,
          name: node.name,
          metadata: node.metadata || {}
        }
      });
    }

    // 4. Persist GraphEdges
    for (const edge of graph.edges) {
      await prisma.graphEdge.create({
        data: {
          id: `${archVersion.id}_${edge.id}`,
          versionId: archVersion.id,
          source: `${archVersion.id}_${edge.source}`,
          target: `${archVersion.id}_${edge.target}`,
          type: edge.type,
          evidence: edge.evidence || {}
        }
      });
    }

    // 5. Compute Architecture Diffs between commits
    const snapshots = await prisma.repositorySnapshot.findMany({
      where: { repositoryId }
    });
    const snapshotIds = snapshots.map(s => s.id).filter(id => id !== snapshotId);

    const prevVersion = await prisma.architectureVersion.findFirst({
      where: { snapshotId: { in: snapshotIds } },
      orderBy: { createdAt: "desc" }
    });

    let diff = {
      addedNodes: [] as string[],
      removedNodes: [] as string[],
      addedEdges: [] as string[],
      removedEdges: [] as string[]
    };

    if (prevVersion) {
      const prevNodes = await prisma.graphNode.findMany({ where: { versionId: prevVersion.id } });
      const prevEdges = await prisma.graphEdge.findMany({ where: { versionId: prevVersion.id } });

      const oldNodeIds = new Set(prevNodes.map(n => n.id.substring(prevVersion.id.length + 1)));
      const newNodeIds = new Set(graph.nodes.map(n => n.id));

      const added = graph.nodes.filter(n => !oldNodeIds.has(n.id)).map(n => n.name);
      const removed = prevNodes.filter(n => !newNodeIds.has(n.id.substring(prevVersion.id.length + 1))).map(n => n.name);

      const oldEdgeIds = new Set(prevEdges.map(e => e.id.substring(prevVersion.id.length + 1)));
      const newEdgeIds = new Set(graph.edges.map(e => e.id));
      const addedE = graph.edges.filter(e => !oldEdgeIds.has(e.id)).map(e => `${e.source} -[${e.type}]-> ${e.target}`);
      const removedE = prevEdges.filter(e => !newEdgeIds.has(e.id.substring(prevVersion.id.length + 1))).map(e => {
        const src = e.source.substring(prevVersion.id.length + 1);
        const tgt = e.target.substring(prevVersion.id.length + 1);
        return `${src} -[${e.type}]-> ${tgt}`;
      });

      diff = {
        addedNodes: added,
        removedNodes: removed,
        addedEdges: addedE,
        removedEdges: removedE
      };

      logger.info({ diff }, "Architecture diff completed");

      // Save diff as an AuditLog entry
      await prisma.auditLog.create({
        data: {
          orgId: "system",
          action: "repository.architecture.diff",
          payload: {
            repositoryId,
            commitSha,
            addedNodes: added,
            removedNodes: removed,
            addedEdges: addedE,
            removedEdges: removedE
          }
        }
      });
    }

    // 6. Emit `architecture.generated` System Event
    await EventBus.publish({
      id: generateId("evt"),
      name: "architecture.generated",
      organizationId: "system",
      projectId: "system",
      environment: "development",
      sourceEntity: "graph-worker",
      commitSha,
      correlationId: generateCorrelationId(),
      idempotencyKey: generateIdempotencyKey(),
      timestamp: new Date().toISOString(),
      data: {
        repositoryId,
        commitSha,
        architectureVersionId: archVersion.id,
        nodesCount: graph.nodes.length,
        edgesCount: graph.edges.length,
        diff
      }
    });

    // 7. Emit `indexing.completed` System Event
    await EventBus.publish({
      id: generateId("evt"),
      name: "indexing.completed",
      organizationId: "system",
      projectId: "system",
      environment: "development",
      sourceEntity: "graph-worker",
      commitSha,
      correlationId: generateCorrelationId(),
      idempotencyKey: generateIdempotencyKey(),
      timestamp: new Date().toISOString(),
      data: {
        repositoryId,
        commitSha,
        snapshotId
      }
    });

    logger.info({ architectureVersionId: archVersion.id }, "Architecture graph generated and persisted successfully");
    res.status(200).json({ status: "success", nodesCount: graph.nodes.length, edgesCount: graph.edges.length });
  } catch (err: any) {
    logger.error({ err, repositoryId }, "Graph generation failed");
    next(err);
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "Graph Worker error");
  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});

const port = 4004;
app.listen(port, () => {
  logger.info(`OpsPilot Graph Worker listening on port ${port}`);
});
