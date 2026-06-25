import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { WebSocketContract, WebSocketEvent, WebSocketEventDirection } from "@opspilot/schemas";

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

export async function discoverWebSocketContracts(repoDirectory: string): Promise<WebSocketContract[]> {
  const sourceFiles = await findSourceFiles(repoDirectory);
  const contracts: WebSocketContract[] = [];

  for (const absolutePath of sourceFiles) {
    const content = await fs.promises.readFile(absolutePath, "utf8").catch(() => "");
    if (!content) continue;

    const relativePath = path.relative(repoDirectory, absolutePath).replace(/\\/g, "/");

    // Pre-filtering check: only parse files that mention websockets, socket.io, ws, or connect
    const lowerContent = content.toLowerCase();
    if (
      !lowerContent.includes("socket") &&
      !lowerContent.includes("websocket") &&
      !lowerContent.includes("io.on") &&
      !lowerContent.includes("ws.on")
    ) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      absolutePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    let hasServerCreation = false;
    let framework: "socket.io" | "ws" | "custom" = "socket.io";
    const namespaces = new Set<string>();
    const middleware: string[] = [];
    let handshakeAuth = false;
    let redisAdapter = false;
    const events: WebSocketEvent[] = [];

    const getLineNumber = (node: ts.Node): number => {
      return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    };

    const visit = (node: ts.Node) => {
      // 1. Detect server creation
      if (ts.isNewExpression(node) && node.expression) {
        const typeText = node.expression.getText(sourceFile);
        if (typeText === "Server" || typeText.includes("SocketIOServer") || typeText.includes("socketio.Server")) {
          hasServerCreation = true;
          framework = "socket.io";
        } else if (typeText === "WebSocketServer" || typeText.includes("ws.Server")) {
          hasServerCreation = true;
          framework = "ws";
        }
      }

      // Check imports/requires
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const modName = node.moduleSpecifier.text;
        if (modName === "socket.io") {
          hasServerCreation = true;
          framework = "socket.io";
        } else if (modName === "ws") {
          hasServerCreation = true;
          framework = "ws";
        } else if (modName.includes("redis-adapter")) {
          redisAdapter = true;
        }
      }

      if (ts.isCallExpression(node)) {
        const exp = node.expression;
        if (ts.isIdentifier(exp) && exp.text === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const modName = node.arguments[0].text;
          if (modName === "socket.io") {
            hasServerCreation = true;
            framework = "socket.io";
          } else if (modName === "ws") {
            hasServerCreation = true;
            framework = "ws";
          } else if (modName.includes("redis-adapter") || modName.includes("socket.io-redis")) {
            redisAdapter = true;
          }
        }
      }

      // 2. Namespaces
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const prop = node.expression;
        const methodName = prop.name.text;
        if (methodName === "of" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          namespaces.add(node.arguments[0].text);
        }
      }

      // 3. Middleware
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const prop = node.expression;
        if (prop.name.text === "use") {
          const caller = prop.expression.getText(sourceFile);
          if (caller === "io" || caller === "nsp" || caller.includes("namespace") || caller.includes("server")) {
            middleware.push(`Middleware: ${node.arguments[0]?.getText(sourceFile) || "unknown"}`);
          }
        }
      }

      // 4. Handshake Authentication
      if (ts.isPropertyAccessExpression(node)) {
        const text = node.getText(sourceFile);
        if (text.includes("socket.handshake") || text.includes("socket.request.headers")) {
          handshakeAuth = true;
        }
      }

      // 5. Redis Adapter
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === "createAdapter" || node.expression.text.includes("redisAdapter")) {
          redisAdapter = true;
        }
      }

      // 6. Listen Events (socket.on)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const prop = node.expression;
        const callerText = prop.expression.getText(sourceFile);
        const methodName = prop.name.text;

        if (
          (callerText === "socket" || callerText === "ws" || callerText === "io" || callerText.includes("conn")) &&
          (methodName === "on" || methodName === "once")
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const eventName = firstArg.text;
            if (eventName !== "connection" && eventName !== "disconnect" && eventName !== "error") {
              // Try to extract dynamic rooms from handler body if we join rooms
              const rooms: string[] = [];
              const callback = node.arguments[1];
              if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
                const findRoomJoins = (child: ts.Node) => {
                  if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
                    if (child.expression.name.text === "join") {
                      const joinArg = child.arguments[0];
                      if (joinArg) {
                        rooms.push(joinArg.getText(sourceFile).replace(/['"`]/g, ""));
                      }
                    }
                  }
                  ts.forEachChild(child, findRoomJoins);
                };
                findRoomJoins(callback);
              }

              events.push({
                name: eventName,
                direction: "client-to-server",
                rooms,
                payload: {
                  type: "object",
                  properties: {}
                },
                source: {
                  file: relativePath,
                  line: getLineNumber(node)
                }
              });
            }
          }
        }
      }

      // 7. Emit Events (socket.emit, io.emit, io.to(room).emit)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const prop = node.expression;
        const methodName = prop.name.text;

        if (methodName === "emit" || methodName === "send") {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const eventName = firstArg.text;
            
            // Check for rooms targeted in method chain: io.to('room-123').emit('event')
            const rooms: string[] = [];
            let currentExpr = prop.expression;
            while (ts.isCallExpression(currentExpr) && ts.isPropertyAccessExpression(currentExpr.expression)) {
              const chainMethod = currentExpr.expression.name.text;
              if (chainMethod === "to" || chainMethod === "in" || chainMethod === "room") {
                const roomArg = currentExpr.arguments[0];
                if (roomArg) {
                  rooms.push(roomArg.getText(sourceFile).replace(/['"`]/g, ""));
                }
              }
              currentExpr = currentExpr.expression.expression;
            }

            events.push({
              name: eventName,
              direction: "server-to-client",
              rooms,
              payload: {
                type: "object",
                properties: {}
              },
              source: {
                file: relativePath,
                line: getLineNumber(node)
              }
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // If events are discovered or a WebSocket server instantiation is found
    if (hasServerCreation || events.length > 0) {
      contracts.push({
        id: `ws-${relativePath.replace(/\//g, "-").replace(/\.[^.]+$/, "")}`,
        url: "ws://localhost:4000", // default template URL, populated at test/execution time
        framework,
        namespaces: [...namespaces],
        middleware,
        handshakeAuth: handshakeAuth ? { required: true } : {},
        events,
        redisAdapter,
        source: {
          file: relativePath,
          line: 1
        }
      });
    }
  }

  return contracts;
}
