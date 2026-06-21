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

export const ContractSchemaTypeEnum = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
  "file",
  "null",
  "unknown"
]);

export type ContractSchemaType = z.infer<typeof ContractSchemaTypeEnum>;

export interface ContractSchemaNode {
  type?: ContractSchemaType;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  required?: string[];
  properties?: Record<string, ContractSchemaNode>;
  items?: ContractSchemaNode;
  oneOf?: ContractSchemaNode[];
  anyOf?: ContractSchemaNode[];
  allOf?: ContractSchemaNode[];
  ref?: string;
  source?: string;
}

export const ContractSchemaNodeSchema: z.ZodType<ContractSchemaNode> = z.lazy(() => z.object({
  type: ContractSchemaTypeEnum.optional(),
  format: z.string().optional(),
  description: z.string().optional(),
  nullable: z.boolean().optional(),
  enum: z.array(z.unknown()).optional(),
  const: z.unknown().optional(),
  default: z.unknown().optional(),
  example: z.unknown().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  pattern: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(ContractSchemaNodeSchema).optional(),
  items: ContractSchemaNodeSchema.optional(),
  oneOf: z.array(ContractSchemaNodeSchema).optional(),
  anyOf: z.array(ContractSchemaNodeSchema).optional(),
  allOf: z.array(ContractSchemaNodeSchema).optional(),
  ref: z.string().optional(),
  source: z.string().optional()
}));

export const EndpointParameterLocationEnum = z.enum([
  "path",
  "query",
  "header",
  "cookie"
]);

export const EndpointParameterSchema = z.object({
  name: z.string(),
  in: EndpointParameterLocationEnum,
  required: z.boolean(),
  description: z.string().optional(),
  schema: ContractSchemaNodeSchema,
  source: z.string()
});

export type EndpointParameter = z.infer<typeof EndpointParameterSchema>;

export const RequestBodyContractSchema = z.object({
  required: z.boolean(),
  content: z.record(ContractSchemaNodeSchema),
  source: z.string()
});

export type RequestBodyContract = z.infer<typeof RequestBodyContractSchema>;

export const ResponseContractSchema = z.object({
  status: z.string(),
  description: z.string().optional(),
  headers: z.record(ContractSchemaNodeSchema).default({}),
  content: z.record(ContractSchemaNodeSchema).default({})
});

export type ResponseContract = z.infer<typeof ResponseContractSchema>;

export const EndpointSecuritySchema = z.object({
  scheme: z.string(),
  type: z.enum(["bearer", "apiKey", "basic", "oauth2", "cookie", "session", "custom"]),
  in: EndpointParameterLocationEnum.optional(),
  name: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  source: z.string()
});

export type EndpointSecurity = z.infer<typeof EndpointSecuritySchema>;

export const EndpointMiddlewareSchema = z.object({
  name: z.string(),
  kind: z.enum(["authentication", "authorization", "validation", "other"]),
  source: z.string(),
  configuration: z.record(z.unknown()).default({})
});

export type EndpointMiddleware = z.infer<typeof EndpointMiddlewareSchema>;

export const PrismaRequirementSchema = z.object({
  model: z.string(),
  operation: z.string(),
  relations: z.array(z.string()).default([]),
  source: z.string()
});

export type PrismaRequirement = z.infer<typeof PrismaRequirementSchema>;

export const EndpointContractSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  framework: z.enum(["openapi", "express", "next-app", "next-pages"]),
  source: z.object({
    file: z.string(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional()
  }),
  summary: z.string().optional(),
  operationId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  parameters: z.array(EndpointParameterSchema).default([]),
  requestBody: RequestBodyContractSchema.optional(),
  responses: z.array(ResponseContractSchema).default([]),
  security: z.array(EndpointSecuritySchema).default([]),
  middleware: z.array(EndpointMiddlewareSchema).default([]),
  requiredEnvironment: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  prisma: z.array(PrismaRequirementSchema).default([]),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1)
});

export type EndpointContract = z.infer<typeof EndpointContractSchema>;

export const HTTPWorkflowConfigSchema = z.object({
  method: z.string(),
  url: z.string(),
  expectedStatus: z.number().int().optional(),
  contract: EndpointContractSchema.optional()
});

export type HTTPWorkflowConfig = z.infer<typeof HTTPWorkflowConfigSchema>;

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
