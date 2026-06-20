import { z } from "zod";

export const ProductModeEnum = z.enum([
  "REPOSITORY_AUDIT",
  "RUNTIME_LAB",
  "WORKFLOW_VERIFICATION",
  "VERIFIED_REPAIR",
  "PRODUCTION_INCIDENT_RESPONSE",
  "ARCHITECTURE_EXPLORER",
  "NATURAL_LANGUAGE_ASSISTANT",
  "EVALUATION_LAB"
]);

export type ProductMode = z.infer<typeof ProductModeEnum>;

export const ProductModeConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().default(true)
});

export type ProductModeConfig = z.infer<typeof ProductModeConfigSchema>;
