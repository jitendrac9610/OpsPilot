import { z } from "zod";

export const CapabilityLevelEnum = z.enum([
  "UNSUPPORTED",
  "GENERIC",
  "SYNTAX",
  "SEMANTIC",
  "RUNTIME",
  "VERIFIED_REPAIR"
]);

export type CapabilityLevel = z.infer<typeof CapabilityLevelEnum>;

export const AdapterCategoryEnum = z.enum([
  "language",
  "framework",
  "database",
  "messaging",
  "integration",
  "build",
  "runtime",
  "deployment"
]);

export type AdapterCategory = z.infer<typeof AdapterCategoryEnum>;

export const DetectionResultSchema = z.object({
  detected: z.boolean(),
  confidence: z.number().min(0).max(1),
  version: z.string().optional(),
  reasons: z.array(z.string()),
  capabilities: z.array(z.string())
});

export type DetectionResult = z.infer<typeof DetectionResultSchema>;

export const StaticRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  description: z.string()
});

export type StaticRule = z.infer<typeof StaticRuleSchema>;

export const AgentToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.any())
});

export type AgentTool = z.infer<typeof AgentToolSchema>;

export const SandboxRequirementSchema = z.object({
  type: z.string(),
  value: z.string(),
  optional: z.boolean().default(false)
});

export type SandboxRequirement = z.infer<typeof SandboxRequirementSchema>;

export const AssertionProviderSchema = z.object({
  id: z.string(),
  type: z.string(),
  config: z.record(z.any())
});

export type AssertionProvider = z.infer<typeof AssertionProviderSchema>;

export const FailureScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string()
});

export type FailureScenario = z.infer<typeof FailureScenarioSchema>;

export const VerificationRuleSchema = z.object({
  id: z.string(),
  rule: z.string(),
  expectedResult: z.string()
});

export type VerificationRule = z.infer<typeof VerificationRuleSchema>;

export const ArchitectureContributionSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    metadata: z.record(z.any())
  })),
  edges: z.array(z.object({
    source: z.string(),
    target: z.string(),
    type: z.string(),
    evidence: z.object({
      file: z.string(),
      line: z.number()
    }).optional()
  }))
});

export type ArchitectureContribution = z.infer<typeof ArchitectureContributionSchema>;
