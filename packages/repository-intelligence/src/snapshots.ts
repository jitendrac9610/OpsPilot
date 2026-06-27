import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { spawn } from "child_process";
import archiver from "archiver";
import { prisma } from "@opspilot/database";
import {
  config,
  EventBus,
  generateCorrelationId,
  generateId,
  generateIdempotencyKey,
  logger,
  storage
} from "@opspilot/shared";

export interface CommitSnapshotInput {
  repositoryId: string;
  gitUrl: string;
  commitSha: string;
  branch?: string;
  source?: string;
}

export interface CommitSnapshotResult {
  snapshotId: string;
  archiveUrl: string;
  archiveHash: string;
  commitSha: string;
}

export async function resolveRemoteHeadSha(gitUrl: string, branch: string): Promise<string> {
  if (isMockGitUrl(gitUrl)) {
    return `mock_commit_${Date.now()}`;
  }

  return await runGitForOutput(["ls-remote", gitUrl, branch], "git ls-remote");
}

export async function createCommitSnapshot(input: CommitSnapshotInput): Promise<CommitSnapshotResult> {
  const branch = input.branch ?? "main";
  const source = input.source ?? "git";
  const tempDir = path.join(config.tempRoot, `clone_${generateId()}`);
  const zipPath = `${tempDir}.zip`;

  logger.info(
    {
      repositoryId: input.repositoryId,
      gitUrl: input.gitUrl,
      commitSha: input.commitSha,
      branch
    },
    "Creating exact repository commit snapshot"
  );

  const existingSnapshot = await prisma.repositorySnapshot.findUnique({
    where: {
      repositoryId_commitSha: {
        repositoryId: input.repositoryId,
        commitSha: input.commitSha
      }
    }
  });

  if (existingSnapshot?.status === "READY") {
    await publishSnapshotCreated({
      snapshotId: existingSnapshot.id,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      archiveUrl: existingSnapshot.archiveUrl
    });

    return {
      snapshotId: existingSnapshot.id,
      archiveUrl: existingSnapshot.archiveUrl,
      archiveHash: existingSnapshot.archiveHash,
      commitSha: existingSnapshot.commitSha
    };
  }

  let snapshotId = existingSnapshot?.id;

  try {
    await fs.promises.mkdir(tempDir, { recursive: true });

    if (config.isDemoMode && isMockGitUrl(input.gitUrl)) {
      await copySeededRepository(tempDir);
    } else {
      if (isMockGitUrl(input.gitUrl)) {
        throw new Error("Mock repositories are available only when OPSPILOT_MODE=demo.");
      }
      await runGit(["clone", "--no-checkout", "--filter=blob:none", input.gitUrl, tempDir]);
      await runGit(["-C", tempDir, "fetch", "--depth", "1", "origin", input.commitSha]);
      await runGit(["-C", tempDir, "checkout", "--detach", input.commitSha]);
    }

    await fs.promises.writeFile(
      path.join(tempDir, "opspilot-snapshot.json"),
      JSON.stringify(
        {
          repositoryId: input.repositoryId,
          commitSha: input.commitSha,
          branch,
          source,
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );

    await zipDirectory(tempDir, zipPath);
    const zipBuffer = await fs.promises.readFile(zipPath);
    const archiveHash = crypto.createHash("sha256").update(zipBuffer).digest("hex");
    const filename = `${input.repositoryId}_${input.commitSha}.zip`;
    const archiveUrl = await storage.uploadSnapshot(filename, zipBuffer);

    const snapshot = await prisma.repositorySnapshot.upsert({
      where: {
        repositoryId_commitSha: {
          repositoryId: input.repositoryId,
          commitSha: input.commitSha
        }
      },
      update: {
        archiveUrl,
        archiveHash,
        source,
        status: "READY",
        errorMessage: null
      },
      create: {
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        archiveUrl,
        archiveHash,
        source,
        status: "READY"
      }
    });
    snapshotId = snapshot.id;

    await publishSnapshotCreated({
      snapshotId: snapshot.id,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      archiveUrl
    });

    fetch(`${config.services.discoveryWorkerUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        archiveUrl
      })
    }).catch(err => logger.error({ err }, "Failed to trigger discovery-worker"));

    fetch(`${config.services.indexerWorkerUrl}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        archiveUrl
      })
    }).catch(err => logger.error({ err }, "Failed to trigger indexer-worker"));

    logger.info({ snapshotId: snapshot.id, archiveUrl, archiveHash }, "Repository snapshot archive created");
    return {
      snapshotId: snapshot.id,
      archiveUrl,
      archiveHash,
      commitSha: input.commitSha
    };
  } catch (err: any) {
    logger.error({ err, repositoryId: input.repositoryId }, "Snapshot generation failed");

    if (snapshotId) {
      await prisma.repositorySnapshot.update({
        where: { id: snapshotId },
        data: {
          status: "FAILED",
          errorMessage: err.message
        }
      }).catch(() => undefined);
    } else {
      await prisma.repositorySnapshot.create({
        data: {
          repositoryId: input.repositoryId,
          commitSha: input.commitSha,
          archiveUrl: "",
          archiveHash: "",
          source,
          status: "FAILED",
          errorMessage: err.message
        }
      }).catch(() => undefined);
    }

    throw err;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.unlink(zipPath).catch(() => undefined);
  }
}

async function publishSnapshotCreated(event: {
  snapshotId: string;
  repositoryId: string;
  commitSha: string;
  archiveUrl: string;
}): Promise<void> {
  await EventBus.publish({
    id: generateId("evt"),
    name: "repository.snapshot.created",
    organizationId: "system",
    projectId: "system",
    environment: "development",
    sourceEntity: "repository-intelligence",
    commitSha: event.commitSha,
    correlationId: generateCorrelationId(),
    idempotencyKey: generateIdempotencyKey(),
    timestamp: new Date().toISOString(),
    data: event
  });
}

function isMockGitUrl(gitUrl: string): boolean {
  return gitUrl.startsWith("mock_") || gitUrl.includes("mock-repo");
}

async function copySeededRepository(tempDir: string): Promise<void> {
  const repositoryRoot = path.resolve(process.env.OPSPILOT_REPOSITORY_ROOT || process.cwd());
  const seedRoot = path.join(repositoryRoot, "benchmarks", "seeded-repo");
  await copyDirectory(seedRoot, tempDir, new Set(["node_modules", "dist", ".git"]));
}

async function copyDirectory(source: string, destination: string, ignoredNames: Set<string>): Promise<void> {
  await fs.promises.mkdir(destination, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredNames.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, ignoredNames);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath);
    }
  }
}

async function zipDirectory(sourceDir: string, zipPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));
    archive.pipe(output);
    archive.glob("**/*", {
      cwd: sourceDir,
      dot: true,
      ignore: [".git/**", "node_modules/**"]
    });
    archive.finalize();
  });
}

function runGitForOutput(args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        const [sha] = stdout.trim().split(/\s+/);
        if (sha) {
          resolve(sha);
          return;
        }
      }
      reject(new Error(`${label} failed: ${stderr || stdout || `exit code ${code}`}`));
    });
  });
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed with exit code ${code}: ${output.slice(-4000)}`));
    });
  });
}
