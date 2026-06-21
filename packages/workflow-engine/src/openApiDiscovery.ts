import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ContractSchemaNode,
  EndpointContract,
  EndpointParameter,
  EndpointSecurity,
  RequestBodyContract,
  ResponseContract
} from "@opspilot/schemas";
import {
  endpointContractId,
  joinRoutePaths,
  pathParameters,
  unique,
  uniqueBy
} from "./contractUtils.js";

type JsonObject = Record<string, any>;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const OPENAPI_NAMES = /(?:^|\/)(?:openapi|swagger)(?:\.[^/]+)?\.(?:json|ya?ml)$/i;

export async function discoverOpenApiContracts(root: string): Promise<EndpointContract[]> {
  const contracts: EndpointContract[] = [];
  for (const filePath of await findOpenApiFiles(root)) {
    const relative = normalizeRelative(path.relative(root, filePath));
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      const document = filePath.endsWith(".json")
        ? JSON.parse(content)
        : parseYaml(content);
      if (!isOpenApiDocument(document)) continue;
      contracts.push(...contractsFromDocument(document, relative, content));
    } catch {
      // Invalid API documents are ignored here; repository static analysis reports parse errors separately.
    }
  }
  return contracts;
}

function contractsFromDocument(document: JsonObject, sourceFile: string, content: string): EndpointContract[] {
  const contracts: EndpointContract[] = [];
  const resolver = new OpenApiResolver(document, sourceFile);
  const routePrefix = discoverRoutePrefix(document);
  const securitySchemes = discoverSecuritySchemes(document, sourceFile);
  const globalSecurity = Array.isArray(document.security) ? document.security : undefined;

  for (const [rawPath, pathItemValue] of Object.entries(document.paths || {})) {
    const pathItem = resolver.resolveObject(pathItemValue);
    const commonParameters = asArray(pathItem.parameters);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const operation = resolver.resolveObject(operationValue);
      const routePath = joinRoutePaths(routePrefix, rawPath);
      const source = `${sourceFile}:paths.${rawPath}.${method}`;
      const parameters = extractParameters(
        [...commonParameters, ...asArray(operation.parameters)],
        resolver,
        source
      );
      const requestBody = extractRequestBody(operation, document, resolver, source);
      const responses = extractResponses(operation.responses || {}, resolver, source);
      const operationSecurity = operation.security === undefined ? globalSecurity : operation.security;
      const security = extractSecurity(operationSecurity, securitySchemes, source);
      const line = findRouteLine(content, rawPath);

      contracts.push({
        id: endpointContractId(method, routePath),
        method: method.toUpperCase(),
        path: routePath,
        framework: "openapi",
        source: { file: sourceFile, line },
        summary: operation.summary || operation.description,
        operationId: operation.operationId,
        tags: asStringArray(operation.tags),
        parameters: mergePathParameters(routePath, parameters, source),
        requestBody,
        responses,
        security,
        middleware: [],
        requiredEnvironment: [],
        roles: extractExtensions(operation, ["x-roles", "x-role"]),
        permissions: extractExtensions(operation, ["x-permissions", "x-permission", "x-scopes"]),
        prisma: [],
        evidence: [
          `${sourceFile}: OpenAPI ${document.openapi || document.swagger || "document"}`,
          `${source}: operation contract`
        ],
        confidence: 1
      });
    }
  }
  return contracts;
}

function extractParameters(
  parameterValues: unknown[],
  resolver: OpenApiResolver,
  source: string
): EndpointParameter[] {
  const parameters: EndpointParameter[] = [];
  for (const parameterValue of parameterValues) {
    const parameter = resolver.resolveObject(parameterValue);
    if (!["path", "query", "header", "cookie"].includes(parameter.in) || typeof parameter.name !== "string") {
      continue;
    }
    const parameterSource = `${source}:parameter.${parameter.name}`;
    const schemaValue = parameter.schema || schemaFromParameterContent(parameter.content);
    parameters.push({
      name: parameter.name,
      in: parameter.in,
      required: parameter.in === "path" || parameter.required === true,
      description: parameter.description,
      schema: resolver.schema(schemaValue || {}, parameterSource),
      source: parameterSource
    });
  }
  return uniqueBy(parameters, (parameter) => `${parameter.in}:${parameter.name.toLowerCase()}`);
}

function extractRequestBody(
  operation: JsonObject,
  document: JsonObject,
  resolver: OpenApiResolver,
  source: string
): RequestBodyContract | undefined {
  if (operation.requestBody) {
    const requestBody = resolver.resolveObject(operation.requestBody);
    const content = extractContent(requestBody.content, resolver, `${source}:requestBody`);
    return {
      required: requestBody.required === true,
      content,
      source: `${source}:requestBody`
    };
  }

  const bodyParameter = asArray(operation.parameters)
    .map((value) => resolver.resolveObject(value))
    .find((parameter) => parameter.in === "body");
  const formParameters = asArray(operation.parameters)
    .map((value) => resolver.resolveObject(value))
    .filter((parameter) => parameter.in === "formData");
  if (bodyParameter) {
    const consumes = asStringArray(operation.consumes).length > 0
      ? asStringArray(operation.consumes)
      : asStringArray(document.consumes).length > 0
        ? asStringArray(document.consumes)
        : ["application/json"];
    const schema = resolver.schema(bodyParameter.schema || {}, `${source}:body`);
    return {
      required: bodyParameter.required === true,
      content: Object.fromEntries(consumes.map((mediaType) => [mediaType, schema])),
      source: `${source}:body`
    };
  }
  if (formParameters.length > 0) {
    const properties: Record<string, ContractSchemaNode> = {};
    const required: string[] = [];
    for (const parameter of formParameters) {
      properties[parameter.name] = resolver.schema(parameter, `${source}:formData.${parameter.name}`);
      if (parameter.required) required.push(parameter.name);
    }
    const multipart = formParameters.some((parameter) => parameter.type === "file");
    return {
      required: required.length > 0,
      content: {
        [multipart ? "multipart/form-data" : "application/x-www-form-urlencoded"]: {
          type: "object",
          properties,
          required,
          source: `${source}:formData`
        }
      },
      source: `${source}:formData`
    };
  }
  return undefined;
}

function extractResponses(
  responseValues: Record<string, unknown>,
  resolver: OpenApiResolver,
  source: string
): ResponseContract[] {
  const responses: ResponseContract[] = [];
  for (const [status, responseValue] of Object.entries(responseValues)) {
    const response = resolver.resolveObject(responseValue);
    const headers: Record<string, ContractSchemaNode> = {};
    for (const [name, headerValue] of Object.entries(response.headers || {})) {
      const header = resolver.resolveObject(headerValue);
      headers[name] = resolver.schema(header.schema || header, `${source}:response.${status}.header.${name}`);
    }
    const content = extractContent(response.content, resolver, `${source}:response.${status}`);
    if (Object.keys(content).length === 0 && response.schema) {
      content["application/json"] = resolver.schema(response.schema, `${source}:response.${status}`);
    }
    responses.push({
      status,
      description: response.description,
      headers,
      content
    });
  }
  return responses;
}

function extractContent(
  contentValue: unknown,
  resolver: OpenApiResolver,
  source: string
): Record<string, ContractSchemaNode> {
  const content: Record<string, ContractSchemaNode> = {};
  for (const [mediaType, mediaValue] of Object.entries(asObject(contentValue))) {
    const media = resolver.resolveObject(mediaValue);
    content[mediaType] = resolver.schema(media.schema || {}, `${source}.${mediaType}`);
    if (media.example !== undefined && content[mediaType].example === undefined) {
      content[mediaType].example = media.example;
    }
    if (media.examples && content[mediaType].example === undefined) {
      const first = Object.values(media.examples)[0] as JsonObject | undefined;
      content[mediaType].example = first?.value;
    }
  }
  return content;
}

function discoverSecuritySchemes(
  document: JsonObject,
  sourceFile: string
): Map<string, EndpointSecurity> {
  const definitions = document.components?.securitySchemes || document.securityDefinitions || {};
  const result = new Map<string, EndpointSecurity>();
  for (const [name, rawDefinition] of Object.entries(definitions)) {
    const definition = asObject(rawDefinition);
    const rawType = String(definition.type || "").toLowerCase();
    const scheme = String(definition.scheme || "").toLowerCase();
    const location = ["header", "query", "cookie"].includes(definition.in) ? definition.in : undefined;
    const type: EndpointSecurity["type"] =
      rawType === "apikey" && location === "cookie" ? "cookie"
        : rawType === "apikey" ? "apiKey"
          : rawType === "oauth2" ? "oauth2"
            : rawType === "http" && scheme === "bearer" ? "bearer"
              : rawType === "http" && scheme === "basic" ? "basic"
                : "custom";
    result.set(name, {
      scheme: name,
      type,
      in: location,
      name: definition.name,
      scopes: [],
      source: `${sourceFile}:securitySchemes.${name}`
    });
  }
  return result;
}

function extractSecurity(
  securityValue: unknown,
  schemes: Map<string, EndpointSecurity>,
  source: string
): EndpointSecurity[] {
  if (!Array.isArray(securityValue)) return [];
  const result: EndpointSecurity[] = [];
  for (const requirement of securityValue) {
    for (const [schemeName, scopesValue] of Object.entries(asObject(requirement))) {
      const definition = schemes.get(schemeName);
      result.push(definition
        ? { ...definition, scopes: asStringArray(scopesValue) }
        : {
            scheme: schemeName,
            type: "custom",
            scopes: asStringArray(scopesValue),
            source
          });
    }
  }
  return uniqueBy(result, (item) => `${item.scheme}:${item.type}:${item.name || ""}`);
}

class OpenApiResolver {
  constructor(
    private readonly document: JsonObject,
    private readonly sourceFile: string
  ) {}

  public resolveObject(value: unknown): JsonObject {
    if (!value || typeof value !== "object") return {};
    const object = value as JsonObject;
    if (typeof object.$ref === "string") {
      return { ...asObject(this.resolveRef(object.$ref)), ...object };
    }
    return object;
  }

  public schema(value: unknown, source: string, seen = new Set<string>()): ContractSchemaNode {
    if (!value || typeof value !== "object") return { type: "unknown", source };
    const input = value as JsonObject;
    if (typeof input.$ref === "string") {
      if (seen.has(input.$ref)) return { ref: input.$ref, source };
      const nextSeen = new Set(seen);
      nextSeen.add(input.$ref);
      return {
        ...this.schema(this.resolveRef(input.$ref), source, nextSeen),
        ref: input.$ref,
        source
      };
    }

    const type = normalizeSchemaType(input.type, input.format);
    const properties: Record<string, ContractSchemaNode> = {};
    for (const [name, property] of Object.entries(input.properties || {})) {
      properties[name] = this.schema(property, `${source}.properties.${name}`, seen);
    }
    const result: ContractSchemaNode = {
      type: type || (Object.keys(properties).length > 0 ? "object" : undefined),
      format: input.format,
      description: input.description,
      nullable: input.nullable === true,
      enum: Array.isArray(input.enum) ? input.enum : undefined,
      const: input.const,
      default: input.default,
      example: input.example,
      minimum: numberValue(input.minimum),
      maximum: numberValue(input.maximum),
      minLength: numberValue(input.minLength),
      maxLength: numberValue(input.maxLength),
      minItems: numberValue(input.minItems),
      maxItems: numberValue(input.maxItems),
      pattern: input.pattern,
      required: asStringArray(input.required),
      properties: Object.keys(properties).length > 0 ? properties : undefined,
      items: input.items ? this.schema(input.items, `${source}.items`, seen) : undefined,
      oneOf: schemaArray(input.oneOf, (item, index) => this.schema(item, `${source}.oneOf.${index}`, seen)),
      anyOf: schemaArray(input.anyOf, (item, index) => this.schema(item, `${source}.anyOf.${index}`, seen)),
      allOf: schemaArray(input.allOf, (item, index) => this.schema(item, `${source}.allOf.${index}`, seen)),
      source
    };
    if (input.type === "file" || input.format === "binary") {
      result.type = "file";
    }
    if (input.additionalProperties && result.type === undefined) result.type = "object";
    return result;
  }

  private resolveRef(reference: string): unknown {
    if (!reference.startsWith("#/")) return {};
    return reference
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<unknown>((current, part) => asObject(current)[part], this.document);
  }
}

function mergePathParameters(
  routePath: string,
  parameters: EndpointParameter[],
  source: string
): EndpointParameter[] {
  return uniqueBy(
    [...parameters, ...pathParameters(routePath, source)],
    (parameter) => `${parameter.in}:${parameter.name.toLowerCase()}`
  );
}

function discoverRoutePrefix(document: JsonObject): string {
  if (typeof document.basePath === "string") return document.basePath;
  const serverUrl = document.servers?.[0]?.url;
  if (typeof serverUrl !== "string") return "";
  try {
    return new URL(serverUrl, "http://opspilot.local").pathname.replace(/\/$/, "");
  } catch {
    return serverUrl.startsWith("/") ? serverUrl : "";
  }
}

async function findOpenApiFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  const excluded = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  while (pending.length > 0 && files.length < 100) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(absolute);
      if (entry.isFile()) {
        const relative = normalizeRelative(path.relative(root, absolute));
        if (OPENAPI_NAMES.test(relative) || /\.(?:json|ya?ml)$/i.test(entry.name) && /api-docs|spec/i.test(relative)) {
          files.push(absolute);
        }
      }
    }
  }
  return files;
}

function isOpenApiDocument(value: unknown): value is JsonObject {
  const object = asObject(value);
  return Boolean(object.paths) && (typeof object.openapi === "string" || typeof object.swagger === "string");
}

function schemaFromParameterContent(content: unknown): unknown {
  const first = Object.values(asObject(content))[0];
  return asObject(first).schema;
}

function normalizeSchemaType(type: unknown, format: unknown): ContractSchemaNode["type"] | undefined {
  if (format === "binary") return "file";
  if (type === "string" || type === "integer" || type === "number" || type === "boolean" ||
      type === "object" || type === "array" || type === "null") {
    return type;
  }
  if (type === "file") return "file";
  return undefined;
}

function findRouteLine(content: string, routePath: string): number | undefined {
  const index = content.indexOf(routePath);
  if (index < 0) return undefined;
  return content.slice(0, index).split(/\r?\n/).length;
}

function extractExtensions(operation: JsonObject, names: string[]): string[] {
  return unique(names.flatMap((name) => {
    const value = operation[name];
    return Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
  }));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function schemaArray(
  value: unknown,
  convert: (item: unknown, index: number) => ContractSchemaNode
): ContractSchemaNode[] | undefined {
  return Array.isArray(value) ? value.map(convert) : undefined;
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}
