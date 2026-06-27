import { z } from "zod";

export interface SourceSymbol {
  file: string;
  functionOrClass?: string;
  lineRange?: string;
}

export interface CodeChunk {
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
}

export interface PatchContext {
  rootCause: string;
  affectedSymbols: SourceSymbol[];
  evidence: unknown[];
  relatedCodeChunks: CodeChunk[];
  failingWorkflow: unknown;
  buildError?: string;
  testError?: string;
}

export const PatchProposalSchema = z.object({
  explanation: z.string().min(1),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  files: z.array(
    z.object({
      path: z.string().min(1),
      originalHash: z.string().min(16),
      unifiedDiff: z.string().refine(
        (diff) => /^---\s+/m.test(diff) && /^\+\+\+\s+/m.test(diff) && /^@@\s+/m.test(diff),
        "files[].unifiedDiff must be a real unified diff"
      ),
      reason: z.string().min(1)
    })
  ).min(1),
  expectedBehaviorChange: z.string().min(1),
  verificationSteps: z.array(z.string().min(1)).min(1)
});

export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export class PatchProposer {
  public parseProposal(raw: unknown): PatchProposal {
    return PatchProposalSchema.parse(raw);
  }
}
