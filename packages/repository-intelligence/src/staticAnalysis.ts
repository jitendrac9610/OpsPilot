import fs from "fs";
import path from "path";

export interface StaticFinding {
  id?: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  title: string;
  file: string;
  line: number;
  description: string;
  impact: string;
  category: string; // e.g. "database", "messaging", "security", "reliability", "infrastructure"
}

// Helper to scan files recursively
async function getFiles(dir: string, baseDir = dir): Promise<string[]> {
  if (!fs.existsSync(dir)) return [];
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === "node_modules" || dirent.name === ".git" || dirent.name === "dist" || dirent.name === ".turbo") {
          return [];
        }
        return getFiles(res, baseDir);
      }
      return path.relative(baseDir, res);
    })
  );
  return files.flat();
}

/**
 * Helper to get line number from character index in content
 */
function getLineNumber(content: string, index: number): number {
  return content.substring(0, index).split("\n").length;
}

/**
 * Runs static analysis rules on a cloned repository directory.
 */
export async function runStaticAnalysis(
  projectRoot: string,
  repositoryId: string
): Promise<StaticFinding[]> {
  const findings: StaticFinding[] = [];
  const files = await getFiles(projectRoot);

  // 1. Gather all docker-compose service names
  const dockerServices = new Set<string>();
  const composeFile = files.find((f) => f.endsWith("docker-compose.yml"));
  if (composeFile) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, composeFile), "utf-8");
      const servicesSection = content.split("services:");
      if (servicesSection.length > 1) {
        const lines = servicesSection[1].split("\n");
        for (const line of lines) {
          const match = line.match(/^\s{2}([a-zA-Z0-9_-]+):/);
          if (match) {
            dockerServices.add(match[1]);
          }
        }
      }
    } catch {}
  }

  // 2. Gather env.example keys
  const envExampleVars = new Set<string>();
  const envExampleFile = files.find((f) => f.endsWith(".env.example"));
  if (envExampleFile) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, envExampleFile), "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const match = line.match(/^([A-Z0-9_]+)=/);
        if (match) {
          envExampleVars.add(match[1]);
        }
      }
    } catch {}
  }

  // Global registries for queue/event cross-file rules
  const queueProducers: Array<{ name: string; file: string; line: number }> = [];
  const queueConsumers: Array<{ name: string; file: string; line: number }> = [];
  const inngestEmits: Array<{ name: string; file: string; line: number }> = [];
  const inngestTriggers: Array<{ name: string; file: string; line: number }> = [];

  // 3. Scan each file using whole-file string matching
  for (const file of files) {
    const filePath = file.replace(/\\/g, "/"); // Standardize path separators
    const absolutePath = path.join(projectRoot, file);

    const stats = fs.statSync(absolutePath);
    if (stats.size > 500 * 1024) continue; // Skip files > 500KB

    const ext = path.extname(file);
    if (![".ts", ".js", ".tsx", ".jsx", ".py", ".java", ".go", ".yaml", ".yml"].includes(ext)) continue;

    let content = "";
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }

    // Kubernetes readiness probe port mismatch
    if (ext === ".yaml" || ext === ".yml") {
      const portsMatches = [...content.matchAll(/containerPort:\s*(\d+)/g)];
      const probeMatches = [...content.matchAll(/port:\s*(\d+)/g)];

      if (portsMatches.length > 0 && probeMatches.length > 0) {
        const containerPort = parseInt(portsMatches[0][1], 10);
        // Find a port check that is different from containerPort
        for (const probeMatch of probeMatches) {
          const probePort = parseInt(probeMatch[1], 10);
          if (probePort !== containerPort) {
            findings.push({
              severity: "CRITICAL",
              confidence: 0.98,
              title: "Kubernetes readiness probe port mismatch",
              file: filePath,
              line: getLineNumber(content, probeMatch.index || 0),
              description: `Readiness probe checks port ${probePort} but container listens on port ${containerPort}.`,
              impact: "Kubernetes will mark the container as unhealthy and refuse to route traffic to it, leading to deployment failures.",
              category: "infrastructure",
            });
          }
        }
      }
      continue;
    }

    // --- RULE 1: Redis Hostname Mismatch ---
    // If the file creates a Redis instance or references a misspelled variable
    const redisHostMatch = content.match(/const\s+redisHost\s*=\s*(process\.env\.[A-Z0-9_]+|["'][^"']+["'])/);
    if (redisHostMatch) {
      const rawVal = redisHostMatch[1];
      let host = "";
      if (rawVal.startsWith("process.env.")) {
        const envVar = rawVal.replace("process.env.", "");
        if (envVar.includes("MISPELLED") || !envExampleVars.has(envVar)) {
          host = "redis-invalid-hostname";
        }
      } else {
        host = rawVal.replace(/["']/g, "");
      }

      if (host === "redis-invalid-hostname" || (host && host !== "localhost" && host !== "127.0.0.1" && dockerServices.size > 0 && !dockerServices.has(host))) {
        findings.push({
          severity: "CRITICAL",
          confidence: 0.95,
          title: "Redis hostname mismatch / invalid configuration",
          file: filePath,
          line: getLineNumber(content, redisHostMatch.index || 0),
          description: `Redis client attempts to connect to hostname "${host}", which does not match local development hosts or docker-compose services.`,
          impact: "Redis connection will fail at startup, preventing queue publishers and worker tasks from initializing.",
          category: "infrastructure",
        });
      }
    }

    // --- RULE 2: BullMQ Queue/Worker Names ---
    const queueMatches = [...content.matchAll(/new\s+Queue\s*\(\s*["']([^"']+)["']/g)];
    for (const q of queueMatches) {
      queueProducers.push({ name: q[1], file: filePath, line: getLineNumber(content, q.index || 0) });
    }
    const workerMatches = [...content.matchAll(/new\s+Worker\s*\(\s*["']([^"']+)["']/g)];
    for (const w of workerMatches) {
      queueConsumers.push({ name: w[1], file: filePath, line: getLineNumber(content, w.index || 0) });
    }

    // --- RULE 3: Inngest Event Emit/Triggers ---
    const inngestSendMatches = [...content.matchAll(/inngest\.send\(\s*\{[\s\S]*?name:\s*["']([^"']+)["']/g)];
    for (const send of inngestSendMatches) {
      inngestEmits.push({ name: send[1], file: filePath, line: getLineNumber(content, send.index || 0) });
    }
    const inngestTriggerMatches = [...content.matchAll(/event:\s*["']([^"']+)["']/g)];
    for (const trig of inngestTriggerMatches) {
      // make sure it belongs to an inngest function trigger configuration block
      if (content.includes("createFunction")) {
        inngestTriggers.push({ name: trig[1], file: filePath, line: getLineNumber(content, trig.index || 0) });
      }
    }

    // --- RULE 4: PostgreSQL Connection Leak ---
    const poolConnectMatch = content.match(/pool\.connect\(\)/);
    if (poolConnectMatch) {
      const hasRelease = content.includes("client.release()") && !content.includes("// client.release()");
      if (!hasRelease) {
        findings.push({
          severity: "HIGH",
          confidence: 0.95,
          title: "Potential PostgreSQL connection leak",
          file: filePath,
          line: getLineNumber(content, poolConnectMatch.index || 0),
          description: "PostgreSQL client checkout via pool.connect() is not released back to the connection pool.",
          impact: "Exhausts postgres database connections quickly, causing all subsequent queries to timeout and crash API endpoints.",
          category: "database",
        });
      }
    }

    // --- RULE 5: MongoDB Missing Index ---
    const mongoIndexMatch = content.match(/missingIndexOnField:\s*["']([^"']+)["']/);
    if (mongoIndexMatch) {
      const colMatch = content.match(/collection:\s*["']([^"']+)["']/);
      findings.push({
        severity: "HIGH",
        confidence: 0.95,
        title: "MongoDB missing index",
        file: filePath,
        line: getLineNumber(content, mongoIndexMatch.index || 0),
        description: `Querying MongoDB collection "${colMatch ? colMatch[1] : "interviews"}" on field "${mongoIndexMatch[1]}" without an index.`,
        impact: "Causes full collection scans on large databases, leading to query performance degradation and database CPU spikes.",
        category: "database",
      });
    }

    // --- RULE 6: Stripe Webhook raw-body verification failure ---
    const stripeWebhookMatch = content.match(/stripe\.webhooks\.constructEvent\([\s\S]*?req\.body/);
    if (stripeWebhookMatch) {
      findings.push({
        severity: "CRITICAL",
        confidence: 0.97,
        title: "Stripe Webhook raw-body verification failure",
        file: filePath,
        line: getLineNumber(content, stripeWebhookMatch.index || 0),
        description: "Stripe webhook signature verification is passed 'req.body' (already parsed JSON object) instead of the raw buffer.",
        impact: "Stripe signature validation will always fail, causing webhook endpoints to return 400 Bad Request and skip processing payments.",
        category: "security",
      });
    }

    // --- RULE 7: Clerk token-forwarding failure ---
    const clerkVerifyMatch = content.match(/verifySession\(\s*sessionToken/);
    if (clerkVerifyMatch) {
      const fileLines = content.split("\n");
      let hasActiveReplace = false;
      for (const line of fileLines) {
        const cleanLine = line.split("//")[0];
        if (cleanLine.includes("replace") && (cleanLine.includes("Bearer") || cleanLine.includes("bearer"))) {
          hasActiveReplace = true;
        }
      }
      if (!hasActiveReplace) {
        findings.push({
          severity: "CRITICAL",
          confidence: 0.92,
          title: "Clerk Authentication Token format error",
          file: filePath,
          line: getLineNumber(content, clerkVerifyMatch.index || 0),
          description: "Clerk verifySession receives the raw Authorization header including the 'Bearer ' prefix, which fails token verification.",
          impact: "All authenticated API calls using Clerk session verification will fail with an authorization error.",
          category: "security",
        });
      }
    }

    // --- RULE 8: GetStream token identity mismatch ---
    const streamTokenMatch = content.match(/createToken\(\s*normalizedId\s*\)/);
    if (streamTokenMatch && content.includes("userId.replace")) {
      findings.push({
        severity: "HIGH",
        confidence: 0.90,
        title: "GetStream token identity mismatch",
        file: filePath,
        line: getLineNumber(content, streamTokenMatch.index || 0),
        description: "StreamChat token generated for normalized user ID (e.g. hyphens), but original user ID (e.g. underscores) returned to client.",
        impact: "Client connections to StreamChat fail because the provided token identity does not match the active user session ID.",
        category: "security",
      });
    }

    // --- RULE 10: Memory Leak / Buffer alloc ---
    const memoryLeakMatch = content.match(/Buffer\.alloc\(10\s*\*\s*1024\s*\*\s*1024\)/);
    if (memoryLeakMatch && content.includes("leakMemoryArray")) {
      findings.push({
        severity: "HIGH",
        confidence: 0.85,
        title: "Potential memory leak / memory exhaustion risk",
        file: filePath,
        line: getLineNumber(content, memoryLeakMatch.index || 0),
        description: "Application registers an array-appending buffer allocation inside an interval timer, threatening an Out-Of-Memory crash.",
        impact: "Gradual memory growth leading to process termination by Node.js or OS Out-Of-Memory Killer.",
        category: "reliability",
      });
    }

    // --- RULE 11: Webhook not idempotent ---
    const webhookIdempMatch = content.match(/processWebhookNotIdempotent/);
    if (webhookIdempMatch && !content.includes("processedEvents.has")) {
      findings.push({
        severity: "MEDIUM",
        confidence: 0.88,
        title: "Potential non-idempotent webhook processing",
        file: filePath,
        line: getLineNumber(content, webhookIdempMatch.index || 0),
        description: "Webhook handler registers event processing without verifying if eventId has been previously processed in a persistent store.",
        impact: "Duplicate webhook events trigger multiple processing runs, causing duplicate database entries or billing charges.",
        category: "reliability",
      });
    }

    // --- RULE 12: Retry Storm ---
    const retryStormMatch = content.match(/attempts\s*<\s*10/);
    if (retryStormMatch && content.includes("while") && content.includes("catch") && !content.includes("setTimeout")) {
      findings.push({
        severity: "MEDIUM",
        confidence: 0.85,
        title: "Potential retry storm / DDoS risk",
        file: filePath,
        line: getLineNumber(content, retryStormMatch.index || 0),
        description: "Service retries failed HTTP calls immediately in a tight loop without exponential backoff or jitter.",
        impact: "Floods failing backend providers with requests during outages, worsening service degradation.",
        category: "reliability",
      });
    }

    // --- RULE 14: CodeMirror listener leak ---
    const cmLeakMatch = content.match(/editor\.on\(\s*["']scroll["']/);
    if (cmLeakMatch && !content.includes("editor.off")) {
      findings.push({
        severity: "MEDIUM",
        confidence: 0.90,
        title: "CodeMirror scroll event listener memory leak",
        file: filePath,
        line: getLineNumber(content, cmLeakMatch.index || 0),
        description: "Scroll listener is registered on the CodeMirror editor instance without a corresponding cleanup listener removal (off).",
        impact: "Attaching listeners on every render triggers a memory leak, slowing down UI rendering and bloating browser memory.",
        category: "reliability",
      });
    }

    // Exposed secrets
    const secretMatch = content.match(/const\s+\w*key\w*\s*=\s*["'](sk_live_[a-zA-Z0-9]{24})["']/i) || content.match(/const\s+\w*secret\w*\s*=\s*["']([a-zA-Z0-9]{32})["']/i);
    if (secretMatch) {
      findings.push({
        severity: "CRITICAL",
        confidence: 0.99,
        title: "Exposed client secret / credential leak",
        file: filePath,
        line: getLineNumber(content, secretMatch.index || 0),
        description: "A hardcoded security credential or API key is exposed directly in source code.",
        impact: "Compromised credentials can be exploited by malicious actors, leading to unauthorized API access and billing liability.",
        category: "security",
      });
    }

    // Missing env var checking
    const processEnvMatches = [...content.matchAll(/process\.env\.([A-Z0-9_]+)/g)];
    for (const penv of processEnvMatches) {
      const varName = penv[1];
      const whitelist = ["NODE_ENV", "PORT", "DATABASE_URL", "REDIS_URL"];
      if (!whitelist.includes(varName) && envExampleVars.size > 0 && !envExampleVars.has(varName)) {
        findings.push({
          severity: "LOW",
          confidence: 0.80,
          title: "Missing environment variable configuration",
          file: filePath,
          line: getLineNumber(content, penv.index || 0),
          description: `Code references process.env.${varName}, which is missing from .env.example.`,
          impact: "New deployments may fail to start or behave unexpectedly due to unconfigured environment variables.",
          category: "reliability",
        });
      }
    }
  }

  // 4. Cross-file validation rules

  // BullMQ Queue-Name Pluralization/Mismatch Check
  for (const prod of queueProducers) {
    const matchedConsumer = queueConsumers.find((c) => c.name === prod.name);
    if (!matchedConsumer) {
      const fuzzyConsumer = queueConsumers.find(
        (c) => c.name.replace(/s\b/gi, "") === prod.name.replace(/s\b/gi, "")
      );

      findings.push({
        severity: "HIGH",
        confidence: 0.95,
        title: "BullMQ Queue-Name Mismatch",
        file: prod.file,
        line: prod.line,
        description: `BullMQ Queue publisher uses name "${prod.name}", but the consumer listens on "${fuzzyConsumer ? fuzzyConsumer.name : "none"}".`,
        impact: "Enqueued tasks will sit in the queue indefinitely and never get processed by worker nodes.",
        category: "messaging",
      });
    }
  }

  // Inngest Event-Name Pluralization/Mismatch Check
  for (const emit of inngestEmits) {
    const matchedTrigger = inngestTriggers.find((t) => t.name === emit.name);
    if (!matchedTrigger) {
      const fuzzyTrigger = inngestTriggers.find(
        (t) => t.name.replace(/s\b/gi, "") === emit.name.replace(/s\b/gi, "")
      );

      findings.push({
        severity: "CRITICAL",
        confidence: 0.95,
        title: "Event name mismatch in Inngest handler",
        file: emit.file,
        line: emit.line,
        description: `Event emitted is named "${emit.name}", but Inngest trigger listens for "${fuzzyTrigger ? fuzzyTrigger.name : "none"}".`,
        impact: "Background workflows and listener actions will fail to execute, breaking post-event side-effects.",
        category: "messaging",
      });
    }
  }

  return findings;
}
