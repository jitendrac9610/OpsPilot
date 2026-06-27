import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CodeChunk, PatchContext, SourceSymbol } from "./proposer.js";

export interface BuildPatchContextInput {
  repositoryRoot: string;
  rootCause: string;
  affectedSymbols: SourceSymbol[];
  evidence: unknown[];
  failingWorkflow: unknown;
  buildError?: string;
  testError?: string;
  maxBytesPerFile?: number;
}

export interface CodeChunkWithHash extends CodeChunk {
  hash: string;
}

export function buildPatchContext(input: BuildPatchContextInput): PatchContext & { relatedCodeChunks: CodeChunkWithHash[] } {
  const root = path.resolve(input.repositoryRoot);
  const maxBytes = input.maxBytesPerFile ?? 32 * 1024;
  const chunks: CodeChunkWithHash[] = [];

  for (const symbol of input.affectedSymbols) {
    const normalized = symbol.file.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.split("/").includes("..")) continue;
    const absolute = path.resolve(root, ...normalized.split("/"));
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) continue;
    const content = fs.readFileSync(absolute);
    chunks.push({
      path: normalized,
      content: content.subarray(0, maxBytes).toString("utf8"),
      hash: crypto.createHash("sha256").update(content).digest("hex")
    });
  }

  return {
    rootCause: input.rootCause,
    affectedSymbols: input.affectedSymbols,
    evidence: input.evidence,
    relatedCodeChunks: chunks,
    failingWorkflow: input.failingWorkflow,
    buildError: input.buildError,
    testError: input.testError
  };
}
