import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { QueueContract } from "@opspilot/schemas";

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

function getNewExpressionClassName(node: ts.NewExpression): string {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
    return node.expression.name.text;
  }
  return "";
}

export async function discoverQueueContracts(repoDirectory: string): Promise<QueueContract[]> {
  const sourceFiles = await findSourceFiles(repoDirectory);
  const queueMap = new Map<string, QueueContract>();

  for (const absolutePath of sourceFiles) {
    const content = await fs.promises.readFile(absolutePath, "utf8").catch(() => "");
    if (!content) continue;

    const relativePath = path.relative(repoDirectory, absolutePath).replace(/\\/g, "/");

    const sourceFile = ts.createSourceFile(
      absolutePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const visit = (node: ts.Node) => {
      // 1. Detect BullMQ Queue/Worker instantiations: new Queue("name") / new Worker("name")
      if (ts.isNewExpression(node)) {
        const className = getNewExpressionClassName(node);
        if (className === "Queue" || className === "Worker") {
          const firstArg = node.arguments?.[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const queueName = firstArg.text;
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

            let contract = queueMap.get(queueName);
            if (!contract) {
              contract = {
                id: `queue-${queueName}`,
                name: queueName,
                type: "bullmq",
                producers: [],
                consumers: [],
                payloadSchema: {
                  type: "object",
                  properties: {}
                },
                source: {
                  file: relativePath,
                  line
                }
              };
              queueMap.set(queueName, contract);
            }

            if (className === "Queue") {
              if (!contract.producers.some(p => p.file === relativePath && p.line === line)) {
                contract.producers.push({ file: relativePath, line });
              }
            } else {
              if (!contract.consumers.some(c => c.file === relativePath && c.line === line)) {
                contract.consumers.push({ file: relativePath, line });
              }
            }
          }
        }
      }

      // 2. Detect Redis publish/subscribe calls: redis.publish("channel", ...) / pubClient.publish(...)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const propName = node.expression.name.text;
        const caller = node.expression.expression;
        if (ts.isIdentifier(caller) && (caller.text === "redis" || caller.text === "pubClient" || caller.text === "subClient")) {
          if (propName === "publish" || propName === "subscribe") {
            const firstArg = node.arguments[0];
            if (firstArg && ts.isStringLiteral(firstArg)) {
              const channelName = firstArg.text;
              const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              const queueName = channelName;

              let contract = queueMap.get(queueName);
              if (!contract) {
                contract = {
                  id: `queue-${queueName}`,
                  name: queueName,
                  type: "redis-pubsub",
                  producers: [],
                  consumers: [],
                  payloadSchema: {
                    type: "object",
                    properties: {}
                  },
                  source: {
                    file: relativePath,
                    line
                  }
                };
                queueMap.set(queueName, contract);
              }

              if (propName === "publish") {
                if (!contract.producers.some(p => p.file === relativePath && p.line === line)) {
                  contract.producers.push({ file: relativePath, line });
                }
              } else {
                if (!contract.consumers.some(c => c.file === relativePath && c.line === line)) {
                  contract.consumers.push({ file: relativePath, line });
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return [...queueMap.values()];
}
