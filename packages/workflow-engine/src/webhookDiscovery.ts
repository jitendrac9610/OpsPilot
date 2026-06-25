import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { WebhookContract, WebhookProvider } from "@opspilot/schemas";

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "sandbox"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

async function findSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [path.resolve(dir)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        pending.push(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  return files;
}

export async function discoverWebhookContracts(repoDirectory: string): Promise<WebhookContract[]> {
  const sourceFiles = await findSourceFiles(repoDirectory);
  const contracts: WebhookContract[] = [];

  for (const absolutePath of sourceFiles) {
    const content = await fs.promises.readFile(absolutePath, "utf8").catch(() => "");
    if (!content) continue;

    const relativePath = path.relative(repoDirectory, absolutePath).replace(/\\/g, "/");

    let provider: WebhookProvider | undefined;
    let endpointUrl = "";
    let signingSecretEnvVar = "";
    const eventTypes: string[] = [];
    let isWebhookFile = false;

    // 1. Detect provider and secret env var from file content using regex
    if (content.includes("stripe.webhooks.constructEvent") || content.includes("stripe-signature")) {
      provider = "stripe";
      isWebhookFile = true;
      const match = content.match(/process\.env\.([A-Z0-9_]+STRIPE[A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET|[A-Z0-9_]*STRIPE[A-Z0-9_]*SECRET)/i) || 
                    content.match(/process\.env\.([A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET)/i);
      signingSecretEnvVar = match ? match[1] : "STRIPE_WEBHOOK_SECRET";
      
      // Default common events
      eventTypes.push("payment_intent.succeeded", "charge.refunded");
    } else if (content.includes("x-hub-signature-256") || content.includes("x-hub-signature") || content.includes("github-webhook")) {
      provider = "github";
      isWebhookFile = true;
      const match = content.match(/process\.env\.([A-Z0-9_]*GITHUB[A-Z0-9_]*SECRET|[A-Z0-9_]*GITHUB[A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET)/i) ||
                    content.match(/process\.env\.([A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET)/i);
      signingSecretEnvVar = match ? match[1] : "GITHUB_WEBHOOK_SECRET";
      
      eventTypes.push("push", "pull_request", "ping");
    } else if (content.includes("x-razorpay-signature") || content.includes("razorpay-signature")) {
      provider = "razorpay";
      isWebhookFile = true;
      const match = content.match(/process\.env\.([A-Z0-9_]*RAZORPAY[A-Z0-9_]*SECRET|[A-Z0-9_]*RAZORPAY[A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET)/i) ||
                    content.match(/process\.env\.([A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET)/i);
      signingSecretEnvVar = match ? match[1] : "RAZORPAY_WEBHOOK_SECRET";
      
      eventTypes.push("payment.captured", "order.paid");
    } else if (content.includes("x-webhook-signature") || content.includes("webhookSecret") || relativePath.includes("webhook")) {
      provider = "custom";
      isWebhookFile = true;
      const match = content.match(/process\.env\.([A-Z0-9_]*WEBHOOK[A-Z0-9_]*SECRET)/i);
      signingSecretEnvVar = match ? match[1] : "WEBHOOK_SECRET";
      
      eventTypes.push("custom_event");
    }

    if (!isWebhookFile || !provider) continue;

    // 2. Resolve endpoint URL from file path (Next.js / Express routes)
    // Next.js App Router (e.g. app/api/webhooks/stripe/route.ts -> /api/webhooks/stripe)
    const appMatch = relativePath.match(/(?:^|\/)(?:src\/)?app\/(.+)\/route\.(?:ts|js)$/);
    // Next.js Pages Router (e.g. pages/api/webhooks/stripe.ts -> /api/webhooks/stripe)
    const pagesMatch = relativePath.match(/(?:^|\/)(?:src\/)?pages\/(.+)\.(?:ts|js)$/);

    if (appMatch) {
      endpointUrl = `/${appMatch[1]}`;
    } else if (pagesMatch) {
      endpointUrl = `/${pagesMatch[1]}`;
    } else {
      // Express / other routers: scan file for route path
      const sourceFile = ts.createSourceFile(
        absolutePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );
      
      let routePath = "";
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const propName = node.expression.name.text;
          const callerName = node.expression.expression.getText(sourceFile);
          
          if (
            (callerName === "router" || callerName === "app" || callerName === "route") &&
            (propName === "post" || propName === "use" || propName === "all")
          ) {
            const firstArg = node.arguments[0];
            if (firstArg && ts.isStringLiteral(firstArg)) {
              routePath = firstArg.text;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      
      visit(sourceFile);
      
      if (routePath) {
        endpointUrl = routePath;
      } else {
        // Fallback: guess endpoint URL based on provider name
        endpointUrl = `/api/webhooks/${provider}`;
      }
    }

    // Standardize URL leading slash
    if (endpointUrl && !endpointUrl.startsWith("/")) {
      endpointUrl = `/${endpointUrl}`;
    }

    const startLine = 1;

    contracts.push({
      id: `webhook-${provider}-${relativePath.replace(/\//g, "-").replace(/\.[^.]+$/, "")}`,
      type: "incoming",
      provider,
      endpointUrl,
      eventTypes,
      signingSecretEnvVar,
      payloadSchema: {
        type: "object",
        properties: {}
      },
      source: {
        file: relativePath,
        line: startLine
      }
    });
  }

  return contracts;
}
