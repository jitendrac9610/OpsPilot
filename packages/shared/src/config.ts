import dotenv from "dotenv";
import os from "node:os";
import path from "path";

// Load environment variables from .env
dotenv.config();

const configuredMode = process.env.OPSPILOT_MODE || "development";
if (!["development", "demo", "production"].includes(configuredMode)) {
  throw new Error(`Invalid OPSPILOT_MODE "${configuredMode}". Expected development, demo, or production.`);
}

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  opspilotMode: configuredMode as "development" | "demo" | "production",
  isDemoMode: configuredMode === "demo",
  jwtSecret: process.env.JWT_SECRET || "default_jwt_secret_for_opspilot",
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  tempRoot: path.resolve(process.env.OPSPILOT_TEMP_ROOT || path.join(os.tmpdir(), "opspilot")),
  snapshotStorageRoot: path.resolve(
    process.env.OPSPILOT_SNAPSHOT_STORAGE_ROOT ||
    path.join(process.env.OPSPILOT_TEMP_ROOT || path.join(os.tmpdir(), "opspilot"), "uploads")
  ),
  services: {
    sandboxControllerUrl: process.env.SANDBOX_CONTROLLER_URL || "http://localhost:4010",
    graphWorkerUrl: process.env.GRAPH_WORKER_URL || "http://localhost:4004",
    discoveryWorkerUrl: process.env.DISCOVERY_WORKER_URL || "http://localhost:4002"
  },
  sandbox: {
    repositorySubdirectory: process.env.SANDBOX_REPOSITORY_SUBDIRECTORY || "",
    image: process.env.SANDBOX_NODE_IMAGE || "node:20-bookworm-slim",
    commandTimeoutMs: parseInt(process.env.SANDBOX_COMMAND_TIMEOUT_MS || "600000", 10),
    maxLogBytes: parseInt(process.env.SANDBOX_MAX_LOG_BYTES || "1048576", 10),
    memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || "1g",
    cpuLimit: process.env.SANDBOX_CPU_LIMIT || "1",
    pidLimit: parseInt(process.env.SANDBOX_PID_LIMIT || "256", 10),
    maxArchiveBytes: parseInt(process.env.SANDBOX_MAX_ARCHIVE_BYTES || "1073741824", 10),
    maxArchiveFiles: parseInt(process.env.SANDBOX_MAX_ARCHIVE_FILES || "20000", 10),
    maxFileBytes: parseInt(process.env.SANDBOX_MAX_FILE_BYTES || "52428800", 10)
  },
  
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/opspilot?schema=public",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379/0",
  
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || "localhost",
    port: parseInt(process.env.MINIO_PORT || "9000", 10),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    bucketName: process.env.MINIO_BUCKET_NAME || "opspilot-snapshots"
  },
  
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  
  github: {
    appId: process.env.GITHUB_APP_ID || "",
    privateKey: process.env.GITHUB_PRIVATE_KEY || "",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || ""
  },
  
  otelExporterOtlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
  
  clerk: {
    secretKey: process.env.CLERK_SECRET_KEY || "",
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY || ""
  },
  
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ""
  },
  
  getStream: {
    apiKey: process.env.GETSTREAM_API_KEY || "",
    apiSecret: process.env.GETSTREAM_API_SECRET || ""
  }
};
