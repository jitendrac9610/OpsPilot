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

export const IdentityRelationSchema = z.object({
  target: z.string(),
  type: z.enum(["owner", "non-owner", "same-tenant", "cross-tenant", "sender", "recipient", "seller", "buyer"])
});

export type IdentityRelation = z.infer<typeof IdentityRelationSchema>;

export const IdentityDefinitionSchema = z.object({
  name: z.string(),
  role: z.string().default("user"),
  relations: z.array(IdentityRelationSchema).default([]),
  credentials: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    profile: z.record(z.any()).optional()
  }).optional(),
  endpoints: z.object({
    registerPath: z.string().optional(),
    loginPath: z.string().optional()
  }).optional()
});

export type IdentityDefinition = z.infer<typeof IdentityDefinitionSchema>;

export const IdentityScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  identities: z.array(IdentityDefinitionSchema)
});

export type IdentityScenario = z.infer<typeof IdentityScenarioSchema>;

export const WebSocketEventDirectionEnum = z.enum([
  "client-to-server",
  "server-to-client"
]);

export type WebSocketEventDirection = z.infer<typeof WebSocketEventDirectionEnum>;

export const WebSocketEventSchema = z.object({
  name: z.string(),
  direction: WebSocketEventDirectionEnum,
  payload: ContractSchemaNodeSchema.optional(),
  acknowledgement: ContractSchemaNodeSchema.optional(),
  rooms: z.array(z.string()).default([]),
  source: z.object({
    file: z.string(),
    line: z.number().int().positive().optional()
  }).optional()
});

export type WebSocketEvent = z.infer<typeof WebSocketEventSchema>;

export const WebSocketContractSchema = z.object({
  id: z.string(),
  url: z.string().default("ws://localhost:4000"),
  framework: z.enum(["socket.io", "ws", "custom"]),
  namespaces: z.array(z.string()).default([]),
  middleware: z.array(z.string()).default([]),
  handshakeAuth: z.record(z.any()).default({}),
  events: z.array(WebSocketEventSchema).default([]),
  redisAdapter: z.boolean().default(false),
  source: z.object({
    file: z.string(),
    line: z.number().int().positive().optional()
  }).optional()
});

export type WebSocketContract = z.infer<typeof WebSocketContractSchema>;

export const WebhookProviderEnum = z.enum(["stripe", "razorpay", "github", "custom"]);
export type WebhookProvider = z.infer<typeof WebhookProviderEnum>;

export const WebhookContractSchema = z.object({
  id: z.string(),
  type: z.enum(["incoming", "outgoing"]),
  provider: WebhookProviderEnum,
  endpointUrl: z.string(),
  eventTypes: z.array(z.string()).default([]),
  signingSecretEnvVar: z.string().optional(),
  payloadSchema: ContractSchemaNodeSchema.optional(),
  source: z.object({
    file: z.string(),
    line: z.number().int().positive().optional()
  }).optional()
});

export type WebhookContract = z.infer<typeof WebhookContractSchema>;

export const QueueContractSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["bullmq", "redis-pubsub", "custom"]).default("bullmq"),
  producers: z.array(z.object({
    file: z.string(),
    line: z.number().int().positive().optional()
  })).default([]),
  consumers: z.array(z.object({
    file: z.string(),
    line: z.number().int().positive().optional(),
    handler: z.string().optional()
  })).default([]),
  payloadSchema: ContractSchemaNodeSchema.optional(),
  source: z.object({
    file: z.string(),
    line: z.number().int().positive().optional()
  }).optional()
});

export type QueueContract = z.infer<typeof QueueContractSchema>;

export const BrowserPageElementSchema = z.object({
  type: z.enum(["input", "button", "select", "checkbox", "link", "form", "other"]),
  selector: z.string(),
  name: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional()
});

export type BrowserPageElement = z.infer<typeof BrowserPageElementSchema>;

export const BrowserContractSchema = z.object({
  id: z.string(),
  path: z.string(),
  elements: z.array(BrowserPageElementSchema).default([]),
  source: z.object({
    file: z.string(),
    line: z.number().int().positive().optional()
  }).optional()
});

export type BrowserContract = z.infer<typeof BrowserContractSchema>;

export const EvidenceProtocolEnum = z.enum([
  "http",
  "websocket",
  "webhook",
  "queue",
  "database",
  "browser",
  "other"
]);

export type EvidenceProtocol = z.infer<typeof EvidenceProtocolEnum>;

export const EvidenceEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workflowId: z.string(),
  correlationId: z.string(),
  parentId: z.string().optional(),
  timestamp: z.string(),
  service: z.string(),
  protocol: EvidenceProtocolEnum,
  operation: z.string(),
  timing: z.number().optional(),
  success: z.boolean(),
  request: z.any().optional(),
  response: z.any().optional(),
  sourceSymbol: z.string().optional(),
  artifacts: z.record(z.any()).default({})
});

export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;





