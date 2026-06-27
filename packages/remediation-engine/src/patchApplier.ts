import { execFileSync } from "node:child_process";
import path from "node:path";
import { assertValidPatchFiles, PatchFileInput } from "./diffValidator.js";

export interface ApplyPatchOptions {
  maxFiles?: number;
  maxDiffBytes?: number;
  maxChangedLines?: number;
}

export function applyUnifiedDiffs(
  repositoryRoot: string,
  files: PatchFileInput[],
  options: ApplyPatchOptions = {}
): { changedFiles: string[]; combinedDiff: string } {
  const root = path.resolve(repositoryRoot);
  const validation = assertValidPatchFiles(files, {
    repositoryRoot: root,
    maxFiles: options.maxFiles,
    maxDiffBytes: options.maxDiffBytes,
    maxChangedLines: options.maxChangedLines
  });
  const combinedDiff = files.map((file) => file.diff.trimEnd()).join("\n\n") + "\n";

  runGitApply(["apply", "--check", "--whitespace=nowarn", "-"], root, combinedDiff);
  runGitApply(["apply", "--whitespace=nowarn", "-"], root, combinedDiff);

  return {
    changedFiles: validation.changedFiles,
    combinedDiff
  };
}

function runGitApply(args: string[], cwd: string, input: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (err: any) {
    const stderr = err.stderr ? String(err.stderr) : "";
    const stdout = err.stdout ? String(err.stdout) : "";
    throw new Error(`Git patch command failed: git ${args.join(" ")}\n${stderr || stdout || err.message}`);
  }
}
