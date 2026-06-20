import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import { prisma } from "@opspilot/database";
import { logger, storage, EventBus, generateId, generateCorrelationId, generateIdempotencyKey } from "@opspilot/shared";

const execAsync = promisify(exec);

export async function createCommitSnapshot(
  repositoryId: string,
  gitUrl: string,
  commitSha: string,
  branch: string = "main"
): Promise<string> {
  const tempDir = path.join("c:\\Users\\jiten\\OpsPilot", "sandbox", "temp", `clone_${generateId()}`);
  const zipPath = `${tempDir}.zip`;

  logger.info({ repositoryId, gitUrl, commitSha, branch }, "Initiating commit snapshot archiving");

  try {
    // 1. Check for mock Git URL
    if (gitUrl.startsWith("mock_") || gitUrl.includes("mock-repo")) {
      logger.info({ gitUrl }, "Mock URL detected. Packaging seeded-repo as snapshot source");
      const seedSrcDir = path.join("c:\\Users\\jiten\\OpsPilot", "benchmarks", "seeded-repo", "src");
      
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
        path.join("c:\\Users\\jiten\\OpsPilot", "benchmarks", "seeded-repo", "package.json"),
        path.join(tempDir, "package.json")
      );
    } else {
      // 2. Real Git Clone Flow
      fs.mkdirSync(tempDir, { recursive: true });
      await execAsync(`git clone --depth 1 --branch ${branch} ${gitUrl} ${tempDir}`);
    }

    // 3. Zip Folder using Node-Archiver
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);
      archive.directory(tempDir, false);
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
    fetch("http://localhost:4002/discover", {
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
