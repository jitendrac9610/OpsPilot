import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";
import { prisma } from "@opspilot/database";
import { config, logger, storage } from "@opspilot/shared";
import {
  discoverExecutionManifest,
  ExecutionManifest,
  normalizeExecutionManifest
} from "./executionManifest.js";

interface SnapshotRecord {
  id: string;
  commitSha: string;
  archiveUrl: string;
}

interface IndexedFile {
  path: string;
  hash: string;
}

export interface WorkspaceManifest {
  sandboxId: string;
  snapshotId: string;
  commitSha: string;
  repositoryRoot: string;
  createdAt: string;
  verifiedFileCount: number;
  execution: ExecutionManifest;
}

export interface SandboxManagerOptions {
  baseDir?: string;
  loadSnapshot?: (snapshotId: string) => Promise<SnapshotRecord | null>;
  downloadSnapshot?: (archiveUrl: string) => Promise<Buffer>;
  loadIndexedFiles?: (snapshotId: string) => Promise<IndexedFile[]>;
  persistSandbox?: boolean;
}

export class SandboxProvisionError extends Error {
  constructor(
    public readonly code:
      | "SNAPSHOT_NOT_FOUND"
      | "SNAPSHOT_DOWNLOAD_FAILED"
      | "SNAPSHOT_EXTRACTION_FAILED"
      | "SNAPSHOT_VERIFICATION_FAILED"
      | "REPOSITORY_SUBDIRECTORY_NOT_FOUND",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SandboxProvisionError";
  }
}

export class SandboxManager {
  private readonly baseDir: string;
  private readonly loadSnapshot: (snapshotId: string) => Promise<SnapshotRecord | null>;
  private readonly downloadSnapshot: (archiveUrl: string) => Promise<Buffer>;
  private readonly loadIndexedFiles: (snapshotId: string) => Promise<IndexedFile[]>;
  private readonly persistSandbox: boolean;

  constructor(options: SandboxManagerOptions = {}) {
    this.baseDir = path.resolve(options.baseDir || path.join(config.tempRoot, "sandboxes"));
    this.loadSnapshot = options.loadSnapshot || ((snapshotId) =>
      prisma.repositorySnapshot.findUnique({ where: { id: snapshotId } })
    );
    this.downloadSnapshot = options.downloadSnapshot || ((archiveUrl) => storage.downloadSnapshot(archiveUrl));
    this.loadIndexedFiles = options.loadIndexedFiles || ((snapshotId) =>
      prisma.repositoryFile.findMany({
        where: { snapshotId },
        select: { path: true, hash: true }
      })
    );
    this.persistSandbox = options.persistSandbox ?? true;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  public getWorkspaceDir(sandboxId: string): string {
    return path.join(this.baseDir, sandboxId);
  }

  public getRepositoryDir(sandboxId: string): string {
    const manifest = this.getWorkspaceManifest(sandboxId);
    return manifest.repositoryRoot;
  }

  public getWorkspaceManifest(sandboxId: string): WorkspaceManifest {
    const manifestPath = path.join(this.getWorkspaceDir(sandboxId), "opspilot-workspace.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Workspace manifest not found for sandbox ${sandboxId}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorkspaceManifest;
    manifest.execution = normalizeExecutionManifest(manifest.execution);
    return manifest;
  }

  public async createSandbox(snapshotId: string): Promise<string> {
    const snapshot = await this.loadSnapshot(snapshotId);
    if (!snapshot) {
      throw new SandboxProvisionError("SNAPSHOT_NOT_FOUND", `Repository snapshot ${snapshotId} was not found.`);
    }

    const sandboxId = `sb-${crypto.randomUUID().slice(0, 12)}`;
    const workspaceDir = this.getWorkspaceDir(sandboxId);
    const extractedRepositoryDir = path.join(workspaceDir, "repository");

    logger.info({ sandboxId, workspaceDir, snapshotId }, "Provisioning sandbox from repository snapshot");
    fs.mkdirSync(workspaceDir, { recursive: true });
    await this.createSandboxRecord(sandboxId, snapshotId);

    try {
      await this.updateStatus(sandboxId, "DOWNLOADING_SNAPSHOT");

      let archive: Buffer;
      try {
        archive = await this.downloadSnapshot(snapshot.archiveUrl);
      } catch (error) {
        throw new SandboxProvisionError(
          "SNAPSHOT_DOWNLOAD_FAILED",
          `Could not download archive for snapshot ${snapshotId}.`,
          error
        );
      }

      if (archive.byteLength === 0 || archive.byteLength > config.sandbox.maxArchiveBytes) {
        throw new SandboxProvisionError(
          "SNAPSHOT_DOWNLOAD_FAILED",
          `Snapshot archive size ${archive.byteLength} is outside the allowed range.`
        );
      }

      await this.updateStatus(sandboxId, "EXTRACTING_SNAPSHOT");
      try {
        await this.extractSafely(archive, extractedRepositoryDir);
      } catch (error) {
        if (error instanceof SandboxProvisionError) throw error;
        throw new SandboxProvisionError(
          "SNAPSHOT_EXTRACTION_FAILED",
          `Could not safely extract snapshot ${snapshotId}.`,
          error
        );
      }

      await this.verifySnapshotMetadata(extractedRepositoryDir, snapshot);
      const repositoryRoot = this.resolveRepositoryRoot(extractedRepositoryDir);
      await this.updateStatus(sandboxId, "VERIFYING_SNAPSHOT");
      const verifiedFileCount = await this.verifyIndexedFiles(snapshotId, extractedRepositoryDir);
      const execution = await discoverExecutionManifest(repositoryRoot);

      const manifest: WorkspaceManifest = {
        sandboxId,
        snapshotId,
        commitSha: snapshot.commitSha,
        repositoryRoot,
        createdAt: new Date().toISOString(),
        verifiedFileCount,
        execution
      };
      await fs.promises.writeFile(
        path.join(workspaceDir, "opspilot-workspace.json"),
        JSON.stringify(manifest, null, 2),
        "utf8"
      );

      await this.updateStatus(sandboxId, "PROVISIONED");
      return sandboxId;
    } catch (error) {
      const code = error instanceof SandboxProvisionError
        ? error.code
        : "SNAPSHOT_VERIFICATION_FAILED";
      await this.updateStatus(sandboxId, code);
      await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async updateStatus(sandboxId: string, status: string) {
    logger.info({ sandboxId, status }, "Sandbox status updated");
    if (!this.persistSandbox) return;

    try {
      await prisma.sandbox.update({
        where: { id: sandboxId },
        data: { status }
      });
    } catch (error) {
      logger.error({ error, sandboxId, status }, "Failed to persist sandbox status");
      throw error;
    }
  }

  private async createSandboxRecord(sandboxId: string, snapshotId: string) {
    if (!this.persistSandbox) return;
    await prisma.sandbox.create({
      data: {
        id: sandboxId,
        snapshotId,
        status: "ALLOCATED"
      }
    });
  }

  private async extractSafely(archive: Buffer, destination: string) {
    const directory = await unzipper.Open.buffer(archive);
    if (directory.files.length > config.sandbox.maxArchiveFiles) {
      throw new SandboxProvisionError(
        "SNAPSHOT_EXTRACTION_FAILED",
        `Snapshot contains ${directory.files.length} files; limit is ${config.sandbox.maxArchiveFiles}.`
      );
    }

    const destinationRoot = path.resolve(destination);
    await fs.promises.mkdir(destinationRoot, { recursive: true });
    let extractedBytes = 0;

    for (const entry of directory.files) {
      const normalized = path.posix.normalize(entry.path.replace(/\\/g, "/"));
      if (
        normalized === "." ||
        normalized.includes("\0") ||
        normalized.startsWith("/") ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        /^[a-zA-Z]:/.test(normalized)
      ) {
        throw new SandboxProvisionError(
          "SNAPSHOT_EXTRACTION_FAILED",
          `Unsafe archive path rejected: ${entry.path}`
        );
      }

      const target = path.resolve(destinationRoot, ...normalized.split("/"));
      if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new SandboxProvisionError(
          "SNAPSHOT_EXTRACTION_FAILED",
          `Archive path escapes the workspace: ${entry.path}`
        );
      }

      if (entry.type === "Directory") {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      if (entry.type !== "File") {
        throw new SandboxProvisionError(
          "SNAPSHOT_EXTRACTION_FAILED",
          `Unsupported archive entry type for ${entry.path}.`
        );
      }

      const content = await entry.buffer();
      if (content.byteLength > config.sandbox.maxFileBytes) {
        throw new SandboxProvisionError(
          "SNAPSHOT_EXTRACTION_FAILED",
          `Archive file exceeds the per-file size limit: ${entry.path}`
        );
      }
      extractedBytes += content.byteLength;
      if (extractedBytes > config.sandbox.maxArchiveBytes) {
        throw new SandboxProvisionError(
          "SNAPSHOT_EXTRACTION_FAILED",
          "Expanded snapshot exceeds the configured size limit."
        );
      }

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, { flag: "wx" });
    }
  }

  private resolveRepositoryRoot(extractedRepositoryDir: string): string {
    const configuredSubdirectory = config.sandbox.repositorySubdirectory.trim();
    if (!configuredSubdirectory) return extractedRepositoryDir;

    const candidate = path.resolve(extractedRepositoryDir, configuredSubdirectory);
    const root = path.resolve(extractedRepositoryDir);
    if (!candidate.startsWith(`${root}${path.sep}`) || !fs.existsSync(candidate)) {
      throw new SandboxProvisionError(
        "REPOSITORY_SUBDIRECTORY_NOT_FOUND",
        `Configured repository subdirectory "${configuredSubdirectory}" was not found in the snapshot.`
      );
    }
    return candidate;
  }

  private async verifySnapshotMetadata(repositoryDir: string, snapshot: SnapshotRecord) {
    const metadataPath = path.join(repositoryDir, "opspilot-snapshot.json");
    if (!fs.existsSync(metadataPath)) {
      throw new SandboxProvisionError(
        "SNAPSHOT_VERIFICATION_FAILED",
        "Snapshot archive is missing opspilot-snapshot.json and cannot be tied to an exact commit."
      );
    }
    try {
      const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8")) as {
        commitSha?: string;
      };
      if (metadata.commitSha !== snapshot.commitSha) {
        throw new Error(`Expected ${snapshot.commitSha}, received ${metadata.commitSha || "none"}`);
      }
    } catch (error) {
      throw new SandboxProvisionError(
        "SNAPSHOT_VERIFICATION_FAILED",
        `Snapshot commit metadata does not match database commit ${snapshot.commitSha}.`,
        error
      );
    }
  }

  private async verifyIndexedFiles(snapshotId: string, repositoryRoot: string): Promise<number> {
    const indexedFiles = await this.loadIndexedFiles(snapshotId);
    let verified = 0;

    for (const indexedFile of indexedFiles) {
      const normalized = indexedFile.path.replace(/\\/g, "/");
      const absolutePath = path.resolve(repositoryRoot, ...normalized.split("/"));
      if (!absolutePath.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`) || !fs.existsSync(absolutePath)) {
        throw new SandboxProvisionError(
          "SNAPSHOT_VERIFICATION_FAILED",
          `Indexed file is missing from hydrated snapshot: ${indexedFile.path}`
        );
      }

      const actualHash = crypto
        .createHash("sha256")
        .update(await fs.promises.readFile(absolutePath))
        .digest("hex");
      if (actualHash !== indexedFile.hash) {
        throw new SandboxProvisionError(
          "SNAPSHOT_VERIFICATION_FAILED",
          `Snapshot hash mismatch for ${indexedFile.path}.`
        );
      }
      verified++;
    }

    return verified;
  }
}
