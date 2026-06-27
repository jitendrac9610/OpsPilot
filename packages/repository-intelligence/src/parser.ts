import fs from "fs";
import path from "path";
import ts from "typescript";

export interface ExtractedSymbol {
  name: string;
  kind: string; // 'class' | 'function' | 'method' | 'route' | 'query' | 'event' | 'webhook' | 'interface' | 'queue producer' | 'queue consumer'
  line: number;
  startLine: number;
  endLine: number;
}

export interface ExtractedRelation {
  sourceSymbol: string;
  targetSymbol: string;
  type: string; // 'IMPORTS' | 'CALLS' | 'READS_FROM' | 'WRITES_TO' | 'PUBLISHES_TO' | 'CONSUMES_FROM' | 'CALLS_EXTERNAL'
  file: string;
  line: number;
}

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
}

export interface ParseResult {
  symbols: ExtractedSymbol[];
  chunks: CodeChunk[];
  relations: ExtractedRelation[];
  imports: string[];
}

// Helper to get line numbers in TS AST
function getLineFromPos(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

// TypeScript AST Parser
function parseTypeScript(content: string, relativePath: string, absolutePath: string): {
  symbols: ExtractedSymbol[];
  relations: ExtractedRelation[];
  imports: string[];
} {
  const symbols: ExtractedSymbol[] = [];
  const relations: ExtractedRelation[] = [];
  const imports: string[] = [];

  const sourceFile = ts.createSourceFile(
    absolutePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  const visit = (node: ts.Node) => {
    // 1. Imports
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    }

    // 2. Classes
    if (ts.isClassDeclaration(node) && node.name) {
      const startLine = getLineFromPos(sourceFile, node.getStart());
      const endLine = getLineFromPos(sourceFile, node.getEnd());
      symbols.push({
        name: node.name.text,
        kind: "class",
        line: startLine,
        startLine,
        endLine
      });
    }

    // 3. Interfaces
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const startLine = getLineFromPos(sourceFile, node.getStart());
      const endLine = getLineFromPos(sourceFile, node.getEnd());
      symbols.push({
        name: node.name.text,
        kind: "interface",
        line: startLine,
        startLine,
        endLine
      });
    }

    // 4. Functions
    if (ts.isFunctionDeclaration(node) && node.name) {
      const startLine = getLineFromPos(sourceFile, node.getStart());
      const endLine = getLineFromPos(sourceFile, node.getEnd());
      symbols.push({
        name: node.name.text,
        kind: "function",
        line: startLine,
        startLine,
        endLine
      });
    }

    // Arrow functions / Function expressions assigned to constants
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      if (
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        const startLine = getLineFromPos(sourceFile, node.getStart());
        const endLine = getLineFromPos(sourceFile, node.getEnd());
        symbols.push({
          name: node.name.text,
          kind: "function",
          line: startLine,
          startLine,
          endLine
        });
      }
    }

    // 5. Instantiations (BullMQ Queue/Worker)
    if (ts.isNewExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
      const className = node.expression.text;
      if (className === "Queue" || className === "Worker") {
        const firstArg = node.arguments?.[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          const startLine = getLineFromPos(sourceFile, node.getStart());
          const endLine = getLineFromPos(sourceFile, node.getEnd());
          symbols.push({
            name: `${className}: ${firstArg.text}`,
            kind: className === "Queue" ? "queue producer" : "queue consumer",
            line: startLine,
            startLine,
            endLine
          });
        }
      }
    }

    // 6. Express Routes / Call Expressions
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      
      // router.get('/path', ...) or app.post(...)
      if (ts.isPropertyAccessExpression(expression)) {
        const baseObj = expression.expression;
        const propName = expression.name.text;
        const methods = ["get", "post", "put", "delete", "patch"];

        if (
          ts.isIdentifier(baseObj) &&
          (baseObj.text === "app" || baseObj.text === "router" || baseObj.text === "route") &&
          methods.includes(propName)
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const startLine = getLineFromPos(sourceFile, node.getStart());
            const endLine = getLineFromPos(sourceFile, node.getEnd());
            symbols.push({
              name: `${propName.toUpperCase()} ${firstArg.text}`,
              kind: "route",
              line: startLine,
              startLine,
              endLine
            });
          }
        }

        // Prisma / DB Queries
        // prisma.user.findMany(...)
        if (ts.isPropertyAccessExpression(baseObj)) {
          const clientObj = baseObj.expression;
          const modelName = baseObj.name.text;
          const operations = ["findUnique", "findMany", "findFirst", "create", "update", "delete", "upsert"];
          
          if (
            ts.isIdentifier(clientObj) &&
            (clientObj.text === "prisma" || clientObj.text === "db") &&
            operations.includes(propName)
          ) {
            const startLine = getLineFromPos(sourceFile, node.getStart());
            symbols.push({
              name: `Prisma: ${modelName}.${propName}`,
              kind: "query",
              line: startLine,
              startLine,
              endLine: startLine
            });
          }
        }

        // Inngest Function Definitions or Event Emit
        if (ts.isIdentifier(baseObj) && baseObj.text === "inngest") {
          if (propName === "createFunction") {
            // inngest.createFunction({ id: '...' }, { event: '...' })
            const firstArg = node.arguments[0];
            const secondArg = node.arguments[1];
            let funcId = "unknown";
            let triggerEvent = "unknown";

            if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
              for (const prop of firstArg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "id" &&
                  ts.isStringLiteral(prop.initializer)
                ) {
                  funcId = prop.initializer.text;
                  break;
                }
              }
            }

            if (secondArg && ts.isObjectLiteralExpression(secondArg)) {
              for (const prop of secondArg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "event" &&
                  ts.isStringLiteral(prop.initializer)
                ) {
                  triggerEvent = prop.initializer.text;
                  break;
                }
              }
            }

            const startLine = getLineFromPos(sourceFile, node.getStart());
            const endLine = getLineFromPos(sourceFile, node.getEnd());
            symbols.push({
              name: `Inngest Function: ${funcId} (${triggerEvent})`,
              kind: "event",
              line: startLine,
              startLine,
              endLine
            });
          } else if (propName === "send") {
            // inngest.send({ name: '...' })
            const firstArg = node.arguments[0];
            let eventName = "unknown";

            if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
              for (const prop of firstArg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "name" &&
                  ts.isStringLiteral(prop.initializer)
                ) {
                  eventName = prop.initializer.text;
                  break;
                }
              }
            } else if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
              // Array of events
              const firstElem = firstArg.elements[0];
              if (firstElem && ts.isObjectLiteralExpression(firstElem)) {
                for (const prop of firstElem.properties) {
                  if (
                    ts.isPropertyAssignment(prop) &&
                    ts.isIdentifier(prop.name) &&
                    prop.name.text === "name" &&
                    ts.isStringLiteral(prop.initializer)
                  ) {
                    eventName = prop.initializer.text;
                    break;
                  }
                }
              }
            }

            const startLine = getLineFromPos(sourceFile, node.getStart());
            const endLine = getLineFromPos(sourceFile, node.getEnd());
            symbols.push({
              name: `Inngest Emit: ${eventName}`,
              kind: "event",
              line: startLine,
              startLine,
              endLine
            });
          }
        }

        // WebSocket logic: socket.on, socket.emit, io.emit, ws.on, ws.send, socket.join
        const baseText = ts.isIdentifier(baseObj) ? baseObj.text : "";
        if (
          (baseText === "socket" || baseText === "io" || baseText === "ws" || baseText === "conn") &&
          (propName === "on" || propName === "emit" || propName === "send" || propName === "join")
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const eventName = firstArg.text;
            const startLine = getLineFromPos(sourceFile, node.getStart());
            const endLine = getLineFromPos(sourceFile, node.getEnd());
            let kind = "event";
            let symName = "";
            if (propName === "on") {
              symName = `WebSocket Listen: ${eventName}`;
            } else if (propName === "emit" || propName === "send") {
              symName = `WebSocket Emit: ${eventName}`;
            } else if (propName === "join") {
              symName = `WebSocket Join: ${eventName}`;
            }
            if (symName) {
              symbols.push({
                name: symName,
                kind,
                line: startLine,
                startLine,
                endLine
              });
            }
          }
        }

        // Webhook stripe logic: stripe.webhooks.constructEvent(...)
        if (propName === "constructEvent") {
          let isStripe = false;
          if (ts.isPropertyAccessExpression(baseObj)) {
            const clientObj = baseObj.expression;
            const subProp = baseObj.name.text;
            if (ts.isIdentifier(clientObj) && clientObj.text === "stripe" && subProp === "webhooks") {
              isStripe = true;
            }
          }
          if (isStripe) {
            const startLine = getLineFromPos(sourceFile, node.getStart());
            const endLine = getLineFromPos(sourceFile, node.getEnd());
            symbols.push({
              name: "Webhook: stripe",
              kind: "webhook",
              line: startLine,
              startLine,
              endLine
            });
          }
        }
      }
    }

    // Header signature check detection
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (arg && ts.isStringLiteral(arg)) {
        const text = arg.text.toLowerCase();
        if (text === "stripe-signature" || text === "x-hub-signature-256" || text === "x-hub-signature" || text === "x-razorpay-signature") {
          const provider = text.includes("stripe") ? "stripe" : text.includes("hub") ? "github" : text.includes("razorpay") ? "razorpay" : "custom";
          const startLine = getLineFromPos(sourceFile, node.getStart());
          const endLine = getLineFromPos(sourceFile, node.getEnd());
          if (!symbols.some(s => s.name === `Webhook Signature: ${provider}` && s.line === startLine)) {
            symbols.push({
              name: `Webhook Signature: ${provider}`,
              kind: "webhook",
              line: startLine,
              startLine,
              endLine
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { symbols, relations, imports };
}

export function parseFile(language: string, relativePath: string, absolutePath: string): ParseResult {
  const symbols: ExtractedSymbol[] = [];
  const chunks: CodeChunk[] = [];
  const relations: ExtractedRelation[] = [];
  const imports: string[] = [];

  if (!fs.existsSync(absolutePath)) {
    return { symbols, chunks, relations, imports };
  }

  let content = fs.readFileSync(absolutePath, "utf-8");
  content = content.replace(/\u0000/g, "");
  const lines = content.split("\n");

  const getBlockRange = (startLineIdx: number): { endLine: number } => {
    let openBrackets = 0;
    let foundBracket = false;
    for (let i = startLineIdx; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("{")) {
        openBrackets += (line.match(/{/g) || []).length;
        foundBracket = true;
      }
      if (line.includes("}")) {
        openBrackets -= (line.match(/}/g) || []).length;
      }
      if (foundBracket && openBrackets <= 0) {
        return { endLine: i + 1 };
      }
    }
    return { endLine: lines.length };
  };

  const getPythonBlockRange = (startLineIdx: number, baseIndent: number): { endLine: number } => {
    for (let i = startLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) {
        return { endLine: i };
      }
    }
    return { endLine: lines.length };
  };

  if (language === "TypeScript" || language === "JavaScript") {
    const astResult = parseTypeScript(content, relativePath, absolutePath);
    symbols.push(...astResult.symbols);
    relations.push(...astResult.relations);
    imports.push(...astResult.imports);
  } else if (language === "Python") {
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const indent = lineText.length - lineText.trimStart().length;

      // Imports
      const importMatch = lineText.match(/import\s+([A-Za-z0-9_., ]+)/) || lineText.match(/from\s+([A-Za-z0-9_.]+)\s+import/);
      if (importMatch) {
        imports.push(importMatch[1].trim());
        continue;
      }

      // WebSockets and Webhooks in Python
      const pyWsMatch = lineText.match(/@(?:sio|socketio)\.on\(['"]([^'"]+)['"]/);
      if (pyWsMatch) {
        const eventName = pyWsMatch[1];
        const range = getPythonBlockRange(i, indent);
        symbols.push({ name: `WebSocket Listen: ${eventName}`, kind: "event", line: i + 1, startLine: i + 1, endLine: range.endLine });
        continue;
      }

      const pyWebhookMatch = lineText.match(/Webhook\.construct_event\(/);
      if (pyWebhookMatch) {
        symbols.push({ name: "Webhook: stripe", kind: "webhook", line: i + 1, startLine: i + 1, endLine: i + 1 });
        continue;
      }

      // FastAPI / Flask Routes
      const routeMatch = lineText.match(/@(?:app|router)\.(get|post|put|delete)\(['"]([^'"]+)['"]/);
      if (routeMatch) {
        const method = routeMatch[1].toUpperCase();
        const routePath = routeMatch[2];
        const name = `${method} ${routePath}`;
        const range = getPythonBlockRange(i, indent);
        symbols.push({ name, kind: "route", line: i + 1, startLine: i + 1, endLine: range.endLine });
        continue;
      }

      // Class
      const classMatch = lineText.match(/class\s+([A-Za-z0-9_]+)(?:\(.*?\))?:/);
      if (classMatch) {
        const name = classMatch[1];
        const range = getPythonBlockRange(i, indent);
        symbols.push({ name, kind: "class", line: i + 1, startLine: i + 1, endLine: range.endLine });
        continue;
      }

      // Def function
      const defMatch = lineText.match(/def\s+([A-Za-z0-9_]+)\s*\(/);
      if (defMatch) {
        const name = defMatch[1];
        const range = getPythonBlockRange(i, indent);
        symbols.push({ name, kind: "function", line: i + 1, startLine: i + 1, endLine: range.endLine });
      }
    }
  } else if (language === "Java") {
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];

      // WebSockets and Webhooks in Java
      const javaWsMatch = lineText.match(/@OnMessage|@OnOpen|@OnClose/);
      if (javaWsMatch) {
        symbols.push({ name: `WebSocket Event: ${javaWsMatch[0]}`, kind: "event", line: i + 1, startLine: i + 1, endLine: i + 1 });
        continue;
      }
      const javaWebhookMatch = lineText.match(/Webhook\.constructEvent\(/);
      if (javaWebhookMatch) {
        symbols.push({ name: "Webhook: stripe", kind: "webhook", line: i + 1, startLine: i + 1, endLine: i + 1 });
        continue;
      }

      // Routes (Spring boot annotations)
      const mappingMatch = lineText.match(/@(GetMapping|PostMapping|PutMapping|DeleteMapping)\s*\(\s*["']([^"']+)["']\s*\)/);
      if (mappingMatch) {
        const method = mappingMatch[1].replace("Mapping", "").toUpperCase();
        const routePath = mappingMatch[2];
        const name = `${method} ${routePath}`;
        const range = getBlockRange(i);
        symbols.push({ name, kind: "route", line: i + 1, startLine: i + 1, endLine: range.endLine });
        continue;
      }

      // Class definitions
      const classMatch = lineText.match(/(?:public|private|protected)?\s*class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        const name = classMatch[1];
        const range = getBlockRange(i);
        symbols.push({ name, kind: "class", line: i + 1, startLine: i + 1, endLine: range.endLine });
        continue;
      }

      // Methods
      const methodMatch = lineText.match(/(?:public|private|protected|static)\s+[\w<>]+\s+([A-Za-z0-9_]+)\s*\(/);
      if (methodMatch) {
        const name = methodMatch[1];
        if (name !== "class") {
          const range = getBlockRange(i);
          symbols.push({ name, kind: "method", line: i + 1, startLine: i + 1, endLine: range.endLine });
        }
      }
    }
  } else if (language === "Go") {
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];

      // WebSockets and Webhooks in Go
      const goWebhookMatch = lineText.match(/Webhook\.ConstructEvent\(/);
      if (goWebhookMatch) {
        symbols.push({ name: "Webhook: stripe", kind: "webhook", line: i + 1, startLine: i + 1, endLine: i + 1 });
        continue;
      }

      // Route
      const handlerMatch = lineText.match(/(?:\.HandleFunc|\.Handle)\(['"]([^'"]+)['"],\s*([A-Za-z0-9_]+)/);
      if (handlerMatch) {
        const routePath = handlerMatch[1];
        const handlerName = handlerMatch[2];
        const name = `Go Route: ${routePath} -> ${handlerName}`;
        symbols.push({ name, kind: "route", line: i + 1, startLine: i + 1, endLine: i + 1 });
        continue;
      }

      // Struct/Interface definitions
      const typeMatch = lineText.match(/type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const kind = typeMatch[2] === "struct" ? "class" : "interface";
        const range = getBlockRange(i);
        symbols.push({ name, kind, line: i + 1, startLine: i + 1, endLine: range.endLine });
        continue;
      }

      // Function/Method definitions
      const funcMatch = lineText.match(/func\s+(?:\(.*?\)\s*)?([A-Za-z0-9_]+)\s*\(/);
      if (funcMatch) {
        const name = funcMatch[1];
        const range = getBlockRange(i);
        symbols.push({ name, kind: "function", line: i + 1, startLine: i + 1, endLine: range.endLine });
      }
    }
  }

  // 4. Generate Semantic Code Chunks
  // Filter top-level symbols for chunking to avoid overlapping/duplicated chunks
  const topLevelSymbols = symbols.filter(sym => {
    return !symbols.some(other => {
      if (other === sym) return false;
      const encloses = other.startLine <= sym.startLine && other.endLine >= sym.endLine;
      if (encloses) {
        if (other.startLine === sym.startLine && other.endLine === sym.endLine) {
          return symbols.indexOf(other) < symbols.indexOf(sym);
        }
        return true;
      }
      return false;
    });
  });

  // Sort top-level symbols by startLine
  const sortedSymbols = [...topLevelSymbols].sort((a, b) => a.startLine - b.startLine);
  let currentLine = 1;

  for (const sym of sortedSymbols) {
    if (sym.startLine > currentLine) {
      const contentSlice = lines.slice(currentLine - 1, sym.startLine - 1).join("\n");
      if (contentSlice.trim()) {
        chunks.push({
          content: contentSlice,
          startLine: currentLine,
          endLine: sym.startLine - 1
        });
      }
    }
    const symbolContent = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
    chunks.push({
      content: symbolContent,
      startLine: sym.startLine,
      endLine: sym.endLine
    });
    currentLine = sym.endLine + 1;
  }

  if (currentLine <= lines.length) {
    const remainingContent = lines.slice(currentLine - 1).join("\n");
    if (remainingContent.trim()) {
      chunks.push({
        content: remainingContent,
        startLine: currentLine,
        endLine: lines.length
      });
    }
  }

  return { symbols, chunks, relations, imports };
}
