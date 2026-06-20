import { z } from "zod";

export const GraphNodeTypeEnum = z.enum([
  "application",
  "service",
  "package",
  "file",
  "symbol",
  "route",
  "database",
  "table/collection",
  "queue/topic/event",
  "worker/background job",
  "cache",
  "external SDK",
  "webhook",
  "Docker container",
  "Kubernetes resource",
  "deployment",
  "secret/configuration"
]);

export type GraphNodeType = z.infer<typeof GraphNodeTypeEnum>;

export const GraphEdgeTypeEnum = z.enum([
  "IMPORTS",
  "CALLS",
  "DEPENDS_ON",
  "READS_FROM",
  "WRITES_TO",
  "QUERIES",
  "PUBLISHES_TO",
  "CONSUMES_FROM",
  "TRIGGERS",
  "AUTHENTICATES_WITH",
  "CALLS_EXTERNAL",
  "RECEIVES_WEBHOOK_FROM",
  "GENERATES_TOKEN_FOR",
  "USES_SECRET",
  "DEPLOYED_AS",
  "RUNS_IN",
  "CONFIGURED_BY",
  "INVALIDATES"
]);

export type GraphEdgeType = z.infer<typeof GraphEdgeTypeEnum>;

export const SemanticChunkTypeEnum = z.enum([
  "function",
  "method",
  "class",
  "interface",
  "component",
  "API route",
  "middleware",
  "database query",
  "queue producer",
  "queue consumer",
  "Inngest function",
  "webhook",
  "Docker service",
  "Kubernetes resource",
  "test suite"
]);

export type SemanticChunkType = z.infer<typeof SemanticChunkTypeEnum>;

export const RepositoryHierarchySchema = z.object({
  repositoryId: z.string(),
  workspace: z.string(),
  application: z.string().optional(),
  service: z.string().optional(),
  package: z.string().optional(),
  file: z.string(),
  symbol: z.string().optional()
});

export type RepositoryHierarchy = z.infer<typeof RepositoryHierarchySchema>;

export const GraphEdgeEvidenceSchema = z.object({
  file: z.string(),
  line: z.number(),
  snippet: z.string().optional()
});

export type GraphEdgeEvidence = z.infer<typeof GraphEdgeEvidenceSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  type: GraphNodeTypeEnum,
  name: z.string(),
  metadata: z.record(z.any()).default({})
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: GraphEdgeTypeEnum,
  evidence: z.array(GraphEdgeEvidenceSchema).default([])
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
