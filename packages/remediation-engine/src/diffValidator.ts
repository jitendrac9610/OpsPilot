import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PatchFileInput {
  path: string;
  diff: string;
  originalHash?: string | null;
}

export interface DiffPolicy {
  repositoryRoot?: string;
  maxFiles?: number;
  maxDiffBytes?: number;
  maxChangedLines?: number;
  forbiddenPathPatterns?: RegExp[];
}

export interface DiffValidationResult {
  ok: boolean;
  errors: string[];
  changedFiles: string[];
  totalDiffBytes: number;
  totalChangedLines: number;
}

const DEFAULT_FORBIDDEN = [
  /^\.git(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/
];

export function validatePatchFiles(
  files: PatchFileInput[],
  policy: DiffPolicy = {}
): DiffValidationResult {
  const errors: string[] = [];
  const changedFiles = new Set<string>();
  const maxFiles = policy.maxFiles ?? 10;
  const maxDiffBytes = policy.maxDiffBytes ?? 100 * 1024;
  const maxChangedLines = policy.maxChangedLines ?? 500;
  const forbidden = [...DEFAULT_FORBIDDEN, ...(policy.forbiddenPathPatterns || [])];
  const repositoryRoot = policy.repositoryRoot ? path.resolve(policy.repositoryRoot) : undefined;
  const repositoryRealRoot = repositoryRoot && fs.existsSync(repositoryRoot)
    ? fs.realpathSync(repositoryRoot)
    : repositoryRoot;

  if (files.length === 0) {
    errors.push("PATCH_EMPTY: no files were included in the changeset.");
  }
  if (files.length > maxFiles) {
    errors.push(`PATCH_FILE_LIMIT_EXCEEDED: ${files.length} files exceeds limit ${maxFiles}.`);
  }

  let totalDiffBytes = 0;
  let totalChangedLines = 0;

  for (const file of files) {
    const normalizedPath = normalizeRepoPath(file.path);
    totalDiffBytes += Buffer.byteLength(file.diff, "utf8");
    totalChangedLines += countChangedLines(file.diff);

    if (!normalizedPath) {
      errors.push(`PATCH_PATH_INVALID: ${file.path}`);
      continue;
    }
    changedFiles.add(normalizedPath);

    if (!isUnifiedDiff(file.diff)) {
      errors.push(`PATCH_NOT_UNIFIED_DIFF: ${normalizedPath}`);
    }

    for (const pattern of forbidden) {
      if (pattern.test(normalizedPath)) {
        errors.push(`PATCH_FORBIDDEN_PATH: ${normalizedPath}`);
      }
    }

    const diffPaths = extractDiffPaths(file.diff);
    if (diffPaths.length > 0 && !diffPaths.includes(normalizedPath)) {
      errors.push(`PATCH_PATH_MISMATCH: changeset path ${normalizedPath} is not present in its diff headers.`);
    }

    if (repositoryRoot && repositoryRealRoot) {
      const absolutePath = path.resolve(repositoryRoot, ...normalizedPath.split("/"));
      if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`) && absolutePath !== repositoryRoot) {
        errors.push(`PATCH_PATH_TRAVERSAL: ${normalizedPath}`);
      } else if (!fs.existsSync(absolutePath)) {
        errors.push(`PATCH_TARGET_MISSING: ${normalizedPath}`);
      } else {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          errors.push(`PATCH_TARGET_SYMLINK: ${normalizedPath}`);
        } else {
          const realPath = fs.realpathSync(absolutePath);
          if (!realPath.startsWith(`${repositoryRealRoot}${path.sep}`) && realPath !== repositoryRealRoot) {
            errors.push(`PATCH_SYMLINK_ESCAPE: ${normalizedPath}`);
          }
          if (file.originalHash) {
            const actualHash = sha256File(absolutePath);
            if (actualHash !== file.originalHash) {
              errors.push(`PATCH_ORIGINAL_HASH_MISMATCH: ${normalizedPath}`);
            }
          }
        }
      }
    }
  }

  if (totalDiffBytes > maxDiffBytes) {
    errors.push(`PATCH_DIFF_SIZE_EXCEEDED: ${totalDiffBytes} bytes exceeds limit ${maxDiffBytes}.`);
  }
  if (totalChangedLines > maxChangedLines) {
    errors.push(`PATCH_CHANGED_LINE_LIMIT_EXCEEDED: ${totalChangedLines} lines exceeds limit ${maxChangedLines}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    changedFiles: [...changedFiles],
    totalDiffBytes,
    totalChangedLines
  };
}

export function assertValidPatchFiles(files: PatchFileInput[], policy: DiffPolicy = {}): DiffValidationResult {
  const result = validatePatchFiles(files, policy);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result;
}

export function isUnifiedDiff(diff: string): boolean {
  return /^---\s+/m.test(diff) && /^\+\+\+\s+/m.test(diff) && /^@@\s+/m.test(diff);
}

export function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    const rawPath = line.slice(4).trim().split(/\s+/)[0];
    if (!rawPath || rawPath === "/dev/null") continue;
    const withoutPrefix = rawPath.replace(/^[ab]\//, "");
    const normalized = normalizeRepoPath(withoutPrefix);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

export function countChangedLines(diff: string): number {
  return diff
    .split(/\r?\n/)
    .filter((line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    )
    .length;
}

export function normalizeRepoPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || path.isAbsolute(filePath)) return undefined;
  if (normalized.split("/").some((part) => part === "..")) return undefined;
  return normalized;
}

function sha256File(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}
