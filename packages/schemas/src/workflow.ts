import { z } from "zod";

export const AssertionTypeEnum = z.enum([
  "HTTP_RESPONSE",
  "DATABASE_STATE",
  "CACHE_STATE",
  "QUEUE_STATE",
  "PROVIDER_SDK",
  "UI_STATE"
]);

export type AssertionType = z.infer<typeof AssertionTypeEnum>;

export const AssertionSchema = z.object({
  id: z.string(),
  type: AssertionTypeEnum,
  target: z.string(),
  condition: z.string(),
  expected: z.any()
});

export type Assertion = z.infer<typeof AssertionSchema>;

export const WorkflowStepTypeEnum = z.enum([
  "CREATE_USER",
  "AUTHENTICATE",
  "HTTP_REQUEST",
  "GRAPHQL_QUERY",
  "WEBSOCKET_OPEN",
  "SIMULATE_WEBHOOK",
  "PUBLISH_EVENT",
  "WAIT_FOR_JOB",
  "BROWSER_ACTION"
]);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeEnum>;

export const WorkflowStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: WorkflowStepTypeEnum,
  config: z.record(z.any()),
  assertions: z.array(AssertionSchema).default([])
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const SyntheticWorkflowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(WorkflowStepSchema),
  cleanupSteps: z.array(WorkflowStepSchema).default([])
});

export type SyntheticWorkflow = z.infer<typeof SyntheticWorkflowSchema>;

export const WorkflowRunStatusEnum = z.enum([
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "ERROR"
]);

export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusEnum>;

export const WorkflowStepRunSchema = z.object({
  stepId: z.string(),
  status: WorkflowRunStatusEnum,
  durationMs: z.number().optional(),
  logs: z.array(z.string()).default([]),
  error: z.string().optional(),
  failedAssertionId: z.string().optional()
});

export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: WorkflowRunStatusEnum,
  startedAt: z.date(),
  completedAt: z.date().optional(),
  stepRuns: z.array(WorkflowStepRunSchema),
  correlationId: z.string()
});

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
