import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  ContractSchemaNode,
  EndpointContract,
  EndpointMiddleware,
  EndpointParameter,
  EndpointSecurity,
  PrismaRequirement,
  RequestBodyContract,
  ResponseContract
} from "@opspilot/schemas";
import {
  endpointContractId,
  joinRoutePaths,
  mergeSchema,
  pathParameters,
  unique,
  uniqueBy
} from "./contractUtils.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

interface ImportBinding {
  targetFile?: string;
  importedName: string;
  moduleName: string;
}

interface RouteRecord {
  file: IndexedFile;
  routerName: string;
  method: string;
  routePath: string;
  arguments: ts.Expression[];
  node: ts.CallExpression;
}

interface MountRecord {
  file: IndexedFile;
  parentRouter: string;
  prefix: string;
  target: ts.Expression;
  middleware: ts.Expression[];
  node: ts.CallExpression;
}

interface RouterMiddleware {
  routerName: string;
  expressions: ts.Expression[];
  position: number;
}

interface IndexedFile {
  absolutePath: string;
  relativePath: string;
  sourceFile: ts.SourceFile;
  declarations: Map<string, ts.Node>;
  exports: Map<string, string>;
  imports: Map<string, ImportBinding>;
  routerNames: Set<string>;
  routes: RouteRecord[];
  mounts: MountRecord[];
  middleware: RouterMiddleware[];
}

interface RouterContext {
  prefix: string;
  middleware: ts.Expression[];
}

interface ResolvedNode {
  file: IndexedFile;
  node: ts.Node;
}

interface ParsedSchema {
  schema: ContractSchemaNode;
  optional: boolean;
  requiredExplicit: boolean;
}

interface EndpointAnalysis {
  parameters: EndpointParameter[];
  requestBody?: RequestBodyContract;
  responses: ResponseContract[];
  middleware: EndpointMiddleware[];
  security: EndpointSecurity[];
  roles: string[];
  permissions: string[];
  requiredEnvironment: string[];
  prisma: PrismaRequirement[];
  evidence: string[];
}

interface PrismaModel {
  relations: Set<string>;
}

export async function discoverTypeScriptContracts(root: string): Promise<EndpointContract[]> {
  const index = await CodeIndex.create(root);
  const prismaModels = await discoverPrismaModels(root);
  return [
    ...discoverExpressContracts(index, prismaModels),
    ...discoverNextContracts(index, prismaModels)
  ];
}

class CodeIndex {
  public readonly files = new Map<string, IndexedFile>();

  private constructor(public readonly root: string) {}

  public static async create(root: string): Promise<CodeIndex> {
    const index = new CodeIndex(path.resolve(root));
    const sourcePaths = await listSourceFiles(root);
    for (const absolutePath of sourcePaths) {
      const content = await fs.promises.readFile(absolutePath, "utf8").catch(() => "");
      const relativePath = normalizeRelative(path.relative(root, absolutePath));
      const sourceFile = ts.createSourceFile(
        absolutePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(absolutePath)
      );
      const file: IndexedFile = {
        absolutePath,
        relativePath,
        sourceFile,
        declarations: new Map(),
        exports: new Map(),
        imports: new Map(),
        routerNames: new Set(),
        routes: [],
        mounts: [],
        middleware: []
      };
      index.files.set(path.resolve(absolutePath), file);
    }
    for (const file of index.files.values()) index.indexTopLevel(file);
    for (const file of index.files.values()) index.indexRoutes(file);
    return index;
  }

  public resolveExpression(file: IndexedFile, expression: ts.Expression, seen = new Set<string>()): ResolvedNode | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped) || ts.isObjectLiteralExpression(unwrapped)) {
      return { file, node: unwrapped };
    }
    if (ts.isIdentifier(unwrapped)) {
      return this.resolveName(file, unwrapped.text, seen);
    }
    if (ts.isCallExpression(unwrapped)) {
      const wrapperArguments = unwrapped.arguments.filter(ts.isExpression);
      for (let index = wrapperArguments.length - 1; index >= 0; index--) {
        const resolved = this.resolveExpression(file, wrapperArguments[index], seen);
        if (resolved && isHandlerLike(resolved.node)) return resolved;
      }
    }
    if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
      const binding = file.imports.get(unwrapped.expression.text);
      if (binding?.targetFile) {
        const target = this.files.get(binding.targetFile);
        if (target) return this.resolveName(target, unwrapped.name.text, seen);
      }
    }
    return undefined;
  }

  public resolveName(file: IndexedFile, name: string, seen = new Set<string>()): ResolvedNode | undefined {
    const key = `${file.absolutePath}:${name}`;
    if (seen.has(key)) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(key);

    const local = file.declarations.get(name);
    if (local) {
      if (ts.isVariableDeclaration(local) && local.initializer) {
        const initializer = unwrapExpression(local.initializer);
        if (ts.isIdentifier(initializer) && initializer.text !== name) {
          return this.resolveName(file, initializer.text, nextSeen) || { file, node: local };
        }
      }
      return { file, node: local };
    }

    const binding = file.imports.get(name);
    if (!binding?.targetFile) return undefined;
    const target = this.files.get(binding.targetFile);
    if (!target) return undefined;
    const exportedLocal = target.exports.get(binding.importedName) ||
      (binding.importedName === "default" ? target.exports.get("default") : binding.importedName);
    return exportedLocal ? this.resolveName(target, exportedLocal, nextSeen) : undefined;
  }

  public resolveRouter(file: IndexedFile, expression: ts.Expression): string | undefined {
    const value = unwrapExpression(expression);
    if (!ts.isIdentifier(value)) return undefined;
    if (file.routerNames.has(value.text)) return routerKey(file, value.text);
    const binding = file.imports.get(value.text);
    if (!binding?.targetFile) return undefined;
    const target = this.files.get(binding.targetFile);
    if (!target) return undefined;
    const localName = target.exports.get(binding.importedName) ||
      (binding.importedName === "default" ? target.exports.get("default") : binding.importedName);
    if (localName && target.routerNames.has(localName)) return routerKey(target, localName);
    if (target.routerNames.size === 1) return routerKey(target, [...target.routerNames][0]);
    return undefined;
  }

  private indexTopLevel(file: IndexedFile) {
    for (const statement of file.sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const targetFile = this.resolveModule(file.absolutePath, statement.moduleSpecifier.text);
        const clause = statement.importClause;
        if (clause?.name) {
          file.imports.set(clause.name.text, {
            targetFile,
            importedName: "default",
            moduleName: statement.moduleSpecifier.text
          });
        }
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            file.imports.set(element.name.text, {
              targetFile,
              importedName: element.propertyName?.text || element.name.text,
              moduleName: statement.moduleSpecifier.text
            });
          }
        }
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          file.imports.set(clause.namedBindings.name.text, {
            targetFile,
            importedName: "*",
            moduleName: statement.moduleSpecifier.text
          });
        }
      }

      if (ts.isVariableStatement(statement)) {
        const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const name = declaration.name.text;
          file.declarations.set(name, declaration);
          if (exported) file.exports.set(name, name);
          if (declaration.initializer && isRouterInitializer(declaration.initializer)) {
            file.routerNames.add(name);
          }
          const requireBinding = declaration.initializer && requireModule(declaration.initializer);
          if (requireBinding) {
            file.imports.set(name, {
              targetFile: this.resolveModule(file.absolutePath, requireBinding),
              importedName: "default",
              moduleName: requireBinding
            });
          }
        }
      }

      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        if (!statement.name) continue;
        file.declarations.set(statement.name.text, statement);
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
          file.exports.set(statement.name.text, statement.name.text);
          if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
            file.exports.set("default", statement.name.text);
          }
        }
      }

      if (ts.isExportAssignment(statement)) {
        const expression = unwrapExpression(statement.expression);
        if (ts.isIdentifier(expression)) file.exports.set("default", expression.text);
        if (ts.isCallExpression(expression)) {
          const handler = [...expression.arguments].reverse().find(ts.isIdentifier);
          if (handler) file.exports.set("default", handler.text);
        }
      }

      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          file.exports.set(element.name.text, element.propertyName?.text || element.name.text);
        }
      }
    }

    const visitCommonJs = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(node.left) &&
        ts.isIdentifier(unwrapExpression(node.right))
      ) {
        file.exports.set("default", (unwrapExpression(node.right) as ts.Identifier).text);
      }
      ts.forEachChild(node, visitCommonJs);
    };
    visitCommonJs(file.sourceFile);
  }

  private indexRoutes(file: IndexedFile) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toLowerCase();
        const directRouter = identifierText(node.expression.expression);
        const routeChain = routeChainTarget(node.expression.expression);
        if (HTTP_METHODS.has(method) && (directRouter || routeChain)) {
          const routerName = directRouter || routeChain!.routerName;
          if (file.routerNames.has(routerName) || /^(?:app|router|route)$/i.test(routerName)) {
            const routeArgument = routeChain?.routeExpression || node.arguments[0];
            const routePath = literalText(routeArgument);
            if (routePath !== undefined) {
              const offset = routeChain ? 0 : 1;
              file.routes.push({
                file,
                routerName,
                method: method.toUpperCase(),
                routePath,
                arguments: node.arguments.slice(offset).filter(ts.isExpression),
                node
              });
            }
          }
        }

        if (method === "use" && directRouter && (file.routerNames.has(directRouter) || /^(?:app|router)$/i.test(directRouter))) {
          const expressions = node.arguments.filter(ts.isExpression);
          const prefix = literalText(expressions[0]);
          const candidates = prefix === undefined ? expressions : expressions.slice(1);
          let targetIndex = -1;
          for (let index = candidates.length - 1; index >= 0; index--) {
            if (this.resolveRouter(file, candidates[index])) {
              targetIndex = index;
              break;
            }
          }
          if (targetIndex >= 0) {
            file.mounts.push({
              file,
              parentRouter: directRouter,
              prefix: prefix || "",
              target: candidates[targetIndex],
              middleware: candidates.slice(0, targetIndex),
              node
            });
          } else {
            file.middleware.push({
              routerName: directRouter,
              expressions: candidates,
              position: node.getStart(file.sourceFile)
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }

  private resolveModule(fromFile: string, moduleName: string): string | undefined {
    if (!moduleName.startsWith(".")) return undefined;
    const base = path.resolve(path.dirname(fromFile), moduleName);
    const declaredExtension = path.extname(base);
    const sourceBase = SOURCE_EXTENSIONS.includes(declaredExtension)
      ? base.slice(0, -declaredExtension.length)
      : base;
    const sourceCandidates = [
      ...SOURCE_EXTENSIONS.map((extension) => `${sourceBase}${extension}`),
      base
    ];
    const candidates = [
      ...(declaredExtension === ".js" || declaredExtension === ".mjs" || declaredExtension === ".cjs"
        ? sourceCandidates
        : [base, ...sourceCandidates]),
      ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`))
    ];
    return candidates.find((candidate) => this.files.has(path.resolve(candidate)));
  }
}

function discoverExpressContracts(
  index: CodeIndex,
  prismaModels: Map<string, PrismaModel>
): EndpointContract[] {
  const parentEdges = new Map<string, Array<{
    parentKey: string;
    prefix: string;
    middleware: ts.Expression[];
    file: IndexedFile;
  }>>();
  for (const file of index.files.values()) {
    for (const mount of file.mounts) {
      const targetKey = index.resolveRouter(file, mount.target);
      if (!targetKey) continue;
      const inheritedMiddleware = file.middleware
        .filter((item) =>
          item.routerName === mount.parentRouter &&
          item.position < mount.node.getStart(file.sourceFile)
        )
        .flatMap((item) => item.expressions);
      const edges = parentEdges.get(targetKey) || [];
      edges.push({
        parentKey: routerKey(file, mount.parentRouter),
        prefix: mount.prefix,
        middleware: [...inheritedMiddleware, ...mount.middleware],
        file
      });
      parentEdges.set(targetKey, edges);
    }
  }

  const contexts = (
    key: string,
    seen = new Set<string>()
  ): RouterContext[] => {
    if (seen.has(key)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const parents = parentEdges.get(key) || [];
    if (parents.length === 0) return [{ prefix: "", middleware: [] }];
    return parents.flatMap((edge) => contexts(edge.parentKey, nextSeen).map((parent) => ({
      prefix: joinRoutePaths(parent.prefix, edge.prefix),
      middleware: [...parent.middleware, ...edge.middleware]
    })));
  };

  const contracts: EndpointContract[] = [];
  for (const file of index.files.values()) {
    for (const route of file.routes) {
      const key = routerKey(file, route.routerName);
      const localMiddleware = file.middleware
        .filter((item) =>
          item.routerName === route.routerName &&
          item.position < route.node.getStart(file.sourceFile)
        )
        .flatMap((item) => item.expressions);
      for (const context of contexts(key)) {
        const routePath = joinRoutePaths(context.prefix, route.routePath);
        const source = sourceLocation(file, route.node);
        const analysis = analyzeEndpoint(
          index,
          file,
          [...context.middleware, ...localMiddleware, ...route.arguments],
          routePath,
          prismaModels
        );
        contracts.push({
          id: endpointContractId(route.method, routePath),
          method: route.method,
          path: routePath,
          framework: "express",
          source: {
            file: file.relativePath,
            line: lineOf(file.sourceFile, route.node),
            endLine: endLineOf(file.sourceFile, route.node)
          },
          summary: `${route.method} ${routePath}`,
          tags: [],
          parameters: mergeParameters(
            pathParameters(routePath, source),
            analysis.parameters
          ),
          requestBody: analysis.requestBody,
          responses: analysis.responses,
          security: analysis.security,
          middleware: analysis.middleware,
          requiredEnvironment: analysis.requiredEnvironment,
          roles: analysis.roles,
          permissions: analysis.permissions,
          prisma: analysis.prisma,
          evidence: unique([
            `${source}: Express route`,
            ...analysis.evidence
          ]),
          confidence: contractConfidence(analysis)
        });
      }
    }
  }
  return contracts;
}

function discoverNextContracts(
  index: CodeIndex,
  prismaModels: Map<string, PrismaModel>
): EndpointContract[] {
  const contracts: EndpointContract[] = [];
  for (const file of index.files.values()) {
    const appMatch = file.relativePath.match(/(?:^|\/)(?:src\/)?app\/api\/(.+)\/route\.(?:ts|js|tsx|jsx)$/);
    const pagesMatch = file.relativePath.match(/(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:ts|js|tsx|jsx)$/);
    if (!appMatch && !pagesMatch) continue;
    const routePath = nextRoutePath(appMatch?.[1] || pagesMatch?.[1] || "");

    if (appMatch) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        const localName = file.exports.get(method) || (file.declarations.has(method) ? method : undefined);
        if (!localName) continue;
        const resolved = index.resolveName(file, localName);
        if (!resolved) continue;
        const expression = declarationExpression(resolved.node) || resolved.node;
        const analysis = analyzeEndpoint(index, resolved.file, [expression as ts.Expression], routePath, prismaModels);
        const sourceNode = resolved.node;
        contracts.push(nextContract(
          method,
          routePath,
          "next-app",
          resolved.file,
          sourceNode,
          analysis
        ));
      }
      continue;
    }

    const defaultName = file.exports.get("default");
    const resolved = defaultName ? index.resolveName(file, defaultName) : undefined;
    const handlerNode = resolved?.node || findDefaultHandler(file.sourceFile);
    if (!handlerNode) continue;
    const methods = discoverPagesMethods(handlerNode);
    for (const method of methods) {
      const expression = declarationExpression(handlerNode) || handlerNode;
      const analysis = analyzeEndpoint(index, resolved?.file || file, [expression as ts.Expression], routePath, prismaModels);
      contracts.push(nextContract(
        method,
        routePath,
        "next-pages",
        resolved?.file || file,
        handlerNode,
        analysis
      ));
    }
  }
  return contracts;
}

function nextContract(
  method: string,
  routePath: string,
  framework: "next-app" | "next-pages",
  file: IndexedFile,
  node: ts.Node,
  analysis: EndpointAnalysis
): EndpointContract {
  const source = sourceLocation(file, node);
  return {
    id: endpointContractId(method, routePath),
    method,
    path: routePath,
    framework,
    source: {
      file: file.relativePath,
      line: lineOf(file.sourceFile, node),
      endLine: endLineOf(file.sourceFile, node)
    },
    summary: `${method} ${routePath}`,
    tags: [],
    parameters: mergeParameters(pathParameters(routePath, source), analysis.parameters),
    requestBody: analysis.requestBody,
    responses: analysis.responses,
    security: analysis.security,
    middleware: analysis.middleware,
    requiredEnvironment: analysis.requiredEnvironment,
    roles: analysis.roles,
    permissions: analysis.permissions,
    prisma: analysis.prisma,
    evidence: unique([`${source}: ${framework} route`, ...analysis.evidence]),
    confidence: contractConfidence(analysis)
  };
}

function analyzeEndpoint(
  index: CodeIndex,
  routeFile: IndexedFile,
  expressions: ts.Expression[],
  routePath: string,
  prismaModels: Map<string, PrismaModel>
): EndpointAnalysis {
  const parameters: EndpointParameter[] = [];
  const middleware: EndpointMiddleware[] = [];
  const security: EndpointSecurity[] = [];
  const roles: string[] = [];
  const permissions: string[] = [];
  const requiredEnvironment: string[] = [];
  const prisma: PrismaRequirement[] = [];
  const responses: ResponseContract[] = [];
  const evidence: string[] = [];
  let requestBody: RequestBodyContract | undefined;
  const visited = new Set<string>();

  const applySchema = (
    location: "body" | "query" | "path",
    parsed: ParsedSchema,
    source: string
  ) => {
    if (location === "body") {
      requestBody = mergeRequestBody(requestBody, {
        required: !parsed.optional,
        content: { "application/json": parsed.schema },
        source
      });
      return;
    }
    if (parsed.schema.type !== "object" || !parsed.schema.properties) return;
    for (const [name, schema] of Object.entries(parsed.schema.properties)) {
      parameters.push({
        name,
        in: location,
        required: location === "path" || Boolean(parsed.schema.required?.includes(name)),
        schema,
        source
      });
    }
  };

  const analyzeExpression = (file: IndexedFile, expression: ts.Expression, asRouteArgument = true) => {
    const source = sourceLocation(file, expression);
    if (asRouteArgument) {
      const descriptor = middlewareDescriptor(expression, file);
      if (descriptor) {
        middleware.push(descriptor.middleware);
        roles.push(...descriptor.roles);
        permissions.push(...descriptor.permissions);
        if (descriptor.security) security.push(descriptor.security);
      }
      const expressValidator = expressValidatorParameter(expression, file);
      if (expressValidator?.parameter) parameters.push(expressValidator.parameter);
      if (expressValidator?.bodyProperty) {
        requestBody = addBodyProperty(
          requestBody,
          expressValidator.bodyProperty.name,
          expressValidator.bodyProperty.schema,
          expressValidator.bodyProperty.source,
          "application/json"
        );
        if (expressValidator.bodyProperty.required) {
          const bodySchema = requestBody.content["application/json"];
          bodySchema.required = unique([...(bodySchema.required || []), expressValidator.bodyProperty.name]);
          requestBody.required = true;
        }
      }
      const validation = validationBinding(index, file, expression);
      if (validation) {
        applySchema(validation.location, validation.schema, validation.source);
      }
    }

    const resolved = index.resolveExpression(file, expression);
    if (resolved) analyzeNode(resolved.file, resolved.node);
    else analyzeNode(file, expression);
  };

  const analyzeNode = (file: IndexedFile, node: ts.Node) => {
    const key = `${file.absolutePath}:${node.pos}:${node.end}`;
    if (visited.has(key)) return;
    visited.add(key);
    const source = sourceLocation(file, node);

    extractRequestTypeContracts(index, file, node, applySchema, responses, evidence);

    const visit = (current: ts.Node) => {
      if (ts.isPropertyAccessExpression(current)) {
        const env = environmentName(current);
        if (env) requiredEnvironment.push(env);
        const access = requestPropertyAccess(current, source);
        if (access) {
          if (access.bodyProperty) {
            requestBody = addBodyProperty(requestBody, access.bodyProperty, access.schema, source, access.mediaType);
          }
          if (access.parameter) parameters.push(access.parameter);
        }
      }

      if (ts.isElementAccessExpression(current)) {
        const access = requestElementAccess(current, source);
        if (access?.bodyProperty) {
          requestBody = addBodyProperty(requestBody, access.bodyProperty, access.schema, source, access.mediaType);
        }
        if (access?.parameter) parameters.push(access.parameter);
      }

      if (ts.isCallExpression(current)) {
        const requestCall = requestCallAccess(current, source);
        if (requestCall?.body) {
          requestBody = mergeRequestBody(requestBody, requestCall.body);
        }
        if (requestCall?.parameter) parameters.push(requestCall.parameter);

        const parseBinding = inHandlerValidationBinding(index, file, current);
        if (parseBinding) {
          applySchema(parseBinding.location, parseBinding.schema, parseBinding.source);
          evidence.push(`${parseBinding.source}: validator schema applied`);
        }

        const response = responseFromCall(index, file, current);
        if (response) responses.push(response);

        const requirement = prismaFromCall(file, current, prismaModels);
        if (requirement) prisma.push(requirement);

        const calleeName = expressionName(current.expression);
        if (/role|admin|authorize|permit|permission|scope|can$/i.test(calleeName)) {
          const values = stringArguments(current.arguments);
          if (/role|admin/i.test(calleeName)) roles.push(...values);
          else permissions.push(...values);
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);

    for (const reference of referencedLocalFunctions(index, file, node)) {
      analyzeNode(reference.file, reference.node);
    }
  };

  const flattened = flattenExpressions(expressions);
  for (let index = 0; index < flattened.length; index++) {
    analyzeExpression(
      routeFile,
      flattened[index],
      index < flattened.length - 1 || isHandlerWrapper(flattened[index])
    );
  }

  const responseResult = uniqueBy(responses, (response) => `${response.status}:${JSON.stringify(response.content)}`);
  return {
    parameters: mergeParameters(pathParameters(routePath, sourceLocation(routeFile, routeFile.sourceFile)), parameters),
    requestBody,
    responses: responseResult,
    middleware: uniqueBy(middleware, (item) => `${item.kind}:${item.name}:${item.source}`),
    security: uniqueBy(security, (item) => `${item.type}:${item.scheme}:${item.name || ""}`),
    roles: unique(roles),
    permissions: unique(permissions),
    requiredEnvironment: unique(requiredEnvironment),
    prisma: uniqueBy(prisma, (item) => `${item.model}:${item.operation}:${item.source}`),
    evidence: unique(evidence)
  };
}

function validationBinding(
  index: CodeIndex,
  file: IndexedFile,
  expression: ts.Expression
): { location: "body" | "query" | "path"; schema: ParsedSchema; source: string } | undefined {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value)) return undefined;
  const name = expressionName(value.expression).toLowerCase();
  const schemaExpression = value.arguments.find(ts.isExpression);
  if (!schemaExpression || !/(?:validate|schema|parse)/.test(name)) return undefined;
  const location = /query/.test(name) ? "query" : /param/.test(name) ? "path" : "body";
  const parsed = schemaFromExpression(index, file, schemaExpression, new Set());
  if (!parsed) return undefined;
  return { location, schema: parsed, source: sourceLocation(file, expression) };
}

function inHandlerValidationBinding(
  index: CodeIndex,
  file: IndexedFile,
  call: ts.CallExpression
): { location: "body" | "query" | "path"; schema: ParsedSchema; source: string } | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (!["parse", "safeParse", "parseAsync", "validate", "validateAsync"].includes(call.expression.name.text)) {
    return undefined;
  }
  const requestTarget = call.arguments.find(ts.isExpression);
  if (!requestTarget) return undefined;
  const location = requestLocation(requestTarget);
  if (!location) return undefined;
  const parsed = schemaFromExpression(index, file, call.expression.expression, new Set());
  if (!parsed) return undefined;
  return {
    location,
    schema: parsed,
    source: sourceLocation(file, call)
  };
}

function schemaFromExpression(
  index: CodeIndex,
  file: IndexedFile,
  expression: ts.Expression,
  seen: Set<string>
): ParsedSchema | undefined {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const key = `${file.absolutePath}:${value.text}`;
    if (seen.has(key)) return { schema: { type: "unknown", source: sourceLocation(file, value) }, optional: false, requiredExplicit: false };
    const resolved = index.resolveName(file, value.text);
    if (!resolved) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const resolvedExpression = declarationExpression(resolved.node);
    if (resolvedExpression) {
      const parsed = schemaFromExpression(index, resolved.file, resolvedExpression, nextSeen);
      if (parsed) parsed.schema.source ||= sourceLocation(resolved.file, resolved.node);
      return parsed;
    }
    if (ts.isInterfaceDeclaration(resolved.node) || ts.isTypeAliasDeclaration(resolved.node)) {
      return {
        schema: schemaFromTypeDeclaration(index, resolved.file, resolved.node, nextSeen),
        optional: false,
        requiredExplicit: true
      };
    }
    return undefined;
  }
  if (ts.isObjectLiteralExpression(value)) {
    return objectLiteralSchema(index, file, value, "typescript", seen);
  }

  const chain = fluentChain(value);
  if (!chain) return undefined;
  const provider = chain.root.toLowerCase();
  const isJoi = provider === "joi";
  const isZod = provider === "z" || provider === "zod";
  if (!isJoi && !isZod) return undefined;

  let schema: ContractSchemaNode = { type: "unknown", source: sourceLocation(file, value) };
  let optional = isJoi;
  let requiredExplicit = false;
  for (const call of chain.calls) {
    const name = call.name.toLowerCase();
    if (name === "string") schema.type = "string";
    else if (name === "number") schema.type = "number";
    else if (name === "boolean" || name === "bool") schema.type = "boolean";
    else if (name === "date") {
      schema.type = "string";
      schema.format = "date-time";
    } else if (name === "binary") schema.type = "file";
    else if (name === "any" || name === "unknown") schema.type = "unknown";
    else if (name === "literal") {
      schema.const = literalValue(call.arguments[0]);
      schema.type = typeOfLiteral(schema.const);
    } else if (name === "enum") {
      const values = arrayLiteralValues(call.arguments[0]);
      schema.type = "string";
      schema.enum = values;
    } else if (name === "valid" || name === "allow") {
      const values = call.arguments.map(literalValue).filter((item) => item !== undefined);
      if (values.includes(null)) schema.nullable = true;
      const nonNull = values.filter((item) => item !== null);
      if (nonNull.length > 0) schema.enum = unique([...(schema.enum || []), ...nonNull]);
    } else if (name === "object") {
      const object = call.arguments[0];
      if (object && ts.isObjectLiteralExpression(unwrapExpression(object))) {
        const parsed = objectLiteralSchema(index, file, unwrapExpression(object) as ts.ObjectLiteralExpression, isJoi ? "joi" : "zod", seen);
        schema = { ...schema, ...parsed.schema };
      } else {
        schema.type = "object";
      }
    } else if (name === "array") {
      schema.type = "array";
      const item = call.arguments[0] && schemaFromExpression(index, file, call.arguments[0], seen);
      if (item) schema.items = item.schema;
    } else if (name === "items") {
      schema.type = "array";
      const item = call.arguments[0] && schemaFromExpression(index, file, call.arguments[0], seen);
      if (item) schema.items = item.schema;
    } else if (name === "union" || name === "alternatives" || name === "try") {
      const candidates = name === "union"
        ? arrayExpressionElements(call.arguments[0])
        : call.arguments;
      schema = {
        oneOf: candidates
          .map((item) => schemaFromExpression(index, file, item, seen)?.schema)
          .filter((item): item is ContractSchemaNode => Boolean(item)),
        source: schema.source
      };
    } else if (name === "optional") optional = true;
    else if (name === "required" || name === "defined") {
      optional = false;
      requiredExplicit = true;
    } else if (name === "nullable" || name === "nullish") {
      schema.nullable = true;
      if (name === "nullish") optional = true;
    } else if (name === "default") {
      schema.default = literalValue(call.arguments[0]);
      optional = true;
    } else if (name === "email" || name === "uuid" || name === "url" || name === "uri" || name === "hostname") {
      schema.format = name === "uri" ? "url" : name;
    } else if (name === "datetime" || name === "iso") schema.format = "date-time";
    else if (name === "int" || name === "integer") schema.type = "integer";
    else if (name === "min") applyMinimum(schema, numericArgument(call.arguments[0]));
    else if (name === "max") applyMaximum(schema, numericArgument(call.arguments[0]));
    else if (name === "length") {
      const length = numericArgument(call.arguments[0]);
      if (schema.type === "array") schema.minItems = schema.maxItems = length;
      else schema.minLength = schema.maxLength = length;
    } else if (name === "regex" || name === "pattern") schema.pattern = regexArgument(call.arguments[0]);
    else if (name === "positive") schema.minimum = Number.EPSILON;
    else if (name === "nonnegative") schema.minimum = 0;
    else if (name === "negative") schema.maximum = -Number.EPSILON;
    else if (name === "describe" || name === "description") schema.description = stringValue(call.arguments[0]);
  }
  return { schema, optional, requiredExplicit };
}

function objectLiteralSchema(
  index: CodeIndex,
  file: IndexedFile,
  object: ts.ObjectLiteralExpression,
  provider: "zod" | "joi" | "typescript",
  seen: Set<string>
): ParsedSchema {
  const properties: Record<string, ContractSchemaNode> = {};
  const required: string[] = [];
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (!name) continue;
    const initializer = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
    const parsed = schemaFromExpression(index, file, initializer, seen) ||
      { schema: inferExpressionSchema(index, file, initializer), optional: provider === "joi", requiredExplicit: false };
    properties[name] = parsed.schema;
    const isRequired = provider === "joi" ? parsed.requiredExplicit && !parsed.optional : !parsed.optional;
    if (isRequired) required.push(name);
  }
  return {
    schema: {
      type: "object",
      properties,
      required,
      source: sourceLocation(file, object)
    },
    optional: false,
    requiredExplicit: true
  };
}

function expressValidatorParameter(
  expression: ts.Expression,
  file: IndexedFile
): {
  parameter?: EndpointParameter;
  bodyProperty?: {
    name: string;
    required: boolean;
    schema: ContractSchemaNode;
    source: string;
  };
} | undefined {
  const chain = fluentChain(expression);
  if (!chain || !["body", "param", "query", "header", "cookie", "check"].includes(chain.root.toLowerCase())) {
    return undefined;
  }
  const first = chain.calls[0];
  const name = stringValue(first?.arguments[0]);
  if (!name) return undefined;
  const locationName = chain.root.toLowerCase() === "check" ? "body" : chain.root.toLowerCase();
  const location = locationName === "param" ? "path" : locationName;
  const schema: ContractSchemaNode = { type: "string", source: sourceLocation(file, expression) };
  let required = location === "path";
  for (const call of chain.calls.slice(1)) {
    const method = call.name.toLowerCase();
    if (method === "notempty" || method === "exists") required = true;
    else if (method === "optional") required = false;
    else if (method === "isemail") schema.format = "email";
    else if (method === "isuuid") schema.format = "uuid";
    else if (method === "isurl") schema.format = "url";
    else if (method === "isint") schema.type = "integer";
    else if (method === "isfloat" || method === "isnumeric") schema.type = "number";
    else if (method === "isboolean") schema.type = "boolean";
    else if (method === "isarray") schema.type = "array";
    else if (method === "isobject") schema.type = "object";
    else if (method === "islength") {
      const options = objectLiteralValues(call.arguments[0]);
      schema.minLength = numberOrUndefined(options.min);
      schema.maxLength = numberOrUndefined(options.max);
    } else if (method === "isbetween") {
      schema.minimum = numericArgument(call.arguments[0]);
      schema.maximum = numericArgument(call.arguments[1]);
    } else if (method === "isin") {
      schema.enum = arrayLiteralValues(call.arguments[0]);
    }
  }
  const source = sourceLocation(file, expression);
  if (location === "body") {
    return { bodyProperty: { name, required, schema, source } };
  }
  if (!["path", "query", "header", "cookie"].includes(location)) return undefined;
  return {
    parameter: {
      name,
      in: location as EndpointParameter["in"],
      required,
      schema,
      source
    }
  };
}

function middlewareDescriptor(
  expression: ts.Expression,
  file: IndexedFile
): {
  middleware: EndpointMiddleware;
  security?: EndpointSecurity;
  roles: string[];
  permissions: string[];
} | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return undefined;
  const name = conciseExpressionName(expression);
  if (!name || HTTP_METHODS.has(name.toLowerCase())) return undefined;
  const lower = name.toLowerCase();
  const values: string[] = ts.isCallExpression(unwrapExpression(expression))
    ? stringArguments((unwrapExpression(expression) as ts.CallExpression).arguments)
    : [];
  const configuration = values.length > 0 ? { arguments: values } : {};
  const kind: EndpointMiddleware["kind"] =
    /auth|jwt|session|apikey|api-key|clerk/.test(lower) ? "authentication"
      : /role|permission|permit|authorize|admin|scope|can/.test(lower) ? "authorization"
        : /valid|schema|body|param|query|check/.test(lower) ? "validation"
          : "other";
  let security: EndpointSecurity | undefined;
  if (kind === "authentication") {
    const type: EndpointSecurity["type"] =
      /api.?key/.test(lower) ? "apiKey"
        : /session|cookie/.test(lower) ? "session"
          : /basic/.test(lower) ? "basic"
            : "bearer";
    security = {
      scheme: name,
      type,
      in: type === "apiKey" ? "header" : undefined,
      name: type === "apiKey" ? "x-api-key" : undefined,
      scopes: [],
      source: sourceLocation(file, expression)
    };
  }
  return {
    middleware: {
      name,
      kind,
      source: sourceLocation(file, expression),
      configuration
    },
    security,
    roles: kind === "authorization" && /role|admin/.test(lower) ? values : [],
    permissions: kind === "authorization" && !/role|admin/.test(lower) ? values : []
  };
}

function extractRequestTypeContracts(
  index: CodeIndex,
  file: IndexedFile,
  node: ts.Node,
  applySchema: (location: "body" | "query" | "path", parsed: ParsedSchema, source: string) => void,
  responses: ResponseContract[],
  evidence: string[]
) {
  const functionNode = functionLikeNode(node);
  if (!functionNode) return;
  for (const parameter of functionNode.parameters) {
    const type = parameter.type;
    if (!type || !ts.isTypeReferenceNode(type)) continue;
    const typeName = type.typeName.getText(file.sourceFile);
    if (!/(?:^|\.)Request$/.test(typeName)) continue;
    const [paramsType, responseType, bodyType, queryType] = type.typeArguments || [];
    const source = sourceLocation(file, parameter);
    if (paramsType) applySchema("path", {
      schema: schemaFromTypeNode(index, file, paramsType, new Set()),
      optional: false,
      requiredExplicit: true
    }, `${source}: Request params type`);
    if (bodyType) applySchema("body", {
      schema: schemaFromTypeNode(index, file, bodyType, new Set()),
      optional: false,
      requiredExplicit: true
    }, `${source}: Request body type`);
    if (queryType) applySchema("query", {
      schema: schemaFromTypeNode(index, file, queryType, new Set()),
      optional: false,
      requiredExplicit: true
    }, `${source}: Request query type`);
    if (responseType) {
      responses.push({
        status: "200",
        headers: {},
        content: {
          "application/json": schemaFromTypeNode(index, file, responseType, new Set())
        }
      });
    }
    evidence.push(`${source}: Express Request generic contract`);
  }
}

function schemaFromTypeDeclaration(
  index: CodeIndex,
  file: IndexedFile,
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  seen: Set<string>
): ContractSchemaNode {
  if (ts.isTypeAliasDeclaration(node)) return schemaFromTypeNode(index, file, node.type, seen);
  return schemaFromMembers(index, file, node.members, seen, sourceLocation(file, node));
}

function schemaFromTypeNode(
  index: CodeIndex,
  file: IndexedFile,
  node: ts.TypeNode,
  seen: Set<string>
): ContractSchemaNode {
  if (node.kind === ts.SyntaxKind.StringKeyword) return { type: "string", source: sourceLocation(file, node) };
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { type: "number", source: sourceLocation(file, node) };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { type: "boolean", source: sourceLocation(file, node) };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { type: "null", source: sourceLocation(file, node) };
  if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
    return { type: "unknown", source: sourceLocation(file, node) };
  }
  if (ts.isArrayTypeNode(node)) {
    return {
      type: "array",
      items: schemaFromTypeNode(index, file, node.elementType, seen),
      source: sourceLocation(file, node)
    };
  }
  if (ts.isTypeLiteralNode(node)) {
    return schemaFromMembers(index, file, node.members, seen, sourceLocation(file, node));
  }
  if (ts.isUnionTypeNode(node)) {
    const literalValues = node.types
      .filter(ts.isLiteralTypeNode)
      .map((item) => literalValue(item.literal))
      .filter((item) => item !== undefined);
    if (literalValues.length === node.types.length) {
      return {
        type: typeOfLiteral(literalValues[0]),
        enum: literalValues,
        nullable: literalValues.includes(null),
        source: sourceLocation(file, node)
      };
    }
    return {
      oneOf: node.types.map((item) => schemaFromTypeNode(index, file, item, seen)),
      nullable: node.types.some((item) => item.kind === ts.SyntaxKind.NullKeyword),
      source: sourceLocation(file, node)
    };
  }
  if (ts.isLiteralTypeNode(node)) {
    const value = literalValue(node.literal);
    return { type: typeOfLiteral(value), const: value, source: sourceLocation(file, node) };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(file.sourceFile);
    if (name === "Array" && node.typeArguments?.[0]) {
      return {
        type: "array",
        items: schemaFromTypeNode(index, file, node.typeArguments[0], seen),
        source: sourceLocation(file, node)
      };
    }
    if (["Record", "Map"].includes(name)) return { type: "object", source: sourceLocation(file, node) };
    if (["Date"].includes(name)) return { type: "string", format: "date-time", source: sourceLocation(file, node) };
    const key = `${file.absolutePath}:${name}`;
    if (seen.has(key)) return { ref: name, source: sourceLocation(file, node) };
    const resolved = index.resolveName(file, name);
    if (resolved && (ts.isInterfaceDeclaration(resolved.node) || ts.isTypeAliasDeclaration(resolved.node))) {
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      return {
        ...schemaFromTypeDeclaration(index, resolved.file, resolved.node, nextSeen),
        ref: name,
        source: sourceLocation(resolved.file, resolved.node)
      };
    }
    return { ref: name, type: "unknown", source: sourceLocation(file, node) };
  }
  return { type: "unknown", source: sourceLocation(file, node) };
}

function schemaFromMembers(
  index: CodeIndex,
  file: IndexedFile,
  members: ts.NodeArray<ts.TypeElement>,
  seen: Set<string>,
  source: string
): ContractSchemaNode {
  const properties: Record<string, ContractSchemaNode> = {};
  const required: string[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const name = propertyName(member.name);
    if (!name) continue;
    properties[name] = schemaFromTypeNode(index, file, member.type, seen);
    if (!member.questionToken) required.push(name);
  }
  return { type: "object", properties, required, source };
}

function responseFromCall(
  index: CodeIndex,
  file: IndexedFile,
  call: ts.CallExpression
): ResponseContract | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  if (!["json", "send", "end", "sendStatus"].includes(method)) return undefined;
  let status = "200";
  const receiver = callee.expression;
  if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    if (receiver.expression.name.text === "status") {
      status = String(numericArgument(receiver.arguments[0]) || 200);
    }
  }
  if (method === "sendStatus") status = String(numericArgument(call.arguments[0]) || 200);
  if (
    ts.isIdentifier(receiver) &&
    ["NextResponse", "Response"].includes(receiver.text) &&
    method === "json" &&
    call.arguments[1] &&
    ts.isObjectLiteralExpression(unwrapExpression(call.arguments[1]))
  ) {
    const values = objectLiteralValues(call.arguments[1]);
    status = String(numberOrUndefined(values.status) || 200);
  }
  const payload = method === "sendStatus" || method === "end" ? undefined : call.arguments[0];
  return {
    status,
    headers: {},
    content: payload
      ? { "application/json": inferExpressionSchema(index, file, payload) }
      : {}
  };
}

function inferExpressionSchema(
  index: CodeIndex,
  file: IndexedFile,
  expression: ts.Expression
): ContractSchemaNode {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return { type: "string", example: value.text, source: sourceLocation(file, value) };
  }
  if (ts.isNumericLiteral(value)) {
    return { type: "number", example: Number(value.text), source: sourceLocation(file, value) };
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
    return { type: "boolean", example: value.kind === ts.SyntaxKind.TrueKeyword, source: sourceLocation(file, value) };
  }
  if (ts.isArrayLiteralExpression(value)) {
    const first = value.elements.find(ts.isExpression);
    return {
      type: "array",
      items: first ? inferExpressionSchema(index, file, first) : { type: "unknown" },
      source: sourceLocation(file, value)
    };
  }
  if (ts.isObjectLiteralExpression(value)) {
    const properties: Record<string, ContractSchemaNode> = {};
    const required: string[] = [];
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if (!name) continue;
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      properties[name] = inferExpressionSchema(index, file, initializer);
      required.push(name);
    }
    return { type: "object", properties, required, source: sourceLocation(file, value) };
  }
  if (ts.isIdentifier(value)) {
    const resolved = index.resolveName(file, value.text);
    if (resolved) {
      if (ts.isVariableDeclaration(resolved.node) && resolved.node.type) {
        return schemaFromTypeNode(index, resolved.file, resolved.node.type, new Set());
      }
      const initializer = declarationExpression(resolved.node);
      if (initializer && initializer !== value) return inferExpressionSchema(index, resolved.file, initializer);
    }
  }
  return { type: "unknown", source: sourceLocation(file, value) };
}

function prismaFromCall(
  file: IndexedFile,
  call: ts.CallExpression,
  models: Map<string, PrismaModel>
): PrismaRequirement | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const operation = call.expression.name.text;
  const modelAccess = call.expression.expression;
  if (!ts.isPropertyAccessExpression(modelAccess) || !ts.isIdentifier(modelAccess.expression)) return undefined;
  if (!["prisma", "db", "prismaClient"].includes(modelAccess.expression.text)) return undefined;
  if (!/^(?:find|create|update|upsert|delete|count|aggregate)/.test(operation)) return undefined;
  const model = modelAccess.name.text;
  const relations = new Set<string>();
  const options = call.arguments[0] && unwrapExpression(call.arguments[0]);
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if (!["include", "select"].includes(name || "")) continue;
      const nested = unwrapExpression(property.initializer);
      if (!ts.isObjectLiteralExpression(nested)) continue;
      for (const relationProperty of nested.properties) {
        const relation = propertyName(relationProperty.name);
        if (relation && (models.get(model)?.relations.has(relation) ?? true)) relations.add(relation);
      }
    }
  }
  return {
    model,
    operation,
    relations: [...relations],
    source: sourceLocation(file, call)
  };
}

async function discoverPrismaModels(root: string): Promise<Map<string, PrismaModel>> {
  const result = new Map<string, PrismaModel>();
  const files = await findFilesByName(root, "schema.prisma", 20);
  for (const file of files) {
    const content = await fs.promises.readFile(file, "utf8").catch(() => "");
    for (const modelMatch of content.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
      const modelName = lowerFirst(modelMatch[1]);
      const relations = new Set<string>();
      for (const line of modelMatch[2].split(/\r?\n/)) {
        const field = line.trim().match(/^(\w+)\s+([A-Z]\w*)(?:\[\])?\??(?:\s|$)/);
        if (field) relations.add(field[1]);
      }
      result.set(modelName, { relations });
    }
  }
  return result;
}

function requestPropertyAccess(
  expression: ts.PropertyAccessExpression,
  source: string
): {
  parameter?: EndpointParameter;
  bodyProperty?: string;
  schema: ContractSchemaNode;
  mediaType: string;
} | undefined {
  const segments = propertySegments(expression);
  if (segments.length < 3 || !/^(?:req|request)$/i.test(segments[0])) return undefined;
  const schema: ContractSchemaNode = { type: "unknown", source };
  if (segments[1] === "body") return { bodyProperty: segments[2], schema, mediaType: "application/json" };
  if (segments[1] === "file") return { bodyProperty: segments[2] || "file", schema: { type: "file", source }, mediaType: "multipart/form-data" };
  if (segments[1] === "files") return {
    bodyProperty: segments[2] || "files",
    schema: { type: "array", items: { type: "file", source }, source },
    mediaType: "multipart/form-data"
  };
  const location = segments[1] === "params" ? "path"
    : segments[1] === "query" ? "query"
      : segments[1] === "cookies" ? "cookie"
        : segments[1] === "headers" ? "header"
          : undefined;
  if (!location) return undefined;
  return {
    parameter: {
      name: segments[2],
      in: location,
      required: location === "path",
      schema,
      source
    },
    schema,
    mediaType: "application/json"
  };
}

function requestElementAccess(
  expression: ts.ElementAccessExpression,
  source: string
): ReturnType<typeof requestPropertyAccess> {
  if (!expression.argumentExpression) return undefined;
  const name = stringValue(expression.argumentExpression);
  if (!name) return undefined;
  const segments = propertySegments(expression.expression);
  if (segments.length < 2 || !/^(?:req|request)$/i.test(segments[0])) return undefined;
  if (segments[1] === "body") {
    return { bodyProperty: name, schema: { type: "unknown", source }, mediaType: "application/json" };
  }
  const location = segments[1] === "params" ? "path"
    : segments[1] === "query" ? "query"
      : segments[1] === "cookies" ? "cookie"
        : segments[1] === "headers" ? "header"
          : undefined;
  if (!location) return undefined;
  return {
    parameter: {
      name,
      in: location,
      required: location === "path",
      schema: { type: "unknown", source },
      source
    },
    schema: { type: "unknown", source },
    mediaType: "application/json"
  };
}

function requestCallAccess(
  call: ts.CallExpression,
  source: string
): {
  parameter?: EndpointParameter;
  body?: RequestBodyContract;
} | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  const receiverText = callee.expression.getText();
  if (["json", "formData"].includes(method) && /^(?:req|request)$/.test(receiverText)) {
    return {
      body: {
        required: true,
        content: {
          [method === "formData" ? "multipart/form-data" : "application/json"]: {
            type: "object",
            source
          }
        },
        source
      }
    };
  }
  const name = stringValue(call.arguments[0]);
  if (!name) return undefined;
  if (/^(?:req|request)\.(?:get|header)$/.test(`${receiverText}.${method}`)) {
    return {
      parameter: { name, in: "header", required: false, schema: { type: "string", source }, source }
    };
  }
  if (/headers$/.test(receiverText) && method === "get") {
    return {
      parameter: { name, in: "header", required: false, schema: { type: "string", source }, source }
    };
  }
  if (/cookies$/.test(receiverText) && method === "get") {
    return {
      parameter: { name, in: "cookie", required: false, schema: { type: "string", source }, source }
    };
  }
  if (/searchParams$/.test(receiverText) && method === "get") {
    return {
      parameter: { name, in: "query", required: false, schema: { type: "string", source }, source }
    };
  }
  return undefined;
}

function addBodyProperty(
  current: RequestBodyContract | undefined,
  name: string,
  schema: ContractSchemaNode,
  source: string,
  mediaType: string
): RequestBodyContract {
  const existing = current?.content[mediaType] || { type: "object" as const, properties: {}, required: [], source };
  const properties = { ...(existing.properties || {}) };
  properties[name] = properties[name] ? mergeSchema(properties[name], schema) : schema;
  return mergeRequestBody(current, {
    required: current?.required || false,
    content: {
      [mediaType]: {
        ...existing,
        type: "object",
        properties,
        source
      }
    },
    source
  })!;
}

function mergeRequestBody(
  left: RequestBodyContract | undefined,
  right: RequestBodyContract
): RequestBodyContract {
  if (!left) return right;
  const content = { ...left.content };
  for (const [mediaType, schema] of Object.entries(right.content)) {
    content[mediaType] = content[mediaType] ? mergeSchema(content[mediaType], schema) : schema;
  }
  return {
    required: left.required || right.required,
    content,
    source: `${left.source}; ${right.source}`
  };
}

function referencedLocalFunctions(index: CodeIndex, file: IndexedFile, node: ts.Node): ResolvedNode[] {
  const results: ResolvedNode[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      const resolved = index.resolveName(file, current.expression.text);
      if (resolved && functionLikeNode(resolved.node)) results.push(resolved);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return uniqueBy(results, (item) => `${item.file.absolutePath}:${item.node.pos}:${item.node.end}`);
}

function mergeParameters(left: EndpointParameter[], right: EndpointParameter[]): EndpointParameter[] {
  const result = new Map<string, EndpointParameter>();
  for (const parameter of [...left, ...right]) {
    const key = `${parameter.in}:${parameter.name.toLowerCase()}`;
    const existing = result.get(key);
    result.set(key, existing
      ? {
          ...existing,
          required: existing.required || parameter.required,
          schema: mergeSchema(existing.schema, parameter.schema),
          source: `${existing.source}; ${parameter.source}`
        }
      : parameter);
  }
  return [...result.values()];
}

function contractConfidence(analysis: EndpointAnalysis): number {
  let confidence = 0.75;
  if (analysis.requestBody || analysis.parameters.length > 0) confidence += 0.08;
  if (analysis.middleware.length > 0) confidence += 0.04;
  if (analysis.responses.length > 0) confidence += 0.04;
  if (analysis.prisma.length > 0) confidence += 0.03;
  return Math.min(confidence, 0.94);
}

function fluentChain(expression: ts.Expression): {
  root: string;
  calls: Array<{ name: string; arguments: readonly ts.Expression[] }>;
} | undefined {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) return { root: value.text, calls: [] };
  if (!ts.isCallExpression(value)) return undefined;
  if (ts.isIdentifier(value.expression)) {
    return {
      root: value.expression.text,
      calls: [{ name: value.expression.text, arguments: value.arguments.filter(ts.isExpression) }]
    };
  }
  if (ts.isPropertyAccessExpression(value.expression)) {
    const base = fluentChain(value.expression.expression);
    if (!base) {
      const root = identifierText(value.expression.expression);
      if (!root) return undefined;
      return {
        root,
        calls: [{ name: value.expression.name.text, arguments: value.arguments.filter(ts.isExpression) }]
      };
    }
    return {
      root: base.root,
      calls: [...base.calls, {
        name: value.expression.name.text,
        arguments: value.arguments.filter(ts.isExpression)
      }]
    };
  }
  return undefined;
}

function functionLikeNode(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
    return node;
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const initializer = unwrapExpression(node.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
    if (ts.isCallExpression(initializer)) {
      const candidate = [...initializer.arguments].reverse().find((argument) =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      );
      if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))) return candidate;
    }
  }
  return undefined;
}

function declarationExpression(node: ts.Node): ts.Expression | undefined {
  if (ts.isVariableDeclaration(node)) return node.initializer;
  if (ts.isExportAssignment(node)) return node.expression;
  if (ts.isExpression(node)) return node;
  if (ts.isFunctionDeclaration(node)) return node as unknown as ts.Expression;
  return undefined;
}

function isHandlerLike(node: ts.Node): boolean {
  return Boolean(functionLikeNode(node)) ||
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node);
}

function discoverPagesMethods(node: ts.Node): string[] {
  const methods = new Set<string>();
  const visit = (current: ts.Node) => {
    if (ts.isStringLiteralLike(current) && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(current.text)) {
      const parentText = current.parent?.getText() || "";
      if (/method|case/.test(parentText)) methods.add(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return methods.size > 0 ? [...methods] : ["GET"];
}

function findDefaultHandler(sourceFile: ts.SourceFile): ts.Node | undefined {
  return sourceFile.statements.find(ts.isExportAssignment)?.expression;
}

function nextRoutePath(relative: string): string {
  const segments = relative
    .split("/")
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) =>
      segment
        .replace(/^\[\.\.\.(.+)\]$/, ":$1")
        .replace(/^\[\[(?:\.\.\.)?(.+)\]\]$/, ":$1")
        .replace(/^\[(.+)\]$/, ":$1")
    );
  const route = `/api/${segments.join("/")}`.replace(/\/index$/, "");
  return joinRoutePaths(route);
}

function environmentName(expression: ts.PropertyAccessExpression): string | undefined {
  const segments = propertySegments(expression);
  if (segments.length === 3 && segments[0] === "process" && segments[1] === "env") return segments[2];
  if (segments.length === 2 && /^(?:env|config)$/i.test(segments[0]) && /^[A-Z][A-Z0-9_]+$/.test(segments[1])) {
    return segments[1];
  }
  return undefined;
}

function requestLocation(expression: ts.Expression): "body" | "query" | "path" | undefined {
  const text = expression.getText();
  if (/(?:req|request)\.body\b/.test(text)) return "body";
  if (/(?:req|request)\.query\b|searchParams/.test(text)) return "query";
  if (/(?:req|request)\.params\b/.test(text)) return "path";
  return undefined;
}

function expressionName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${expressionName(expression.expression)}.${expression.name.text}`;
  return expression.getText();
}

function conciseExpressionName(expression: ts.Expression): string {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isCallExpression(value)) return expressionName(value.expression);
  if (ts.isPropertyAccessExpression(value)) return expressionName(value);
  return "";
}

function isHandlerWrapper(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  const name = expressionName(value.expression);
  return /(?:^|\.)(?:with|require|auth|protect|guard)[A-Z_a-z0-9]*/.test(name) &&
    value.arguments.some((argument) =>
      ts.isArrowFunction(argument) ||
      ts.isFunctionExpression(argument) ||
      ts.isIdentifier(argument)
    );
}

function routeChainTarget(expression: ts.Expression): {
  routerName: string;
  routeExpression: ts.Expression;
} | undefined {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return undefined;
  if (value.expression.name.text !== "route") return undefined;
  const routerName = identifierText(value.expression.expression);
  const routeExpression = value.arguments[0];
  return routerName && routeExpression && ts.isExpression(routeExpression)
    ? { routerName, routeExpression }
    : undefined;
}

function routerKey(file: IndexedFile, routerName: string): string {
  return `${file.absolutePath}#${routerName}`;
}

function sourceLocation(file: IndexedFile, node: ts.Node): string {
  return `${file.relativePath}:${lineOf(file.sourceFile, node)}`;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endLineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function identifierText(expression: ts.Expression): string | undefined {
  const value = unwrapExpression(expression);
  return ts.isIdentifier(value) ? value.text : undefined;
}

function literalText(node?: ts.Node): string | undefined {
  if (!node) return undefined;
  const value = ts.isExpression(node) ? unwrapExpression(node) : node;
  return ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)
    ? value.text
    : undefined;
}

function unwrapExpression<T extends ts.Expression>(expression: T): ts.Expression {
  let current: ts.Expression = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isRouterInitializer(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  const name = expressionName(value.expression).toLowerCase();
  return name === "express" || name.endsWith(".router") || name === "router" || name.endsWith(".express");
}

function requireModule(expression: ts.Expression): string | undefined {
  const value = unwrapExpression(expression);
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "require"
  ) return stringValue(value.arguments[0]);
  return undefined;
}

function isModuleExports(node: ts.Expression): boolean {
  return node.getText() === "module.exports" || node.getText() === "exports.default";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function propertySegments(node: ts.Expression): string[] {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) return [...propertySegments(node.expression), node.name.text];
  return [];
}

function stringArguments(argumentsValue: readonly ts.Expression[]): string[] {
  return argumentsValue
    .map(stringValue)
    .filter((value): value is string => value !== undefined);
}

function stringValue(node?: ts.Expression): string | undefined {
  if (!node) return undefined;
  const value = unwrapExpression(node);
  return ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

function numericArgument(node?: ts.Expression): number | undefined {
  if (!node) return undefined;
  const value = unwrapExpression(node);
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
    return value.operator === ts.SyntaxKind.MinusToken ? -Number(value.operand.text) : Number(value.operand.text);
  }
  return undefined;
}

function regexArgument(node?: ts.Expression): string | undefined {
  if (!node) return undefined;
  const text = node.getText();
  const match = text.match(/^\/(.*)\/[a-z]*$/i);
  return match?.[1] || stringValue(node);
}

function applyMinimum(schema: ContractSchemaNode, value?: number) {
  if (value === undefined) return;
  if (schema.type === "string") schema.minLength = value;
  else if (schema.type === "array") schema.minItems = value;
  else schema.minimum = value;
}

function applyMaximum(schema: ContractSchemaNode, value?: number) {
  if (value === undefined) return;
  if (schema.type === "string") schema.maxLength = value;
  else if (schema.type === "array") schema.maxItems = value;
  else schema.maximum = value;
}

function literalValue(node?: ts.Node): unknown {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return node.operator === ts.SyntaxKind.MinusToken ? -Number(node.operand.text) : Number(node.operand.text);
  }
  return undefined;
}

function typeOfLiteral(value: unknown): ContractSchemaNode["type"] {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
}

function arrayLiteralValues(node?: ts.Expression): unknown[] {
  if (!node) return [];
  const value = unwrapExpression(node);
  return ts.isArrayLiteralExpression(value)
    ? value.elements.map(literalValue).filter((item) => item !== undefined)
    : [];
}

function arrayExpressionElements(node?: ts.Expression): ts.Expression[] {
  if (!node) return [];
  const value = unwrapExpression(node);
  return ts.isArrayLiteralExpression(value) ? value.elements.filter(ts.isExpression) : [];
}

function objectLiteralValues(node?: ts.Expression): Record<string, unknown> {
  if (!node) return {};
  const value = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(value)) return {};
  const result: Record<string, unknown> = {};
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name) result[name] = literalValue(property.initializer);
  }
  return result;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flattenExpressions(expressions: ts.Expression[]): ts.Expression[] {
  return expressions.flatMap((expression) => {
    const value = unwrapExpression(expression);
    return ts.isArrayLiteralExpression(value) ? value.elements.filter(ts.isExpression) : [expression];
  });
}

async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [path.resolve(root)];
  const excluded = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "sandbox"]);
  while (pending.length > 0 && files.length < 5000) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(absolute);
      if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) files.push(path.resolve(absolute));
    }
  }
  const normalized = new Set(files.map((file) => path.resolve(file)));
  return files.filter((file) => {
    const extension = path.extname(file);
    if (![".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return true;
    const base = file.slice(0, -extension.length);
    return ![".ts", ".tsx"].some((sourceExtension) =>
      normalized.has(path.resolve(`${base}${sourceExtension}`))
    );
  });
}

async function findFilesByName(root: string, name: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [path.resolve(root)];
  const excluded = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "sandbox"]);
  while (pending.length > 0 && files.length < limit) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(absolute);
      if (entry.isFile() && entry.name === name) files.push(absolute);
    }
  }
  return files;
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}

function lowerFirst(value: string): string {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}
