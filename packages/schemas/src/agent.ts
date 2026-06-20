import { z } from "zod";

export const AgentStateEnum = z.enum([
  "CREATED",
  "DISCOVERING",
  "INDEXING",
  "PLANNING",
  "RETRIEVING",
  "GENERATING_WORKFLOW",
  "EXECUTING_WORKFLOW",
  "LOCALIZING_FAILURE",
  "INVESTIGATING",
  "DIAGNOSING",
  "REPRODUCING",
  "PROPOSING_FIX",
  "APPLYING_SANDBOX_CHANGE",
  "VERIFYING_FIX",
  "AWAITING_APPROVAL",
  "APPLYING_APPROVED_ACTION",
  "MONITORING_RECOVERY",
  "COMPLETED",
  "ROLLED_BACK",
  "NEEDS_HUMAN"
]);

export type AgentState = z.infer<typeof AgentStateEnum>;

export const RetryClassificationEnum = z.enum([
  "TRANSIENT",
  "RATE_LIMITED",
  "TIMEOUT",
  "DEPENDENCY_UNAVAILABLE",
  "INVALID_INPUT",
  "AUTHORIZATION_FAILED",
  "POLICY_DENIED",
  "NON_IDEMPOTENT_RISK",
  "UNSUPPORTED",
  "PERMANENT"
]);

export type RetryClassification = z.infer<typeof RetryClassificationEnum>;

export const AgentDecisionSchema = z.union([
  z.object({ type: z.literal("retrieve"), request: z.record(z.any()) }),
  z.object({ type: z.literal("call_tool"), tool: z.string(), arguments: z.any() }),
  z.object({ type: z.literal("update_hypotheses"), updates: z.array(z.record(z.any())) }),
  z.object({ type: z.literal("replan"), reason: z.string() }),
  z.object({ type: z.literal("propose_change"), plan: z.record(z.any()) }),
  z.object({ type: z.literal("request_approval"), approval: z.record(z.any()) }),
  z.object({ type: z.literal("complete"), conclusion: z.record(z.any()) }),
  z.object({ type: z.literal("needs_human"), missingEvidence: z.array(z.string()) })
]);

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const DiagnosisSchema = z.object({
  failedStage: z.string(),
  probableRootCause: z.string(),
  confidence: z.number().min(0).max(100),
  supportingEvidence: z.array(z.string()),
  contradictingEvidence: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  affectedFiles: z.array(z.string()),
  affectedServices: z.array(z.string()),
  architecturePath: z.array(z.string()),
  userImpact: z.string(),
  reproductionResult: z.string(),
  recommendedCorrection: z.string()
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const ApprovalCardSchema = z.object({
  id: z.string(),
  problem: z.string(),
  filesChanged: z.number(),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  verification: z.object({
    originalFailureReproduced: z.boolean(),
    buildPassed: z.boolean(),
    workflowPassed: z.boolean(),
    regressionTestsPassedCount: z.number(),
    securityRegressionDetected: z.boolean()
  }),
  actions: z.array(z.enum(["REVIEW_DIFF", "APPROVE_AND_PR", "REJECT"]))
});

export type ApprovalCard = z.infer<typeof ApprovalCardSchema>;
