import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  jwtSecret: process.env.JWT_SECRET || "default_jwt_secret_for_opspilot",
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  
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
