import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import unzipper from "unzipper";
import { config, logger, storage, EventBus, generateId, generateCorrelationId, generateIdempotencyKey, OpsPilotError } from "@opspilot/shared";
import { prisma } from "@opspilot/database";
import { classifyFile, shouldExcludeFile, parseFile, ExtractedSymbol, runStaticAnalysis } from "@opspilot/repository-intelligence";
import { getEmbedding } from "@opspilot/rag";

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

// Helper to compute SHA-256 hash of a file
function computeHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Helper to write progress log into AuditLog table
async function logProgress(repositoryId: string, message: string) {
  logger.info({ repositoryId, message }, "Indexing progress");
  try {
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        action: "repository.index.log",
        payload: { repositoryId, message }
      }
    });
  } catch (err) {
    logger.error({ err }, "Failed to write progress log to Database");
  }
}

app.post("/index", async (req: Request, res: Response, next: NextFunction) => {
  const { repositoryId, commitSha, archiveUrl } = req.body;
  if (!repositoryId || !commitSha || !archiveUrl) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: "repositoryId, commitSha, and archiveUrl are required" });
  }

  const tempUnzipDir = path.join(config.tempRoot, `index_${generateId()}`);
  logger.info({ repositoryId, commitSha, archiveUrl }, "Starting repository indexing execution");

  try {
    // 1. Clear old indexing logs for this repository
    const oldLogs = await prisma.auditLog.findMany({
      where: { action: "repository.index.log" }
    });
    const idsToDelete = oldLogs
      .filter((log: { payload: unknown }) => (log.payload as any)?.repositoryId === repositoryId)
      .map((log: { id: string }) => log.id);
    if (idsToDelete.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { id: { in: idsToDelete } }
      });
    }

    // 2. Emit `indexing.started` System Event and write initial log
    await EventBus.publish({
      id: generateId("evt"),
      name: "indexing.started",
      organizationId: "system",
      projectId: "system",
      environment: "development",
      sourceEntity: "indexer-worker",
      commitSha,
      correlationId: generateCorrelationId(),
      idempotencyKey: generateIdempotencyKey(),
      timestamp: new Date().toISOString(),
      data: { repositoryId, commitSha }
    });

    await logProgress(repositoryId, "Discovering repository...");
    await logProgress(repositoryId, `Cloning git repository snapshot at commit ${commitSha.substring(0, 7)}...`);

    // 3. Fetch Snapshot Record from Database
    const snapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId, commitSha }
    });
    if (!snapshot) {
      throw new Error(`Repository snapshot not found for commit ${commitSha}`);
    }

    // 4. Download ZIP from Storage
    const zipBuffer = await storage.downloadSnapshot(archiveUrl);

    // 5. Extract ZIP safely
    const { extractArchiveSafely } = await import("@opspilot/shared");
    await extractArchiveSafely(zipBuffer, tempUnzipDir);

    // 6. Scan files recursively
    const relativeFiles = await getFilesRecursively(tempUnzipDir);
    await logProgress(repositoryId, `Found ${relativeFiles.length} files to index.`);

    const parsedFiles: Array<{ relativePath: string; language: string; symbols: ExtractedSymbol[] }> = [];
    let incrementalMatches = 0;
    let newIndexedFiles = 0;
    let totalSymbolsCount = 0;
    let totalChunksCount = 0;

    // Fetch existing snapshots for content-addressed lookup
    const otherSnapshots = await prisma.repositorySnapshot.findMany({
      where: { repositoryId }
    });
    const snapshotIds = otherSnapshots.map((candidate: { id: string }) => candidate.id);

    await logProgress(repositoryId, "Running Universal Stack Discovery & parsing source files using AST compiler...");

    // 7. Process files
    for (const relativePath of relativeFiles) {
      if (shouldExcludeFile(relativePath)) continue;

      try {
        const absolutePath = path.join(tempUnzipDir, relativePath);

        // Check for null bytes in the file content (binary or non-UTF-8 detection)
        const fileContent = fs.readFileSync(absolutePath);
        if (fileContent.byteLength > config.sandbox.maxFileBytes) {
          logger.warn({ relativePath, size: fileContent.byteLength }, "Skipping file above indexing size limit");
          continue;
        }
        if (fileContent.includes(0)) {
          logger.warn({ relativePath }, "Skipping file containing null bytes (likely binary or non-UTF-8)");
          continue;
        }
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(fileContent);
        } catch {
          logger.warn({ relativePath }, "Skipping file that is not valid UTF-8");
          continue;
        }

        const classified = classifyFile(relativePath, absolutePath);

        if (classified.isBinary || classified.isSecret) continue;

        const contentHash = crypto.createHash("sha256").update(fileContent).digest("hex");

        // Check if this file with identical path and content hash exists already
        const existingFile = await prisma.repositoryFile.findFirst({
          where: {
            path: relativePath,
            hash: contentHash,
            snapshotId: { in: snapshotIds }
          }
        });

        // Persist new RepositoryFile record
        const dbFile = await prisma.repositoryFile.create({
          data: {
            snapshotId: snapshot.id,
            path: relativePath,
            hash: contentHash
          }
        });

        let fileSymbols: ExtractedSymbol[] = [];

        if (existingFile) {
          // INCREMENTAL DEDUPLICATION MATCH
          incrementalMatches++;
          
          const oldSymbols = await prisma.symbol.findMany({ where: { fileId: existingFile.id } });
          for (const sym of oldSymbols) {
            const cleanName = sym.name.replace(/\u0000/g, "");
            await prisma.symbol.create({
              data: {
                fileId: dbFile.id,
                name: cleanName,
                kind: sym.kind,
                line: sym.line
              }
            });
            fileSymbols.push({
              name: cleanName,
              kind: sym.kind,
              line: sym.line,
              startLine: sym.line,
              endLine: sym.line
            });
            totalSymbolsCount++;
          }

          const oldChunks = await prisma.codeChunk.findMany({ where: { fileId: existingFile.id } });
          for (const chunk of oldChunks) {
            const cleanContent = chunk.content.replace(/\u0000/g, "");
            const dbChunk = await prisma.codeChunk.create({
              data: {
                fileId: dbFile.id,
                content: cleanContent,
                startLine: chunk.startLine,
                endLine: chunk.endLine
              }
            });
            totalChunksCount++;
            const oldEmbedding = await prisma.chunkEmbedding.findUnique({ where: { chunkId: chunk.id } });
            if (oldEmbedding) {
              const cleanEmbedding = oldEmbedding.embedding.replace(/\u0000/g, "");
              await prisma.chunkEmbedding.create({
                data: {
                  chunkId: dbChunk.id,
                  embedding: cleanEmbedding
                }
              });
            }
          }
        } else {
          // Parse fresh file
          newIndexedFiles++;
          const parsed = parseFile(classified.language, relativePath, absolutePath);
          fileSymbols = parsed.symbols;

          for (const sym of parsed.symbols) {
            const cleanName = sym.name.replace(/\u0000/g, "");
            await prisma.symbol.create({
              data: {
                fileId: dbFile.id,
                name: cleanName,
                kind: sym.kind,
                line: sym.line
              }
            });
            totalSymbolsCount++;
          }

          for (const chunk of parsed.chunks) {
            const cleanContent = chunk.content.replace(/\u0000/g, "");
            const dbChunk = await prisma.codeChunk.create({
              data: {
                fileId: dbFile.id,
                content: cleanContent,
                startLine: chunk.startLine,
                endLine: chunk.endLine
              }
            });
            totalChunksCount++;

            const embedding = await getEmbedding(cleanContent);
            const cleanEmbeddingStr = JSON.stringify(embedding).replace(/\u0000/g, "");
            await prisma.chunkEmbedding.create({
              data: {
                chunkId: dbChunk.id,
                embedding: cleanEmbeddingStr
              }
            });
          }
        }

        parsedFiles.push({
          relativePath,
          language: classified.language,
          symbols: fileSymbols
        });
      } catch (fileErr: any) {
        logger.error({ fileErr, relativePath }, "Failed to index file, skipping to continue workspace indexing");
        await logProgress(repositoryId, `Warning: skipped indexing file ${relativePath} due to error: ${fileErr.message}`);
      }
    }

    await logProgress(repositoryId, `AST Parsing finished. Reused ${incrementalMatches} cached files, parsed ${newIndexedFiles} new files.`);
    await logProgress(repositoryId, `Extracted ${totalSymbolsCount} symbols and ${totalChunksCount} code chunks.`);
    await logProgress(repositoryId, "Generating vector embeddings and index...");

    // 8. Trigger Graph Worker
    await logProgress(repositoryId, "Building evidence-backed architecture graph...");
    
    const graphResponse = await fetch(`${config.services.graphWorkerUrl}/graph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        commitSha,
        snapshotId: snapshot.id,
        projectRoot: tempUnzipDir,
        files: parsedFiles
      })
    });

    if (graphResponse.ok) {
      await logProgress(repositoryId, "Running static analysis audit...");
      const staticFindings = await runStaticAnalysis(tempUnzipDir, repositoryId);

      // Clear old findings
      await prisma.finding.deleteMany({
        where: { repositoryId }
      });

      // Save new findings
      if (staticFindings.length > 0) {
        await prisma.finding.createMany({
          data: staticFindings.map(f => ({
            repositoryId,
            severity: f.severity,
            confidence: f.confidence,
            title: f.title,
            file: f.file,
            line: f.line,
            description: f.description,
            impact: f.impact,
            category: f.category
          }))
        });
      }

      await logProgress(repositoryId, `Static analysis audit complete! Found ${staticFindings.length} findings.`);
      await logProgress(repositoryId, "Indexing complete!");
    } else {
      throw new Error(`Graph worker failed with status ${graphResponse.status}`);
    }

    res.status(200).json({ status: "success", indexedFilesCount: parsedFiles.length });
  } catch (err: any) {
    logger.error({ err, repositoryId }, "Indexing failed");
    await logProgress(repositoryId, `Indexing failed: ${err.message}`);
    next(err);
  } finally {
    // 9. Cleanup unzipped directory
    try {
      if (fs.existsSync(tempUnzipDir)) {
        await fs.promises.rm(tempUnzipDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, "Failed to clean up indexer temp directory");
    }
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "Indexer Worker error");
  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});

const port = 4003;
app.listen(port, () => {
  logger.info(`OpsPilot Indexer Worker listening on port ${port}`);
});
