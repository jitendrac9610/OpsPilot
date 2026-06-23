import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import unzipper from "unzipper";
import { logger, config, OpsPilotError, storage, EventBus, generateId, generateCorrelationId, generateIdempotencyKey } from "@opspilot/shared";
import { prisma } from "@opspilot/database";
import { AdapterRegistry } from "@opspilot/adapter-sdk";

const app = express();
app.use(express.json());

// Helper to scan files recursively ignoring node_modules and .git
async function getFilesRecursively(dir: string, baseDir = dir): Promise<string[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map((dirent) => {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === "node_modules" || dirent.name === ".git" || dirent.name === ".turbo") {
        return [];
      }
      return getFilesRecursively(res, baseDir);
    }
    return path.relative(baseDir, res);
  }));
  return files.flat();
}

// POST /discover
app.post("/discover", async (req: Request, res: Response, next: NextFunction) => {
  const { repositoryId, commitSha, archiveUrl } = req.body;
  if (!repositoryId || !commitSha || !archiveUrl) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: "repositoryId, commitSha, and archiveUrl are required" });
  }

  const tempUnzipDir = path.join(config.tempRoot, `unzip_${generateId()}`);
  logger.info({ repositoryId, commitSha, archiveUrl }, "Starting technology discovery execution");

  try {
    // 1. Download ZIP from Storage
    const zipBuffer = await storage.downloadSnapshot(archiveUrl);

    // 2. Extract ZIP safely
    const { extractArchiveSafely } = await import("@opspilot/shared");
    await extractArchiveSafely(zipBuffer, tempUnzipDir);

    // 3. Scan files recursively
    const fileList = await getFilesRecursively(tempUnzipDir);

    // 4. Execute all adapters in registry
    const adapters = AdapterRegistry.getAdapters();
    const detections: any[] = [];

    for (const adapter of adapters) {
      try {
        const detectRes = await adapter.detect(fileList, tempUnzipDir);
        if (detectRes.detected) {
          detections.push({
            id: adapter.id,
            name: adapter.name,
            category: adapter.category,
            level: adapter.capabilityLevel,
            confidence: detectRes.confidence,
            version: detectRes.version,
            reasons: detectRes.reasons,
            capabilities: detectRes.capabilities
          });
        }
      } catch (adapterErr) {
        logger.error({ adapterErr, adapterId: adapter.id }, "Adapter detection execution failed");
      }
    }

    // 5. Aggregate profiles
    const profile = {
      languages: detections.filter(d => d.category === "language").map(d => d.name.replace(" Adapter", "").replace(" TypeScript/JavaScript", "TypeScript")),
      frameworks: detections.filter(d => d.category === "framework").map(d => d.name.replace(" Framework Adapter", "")),
      databases: detections.filter(d => d.category === "database").map(d => d.name),
      messaging: detections.filter(d => d.category === "messaging").map(d => d.name),
      integrations: detections.filter(d => d.category === "integration").map(d => d.name)
    };

    // 6. Persist to DB under CapabilityProfile
    const snapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId, commitSha }
    });

    if (snapshot) {
      await prisma.capabilityProfile.upsert({
        where: { snapshotId: snapshot.id },
        create: {
          snapshotId: snapshot.id,
          profile: profile
        },
        update: {
          profile: profile
        }
      });
      logger.info({ snapshotId: snapshot.id, profile }, "Saved discovered CapabilityProfile in database");
    } else {
      logger.warn({ repositoryId, commitSha }, "RepositorySnapshot record not found. Skipping DB save.");
    }

    // 7. Emit System Event
    await EventBus.publish({
      id: generateId("evt"),
      name: "capability.detected",
      organizationId: "system",
      projectId: "system",
      environment: "development",
      sourceEntity: "discovery-worker",
      commitSha,
      correlationId: generateCorrelationId(),
      idempotencyKey: generateIdempotencyKey(),
      timestamp: new Date().toISOString(),
      data: {
        repositoryId,
        commitSha,
        profile
      }
    });

    // Trigger Indexer Worker asynchronously
    fetch("http://localhost:4003/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        commitSha,
        archiveUrl
      })
    }).catch(err => logger.error({ err }, "Failed to trigger indexer-worker"));

    res.status(200).json({ status: "success", detections, profile });
  } catch (err) {
    next(err);
  } finally {
    // 8. Cleanup temp files
    try {
      if (fs.existsSync(tempUnzipDir)) {
        await fs.promises.rm(tempUnzipDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, "Failed to clean up discovery temp directory");
    }
  }
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "Discovery Worker error");
  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});

const port = 4002;
app.listen(port, () => {
  logger.info(`OpsPilot Discovery Worker listening on port ${port}`);
});
