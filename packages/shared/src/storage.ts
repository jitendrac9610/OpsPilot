import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.js";
import { logger } from "./logger.js";

export class ObjectStorage {
  private static localUploadDir = config.snapshotStorageRoot;

  constructor() {
    // Ensure local directory exists for fallback local disk writes
    if (!fs.existsSync(ObjectStorage.localUploadDir)) {
      fs.mkdirSync(ObjectStorage.localUploadDir, { recursive: true });
    }
  }

  // Uploads a file buffer as a snapshot archive
  async uploadSnapshot(filename: string, buffer: Buffer): Promise<string> {
    const bucket = config.minio.bucketName;
    const endpoint = config.minio.endpoint;
    
    // Fallback: If MinIO is disabled/mocked or local compose is down, write to local sandbox directory
    if (endpoint === "localhost" || endpoint === "") {
      const localPath = path.join(ObjectStorage.localUploadDir, filename);
      try {
        await fs.promises.writeFile(localPath, buffer);
        logger.info({ filename, localPath }, "Uploaded snapshot archive to local storage fallback");
        return pathToFileURL(localPath).toString();
      } catch (err) {
        logger.error({ err, filename }, "Failed to write local snapshot file");
        throw err;
      }
    }

    throw new Error(
      `OBJECT_STORAGE_UPLOAD_NOT_CONFIGURED: Direct upload to ${endpoint}:${config.minio.port}/${bucket} requires a real S3/MinIO client.`
    );
  }

  // Downloads a snapshot archive file to buffer
  async downloadSnapshot(fileUrl: string): Promise<Buffer> {
    if (fileUrl.startsWith("file://")) {
      const localPath = fileURLToPath(fileUrl);
      return await fs.promises.readFile(localPath);
    }

    // Fetch from S3/MinIO url
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`Failed to download snapshot: ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

export const storage = new ObjectStorage();

export async function extractArchiveSafely(archive: Buffer, destination: string): Promise<number> {
  const { default: unzipper } = await import("unzipper");
  const directory = await unzipper.Open.buffer(archive);
  
  const maxArchiveFiles = config.sandbox?.maxArchiveFiles || 20000;
  const maxArchiveBytes = config.sandbox?.maxArchiveBytes || 1073741824; // 1GB
  const maxFileBytes = config.sandbox?.maxFileBytes || 52428800; // 50MB

  if (directory.files.length > maxArchiveFiles) {
    throw new Error(`Archive contains too many files (${directory.files.length}); limit is ${maxArchiveFiles}`);
  }

  const destinationRoot = path.resolve(destination);
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  let extractedBytes = 0;
  let verified = 0;

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
      throw new Error(`Unsafe archive entry path rejected: ${entry.path}`);
    }

    const target = path.resolve(destinationRoot, ...normalized.split("/"));
    if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${path.sep}`)) {
      throw new Error(`Archive path escapes the workspace: ${entry.path}`);
    }

    if (entry.type === "Directory") {
      await fs.promises.mkdir(target, { recursive: true });
      continue;
    }
    if (entry.type !== "File") {
      throw new Error(`Unsupported archive entry type for ${entry.path}`);
    }

    const content = await entry.buffer();
    if (content.byteLength > maxFileBytes) {
      throw new Error(`Archive file exceeds the per-file size limit: ${entry.path}`);
    }
    extractedBytes += content.byteLength;
    if (extractedBytes > maxArchiveBytes) {
      throw new Error("Expanded archive exceeds the configured size limit.");
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
    verified++;
  }
  return verified;
}

