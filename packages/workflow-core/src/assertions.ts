import { config as sharedConfig, logger } from "@opspilot/shared";

export interface DBAssertionConfig {
  query?: string;
  table?: string;
  action?: "snapshot" | "diff" | "verify_row" | "cleanup";
  snapshotId?: string;
  expectedDiffCount?: number;
  whereClause?: Record<string, unknown>;
  limit?: number;
}

export interface QueueAssertionConfig {
  queueName: string;
  jobId?: string;
  event?: string;
  state?: "completed" | "failed" | "active" | "waiting" | "delayed" | "stalled";
  payloadContains?: Record<string, unknown>;
  minRetries?: number;
}

export interface SDKAssertionConfig {
  sdk: "Clerk" | "GetStream" | "Stripe";
  action: string;
  params?: Record<string, unknown>;
}

export interface AssertionResult {
  success: boolean;
  log: string;
  evidence?: Record<string, unknown>;
}

export interface AssertionAdapters {
  database?: (config: DBAssertionConfig) => Promise<AssertionResult>;
  queue?: (config: QueueAssertionConfig) => Promise<AssertionResult>;
  sdk?: (config: SDKAssertionConfig) => Promise<AssertionResult>;
}

interface DatabaseSnapshot {
  source: "postgresql" | "mongodb";
  table: string;
  rows: unknown[];
  capturedAt: string;
}

export class AssertionEngine {
  private readonly dbSnapshots = new Map<string, DatabaseSnapshot>();

  constructor(private readonly adapters: AssertionAdapters = {}) {}

  public async assertDBState(config: DBAssertionConfig): Promise<AssertionResult> {
    logger.info({ config }, "Evaluating database assertion");
    if (this.adapters.database) return this.adapters.database(config);

    const databaseUrl = process.env.DATABASE_URL;
    const mongoUrl = process.env.MONGODB_URI;
    if (!databaseUrl && !mongoUrl) {
      return {
        success: false,
        log: "DATABASE_ASSERTION_ADAPTER_NOT_CONFIGURED: DATABASE_URL or MONGODB_URI is required."
      };
    }

    try {
      return mongoUrl
        ? await this.assertMongoState(mongoUrl, config)
        : await this.assertPostgresState(databaseUrl!, config);
    } catch (error) {
      return {
        success: false,
        log: `DATABASE_ASSERTION_EXCEPTION: ${errorMessage(error)}`
      };
    }
  }

  public async assertQueueEvent(config: QueueAssertionConfig): Promise<AssertionResult> {
    logger.info({ config }, "Evaluating queue assertion");
    if (this.adapters.queue) return this.adapters.queue(config);
    const redisUrl = process.env.REDIS_URL || sharedConfig.redisUrl;
    if (!redisUrl) {
      return {
        success: false,
        log: "QUEUE_ASSERTION_ADAPTER_NOT_CONFIGURED: REDIS_URL is required."
      };
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(config.queueName)) {
      return { success: false, log: "QUEUE_ASSERTION_REJECTED: Invalid queue name." };
    }

    const { Queue } = await import("bullmq");
    const queue = new Queue(config.queueName, {
      connection: redisConnectionFromUrl(redisUrl)
    });
    try {
      const jobs = config.jobId
        ? [await queue.getJob(config.jobId)]
        : await queue.getJobs(["completed", "failed", "active", "waiting", "delayed", "paused"], 0, 199, false);

      for (const job of jobs) {
        if (!job) continue;
        const payload = normalizeJobData(job.data);
        if (config.payloadContains && !isSubset(payload, config.payloadContains)) continue;

        const attemptsMade = Number(job.attemptsMade || 0);
        if (config.minRetries !== undefined && attemptsMade < config.minRetries) continue;
        const state = await job.getState();
        if (config.state && state !== config.state) continue;

        return {
          success: true,
          log: `QUEUE_ASSERTION_MATCHED: Found BullMQ job ${job.id} in ${config.queueName} with state ${state}.`,
          evidence: {
            queueName: config.queueName,
            jobId: job.id,
            state,
            attemptsMade,
            payload,
            returnValue: job.returnvalue,
            failedReason: job.failedReason
          }
        };
      }
      return {
        success: false,
        log: `QUEUE_ASSERTION_FAILED: No job in ${config.queueName} matched the requested state, retry, and payload constraints.`
      };
    } catch (error) {
      return {
        success: false,
        log: `QUEUE_ASSERTION_EXCEPTION: ${errorMessage(error)}`
      };
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  public async assertSDKState(config: SDKAssertionConfig): Promise<AssertionResult> {
    logger.info({ config }, "Evaluating SDK assertion");
    if (this.adapters.sdk) return this.adapters.sdk(config);
    return {
      success: false,
      log: `SDK_ASSERTION_ADAPTER_NOT_CONFIGURED: ${config.sdk} ${config.action} was not verified.`
    };
  }

  private pluralize(val: string): string {
    if (val.endsWith("y") && !val.endsWith("ay") && !val.endsWith("ey") && !val.endsWith("oy") && !val.endsWith("uy")) {
      return val.slice(0, -1) + "ies";
    }
    if (val.endsWith("s") || val.endsWith("sh") || val.endsWith("ch") || val.endsWith("x") || val.endsWith("z")) {
      return val + "es";
    }
    return val + "s";
  }

  private singularize(val: string): string {
    if (val.endsWith("ies")) return val.slice(0, -3) + "y";
    if (val.endsWith("ses")) return val.slice(0, -2);
    if (val.endsWith("s") && !val.endsWith("ss")) return val.slice(0, -1);
    return val;
  }

  private findMatchingTableName(candidates: string[], modelName: string): string {
    const normalizedModel = modelName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const plural = this.pluralize(normalizedModel);
    const singular = this.singularize(normalizedModel);
    const getNormalized = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, "");

    let match = candidates.find(c => getNormalized(c) === normalizedModel);
    if (match) return match;

    match = candidates.find(c => getNormalized(c) === plural);
    if (match) return match;

    match = candidates.find(c => getNormalized(c) === singular);
    if (match) return match;

    return modelName;
  }

  private async getPostgresTableNames(client: any): Promise<string[]> {
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    return res.rows.map((row: any) => row.table_name);
  }

  private async deletePostgresRows(
    client: any,
    config: DBAssertionConfig
  ): Promise<number> {
    if (!config.table) throw new Error("A table name is required for database cleanup.");
    const table = quoteQualifiedIdentifier(config.table);
    const values: unknown[] = [];
    const predicates = Object.entries(config.whereClause || {}).map(([column, value]) => {
      values.push(value);
      return `${quoteIdentifier(column)} = $${values.length}`;
    });
    if (predicates.length === 0) {
      throw new Error("A whereClause is required for safe database cleanup to prevent accidental truncation.");
    }
    const where = ` WHERE ${predicates.join(" AND ")}`;
    const result = await client.query(`DELETE FROM ${table}${where}`, values);
    return result.rowCount || 0;
  }

  private async assertPostgresState(
    databaseUrl: string,
    config: DBAssertionConfig
  ): Promise<AssertionResult> {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: databaseUrl,
      statement_timeout: 5_000,
      query_timeout: 5_000,
      application_name: "opspilot-readonly-assertion"
    });
    await client.connect();
    try {
      let matchedTable = config.table;
      if (config.table) {
        const candidates = await this.getPostgresTableNames(client);
        matchedTable = this.findMatchingTableName(candidates, config.table);
      }

      if (config.action === "cleanup") {
        const deletedCount = await this.deletePostgresRows(client, { ...config, table: matchedTable });
        return {
          success: true,
          log: `DATABASE_CLEANUP_PASSED: Deleted ${deletedCount} rows from ${matchedTable}.`,
          evidence: { table: matchedTable, deletedCount }
        };
      }

      await client.query("BEGIN READ ONLY");
      const rows = config.query
        ? (await client.query(validateReadOnlyQuery(config.query))).rows
        : await selectPostgresRows(client, { ...config, table: matchedTable });
      const result = this.evaluateRows("postgresql", { ...config, table: matchedTable }, rows);
      await client.query("ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async assertMongoState(
    mongoUrl: string,
    config: DBAssertionConfig
  ): Promise<AssertionResult> {
    if (!config.table) {
      throw new Error("A collection name is required for MongoDB assertions.");
    }
    validateIdentifier(config.table);
    if (config.query) {
      throw new Error("Raw query strings are not supported for MongoDB assertions.");
    }

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(mongoUrl, {
      serverSelectionTimeoutMS: 5_000,
      appName: "opspilot-readonly-assertion"
    });
    await client.connect();
    try {
      const db = client.db();
      const collections = await db.listCollections().toArray();
      const candidates = collections.map((col: any) => col.name);
      const matchedTable = this.findMatchingTableName(candidates, config.table);

      if (config.action === "cleanup") {
        if (!config.whereClause || Object.keys(config.whereClause).length === 0) {
          throw new Error("A whereClause is required for safe MongoDB cleanup.");
        }
        const deleteResult = await db.collection(matchedTable).deleteMany(config.whereClause);
        return {
          success: true,
          log: `DATABASE_CLEANUP_PASSED: Deleted ${deleteResult.deletedCount || 0} documents from ${matchedTable}.`,
          evidence: { collection: matchedTable, deletedCount: deleteResult.deletedCount || 0 }
        };
      }

      const rows = await db
        .collection(matchedTable)
        .find(config.whereClause || {})
        .limit(assertionLimit(config.limit))
        .toArray();
      return this.evaluateRows("mongodb", { ...config, table: matchedTable }, rows);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private evaluateRows(
    source: DatabaseSnapshot["source"],
    config: DBAssertionConfig,
    rows: unknown[]
  ): AssertionResult {
    if (config.action === "snapshot") {
      if (!config.snapshotId || !config.table) {
        throw new Error("snapshotId and table are required for a database snapshot.");
      }
      this.dbSnapshots.set(config.snapshotId, {
        source,
        table: config.table,
        rows: structuredClone(rows),
        capturedAt: new Date().toISOString()
      });
      return {
        success: true,
        log: `DATABASE_SNAPSHOT_CAPTURED: ${rows.length} rows from ${config.table}.`,
        evidence: { snapshotId: config.snapshotId, rowCount: rows.length, source }
      };
    }

    if (config.action === "diff") {
      if (!config.snapshotId || !config.table) {
        throw new Error("snapshotId and table are required for a database diff.");
      }
      const snapshot = this.dbSnapshots.get(config.snapshotId);
      if (!snapshot) throw new Error(`Snapshot ${config.snapshotId} does not exist.`);
      if (snapshot.source !== source || snapshot.table !== config.table) {
        throw new Error(`Snapshot ${config.snapshotId} belongs to a different data source.`);
      }
      const before = new Set(snapshot.rows.map(canonicalJson));
      const after = new Set(rows.map(canonicalJson));
      const added = [...after].filter((row) => !before.has(row));
      const removed = [...before].filter((row) => !after.has(row));
      const expected = config.expectedDiffCount ?? 1;
      return {
        success: added.length >= expected,
        log: `DATABASE_DIFF: ${added.length} added and ${removed.length} removed rows; expected at least ${expected} additions.`,
        evidence: {
          snapshotId: config.snapshotId,
          added: added.map(parseCanonicalJson),
          removed: removed.map(parseCanonicalJson)
        }
      };
    }

    return {
      success: rows.length > 0,
      log: rows.length
        ? `DATABASE_ASSERTION_MATCHED: Read-only query matched ${rows.length} rows.`
        : "DATABASE_ASSERTION_FAILED: Read-only query matched no rows.",
      evidence: { rowCount: rows.length, rows }
    };
  }
}

async function selectPostgresRows(
  client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  config: DBAssertionConfig
): Promise<unknown[]> {
  if (!config.table) throw new Error("A table name or read-only query is required.");
  const table = quoteQualifiedIdentifier(config.table);
  const values: unknown[] = [];
  const predicates = Object.entries(config.whereClause || {}).map(([column, value]) => {
    values.push(value);
    return `${quoteIdentifier(column)} = $${values.length}`;
  });
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const limit = assertionLimit(config.limit);
  return (await client.query(`SELECT * FROM ${table}${where} LIMIT ${limit}`, values)).rows;
}

function validateReadOnlyQuery(query: string): string {
  const normalized = query.trim().replace(/--.*$/gm, "").trim();
  if (normalized.includes(";")) {
    throw new Error("Multiple SQL statements are not allowed.");
  }
  if (!/^(SELECT|WITH|EXPLAIN\s+SELECT|SHOW)\b/i.test(normalized)) {
    throw new Error("Only read-only SELECT, WITH, EXPLAIN SELECT, or SHOW statements are allowed.");
  }
  if (/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE)\b/i.test(normalized)) {
    throw new Error("Mutating SQL is not allowed.");
  }
  return normalized;
}

function quoteQualifiedIdentifier(value: string): string {
  return value.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(value: string): string {
  validateIdentifier(value);
  return `"${value}"`;
}

function validateIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`Invalid database identifier: ${value}`);
  }
}

function assertionLimit(value?: number): number {
  if (value === undefined) return 500;
  if (!Number.isInteger(value) || value < 1 || value > 5_000) {
    throw new Error("Database assertion limit must be between 1 and 5000.");
  }
  return value;
}

function normalizeJobData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function redisConnectionFromUrl(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parseInt(parsed.port || "6379", 10),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: parseInt(parsed.pathname.replace("/", "") || "0", 10),
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false
  };
}

function isSubset(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const candidate = actual[key];
    if (
      value &&
      candidate &&
      typeof value === "object" &&
      typeof candidate === "object" &&
      !Array.isArray(value) &&
      !Array.isArray(candidate)
    ) {
      return isSubset(
        candidate as Record<string, unknown>,
        value as Record<string, unknown>
      );
    }
    return canonicalJson(candidate) === canonicalJson(value);
  });
}

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  ).join(",")}}`;
}

function parseCanonicalJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
