import { z } from "zod";

export const TelemetryContextPackageSchema = z.object({
  objective: z.string(),
  currentPlan: z.array(z.string()),
  hypotheses: z.array(z.object({
    id: z.string(),
    description: z.string(),
    confidence: z.number(),
    status: z.enum(["SUPPORTED", "CONTRADICTED", "NEUTRAL"])
  })),
  affectedNeighborhood: z.array(z.string()),
  relevantCode: z.array(z.object({
    file: z.string(),
    code: z.string()
  })),
  relevantTests: z.array(z.string()),
  runtimeEvidence: z.array(z.object({
    type: z.string(),
    payload: z.any(),
    timestamp: z.date()
  })),
  deploymentChanges: z.array(z.object({
    commitSha: z.string(),
    author: z.string(),
    message: z.string(),
    timestamp: z.date()
  })),
  sdkDocumentation: z.array(z.string()),
  previousIncidents: z.array(z.string()),
  availableTools: z.array(z.string()),
  policies: z.array(z.string()),
  budgets: z.record(z.number()),
  confidenceScore: z.number()
});

export type TelemetryContextPackage = z.infer<typeof TelemetryContextPackageSchema>;

export const LogRecordSchema = z.object({
  timestamp: z.date(),
  serviceName: z.string(),
  level: z.string(),
  message: z.string(),
  attributes: z.record(z.any()).default({}),
  traceId: z.string().optional(),
  spanId: z.string().optional()
});

export type LogRecord = z.infer<typeof LogRecordSchema>;

export const MetricDataPointSchema = z.object({
  timestamp: z.date(),
  name: z.string(),
  value: z.number(),
  labels: z.record(z.string()).default({})
});

export type MetricDataPoint = z.infer<typeof MetricDataPointSchema>;

export const SpanRecordSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  serviceName: z.string(),
  startedAt: z.date(),
  endedAt: z.date(),
  attributes: z.record(z.any()).default({}),
  events: z.array(z.object({
    name: z.string(),
    timestamp: z.date(),
    attributes: z.record(z.any()).default({})
  })).default([])
});

export type SpanRecord = z.infer<typeof SpanRecordSchema>;

export const IncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED", "ROLLED_BACK"]),
  affectedServices: z.array(z.string()),
  firstDetectedAt: z.date(),
  lastUpdatedAt: z.date(),
  timeline: z.array(z.object({
    timestamp: z.date(),
    type: z.string(),
    description: z.string(),
    referenceId: z.string().optional()
  })).default([])
});

export type Incident = z.infer<typeof IncidentSchema>;
