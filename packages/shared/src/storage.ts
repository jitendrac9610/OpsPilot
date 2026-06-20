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
