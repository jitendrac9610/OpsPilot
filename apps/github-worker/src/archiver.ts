import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import archiver from "archiver";
import { prisma } from "@opspilot/database";
import { config, logger, storage, EventBus, generateId, generateCorrelationId, generateIdempotencyKey } from "@opspilot/shared";

export async function createCommitSnapshot(
  repositoryId: string,
  gitUrl: string,
  commitSha: string,
  branch: string = "main"
): Promise<string> {
  const tempDir = path.join(config.tempRoot, `clone_${generateId()}`);
  const zipPath = `${tempDir}.zip`;

  logger.info({ repositoryId, gitUrl, commitSha, branch }, "Initiating commit snapshot archiving");

  const existingSnapshot = await prisma.repositorySnapshot.findFirst({
    where: { repositoryId, commitSha }
  });

  if (existingSnapshot) {
    logger.info({ repositoryId, commitSha, archiveUrl: existingSnapshot.archiveUrl }, "Snapshot already exists. Reusing it.");
    
    await EventBus.publish({
      id: generateId("evt"),
      name: "repository.snapshot.created",
      organizationId: "system",
      projectId: "system",
      environment: "development",
      sourceEntity: "github-worker",
      commitSha,
      correlationId: generateCorrelationId(),
      idempotencyKey: generateIdempotencyKey(),
      timestamp: new Date().toISOString(),
      data: {
        snapshotId: existingSnapshot.id,
        repositoryId,
        commitSha,
        archiveUrl: existingSnapshot.archiveUrl
      }
    });

    fetch(`${config.services.discoveryWorkerUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        commitSha,
        archiveUrl: existingSnapshot.archiveUrl
      })
    }).catch(err => logger.error({ err }, "Failed to trigger discovery-worker"));

    return existingSnapshot.archiveUrl;
  }

  try {
    // 1. Check for mock Git URL
    if (config.isDemoMode && (gitUrl.startsWith("mock_") || gitUrl.includes("mock-repo"))) {
      logger.info({ gitUrl }, "Mock URL detected. Packaging seeded-repo as snapshot source");
      const repositoryRoot = path.resolve(process.env.OPSPILOT_REPOSITORY_ROOT || process.cwd());
      const seedRoot = path.join(repositoryRoot, "benchmarks", "seeded-repo");
      const seedSrcDir = path.join(seedRoot, "src");
      
      // Ensure target temp dir exists
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });

      // Copy seeded files to temp directory
      const files = fs.readdirSync(seedSrcDir);
      for (const file of files) {
        fs.copyFileSync(path.join(seedSrcDir, file), path.join(tempDir, "src", file));
      }
      // Copy package.json
      fs.copyFileSync(
        path.join(seedRoot, "package.json"),
        path.join(tempDir, "package.json")
      );
    } else {
      if (gitUrl.startsWith("mock_") || gitUrl.includes("mock-repo")) {
        throw new Error("Mock repositories are available only when OPSPILOT_MODE=demo.");
      }
      fs.mkdirSync(tempDir, { recursive: true });
      await runGit(["clone", "--no-checkout", "--filter=blob:none", gitUrl, tempDir]);
      await runGit(["-C", tempDir, "fetch", "--depth", "1", "origin", commitSha]);
      await runGit(["-C", tempDir, "checkout", "--detach", commitSha]);
    }

    await fs.promises.writeFile(
      path.join(tempDir, "opspilot-snapshot.json"),
      JSON.stringify({ repositoryId, commitSha, branch, createdAt: new Date().toISOString() }, null, 2),
      "utf8"
    );

    // 3. Zip Folder using Node-Archiver
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);
      archive.glob("**/*", {
        cwd: tempDir,
        dot: true,
        ignore: [".git/**", "node_modules/**"]
      });
      archive.finalize();
    });

    // 4. Upload ZIP Archive to Object Storage (MinIO or Local disk)
    const zipBuffer = await fs.promises.readFile(zipPath);
    const filename = `${repositoryId}_${commitSha}.zip`;
    const archiveUrl = await storage.uploadSnapshot(filename, zipBuffer);

    // 5. Persist to Repository Snapshot Database table
    const snapshot = await prisma.repositorySnapshot.create({
      data: {
        repositoryId,
        commitSha,
        archiveUrl
      }
    });

    // 6. Emit `repository.snapshot.created` System Event
    await EventBus.publish({
      id: generateId("evt"),
      name: "repository.snapshot.created",
      organizationId: "system",
      projectId: "system",
      environment: "development",
      sourceEntity: "github-worker",
      commitSha,
      correlationId: generateCorrelationId(),
      idempotencyKey: generateIdempotencyKey(),
      timestamp: new Date().toISOString(),
      data: {
        snapshotId: snapshot.id,
        repositoryId,
        commitSha,
        archiveUrl
      }
    });

    // Trigger Discovery Worker asynchronously
    fetch(`${config.services.discoveryWorkerUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        commitSha,
        archiveUrl
      })
    }).catch(err => logger.error({ err }, "Failed to trigger discovery-worker"));

    logger.info({ snapshotId: snapshot.id, archiveUrl }, "Snapshot archive created and persisted");
    return archiveUrl;
  } catch (err: any) {
    logger.error({ err, repositoryId }, "Snapshot generation failed");
    throw err;
  } finally {
    // 7. Cleanup Temp files
    try {
      if (fs.existsSync(tempDir)) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(zipPath)) {
        await fs.promises.unlink(zipPath);
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, "Temporary directories cleanup failed");
    }
  }
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
