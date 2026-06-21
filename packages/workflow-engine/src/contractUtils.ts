import crypto from "node:crypto";
import {
  ContractSchemaNode,
  EndpointContract,
  EndpointParameter,
  EndpointSecurity,
  ResponseContract
} from "@opspilot/schemas";

export function endpointContractId(method: string, routePath: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${method.toUpperCase()} ${normalizeRoutePath(routePath)}`)
    .digest("hex")
    .slice(0, 16);
  return `endpoint-${digest}`;
}

export function normalizeRoutePath(routePath: string): string {
  const value = routePath.trim();
  if (!value) return "/";
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const normalized = withLeadingSlash
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return normalized || "/";
}

export function joinRoutePaths(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
  return normalizeRoutePath(joined);
}

export function pathParameters(routePath: string, source: string): EndpointParameter[] {
  const parameters: EndpointParameter[] = [];
  const seen = new Set<string>();
  for (const match of routePath.matchAll(/:([A-Za-z0-9_]+)(?:\([^)]*\))?\??|\{([^}]+)\}/g)) {
    const name = match[1] || match[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string", source },
      source
    });
  }
  return parameters;
}

export function successfulStatus(responses: ResponseContract[], method: string): number | undefined {
  const explicit = responses
    .map((response) => Number(response.status))
    .filter((status) => Number.isInteger(status) && status >= 200 && status < 400)
    .sort((a, b) => a - b)[0];
  if (explicit) return explicit;
  if (method.toUpperCase() === "POST") return 201;
  if (method.toUpperCase() === "DELETE") return 204;
  return 200;
}

export function mergeEndpointContracts(contracts: EndpointContract[]): EndpointContract[] {
  const merged = new Map<string, EndpointContract>();
  for (const contract of contracts) {
    const key = `${contract.method.toUpperCase()}:${canonicalRoutePath(contract.path)}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, contract);
      continue;
    }
    merged.set(key, mergeContract(current, contract));
  }
  return [...merged.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
}

function mergeContract(left: EndpointContract, right: EndpointContract): EndpointContract {
  const primary = left.confidence >= right.confidence ? left : right;
  const secondary = primary === left ? right : left;
  return {
    ...primary,
    summary: primary.summary || secondary.summary,
    operationId: primary.operationId || secondary.operationId,
    tags: unique([...left.tags, ...right.tags]),
    parameters: mergeParameters(left.parameters, right.parameters),
    requestBody: mergeRequestBodies(left.requestBody, right.requestBody),
    responses: mergeResponses(left.responses, right.responses),
    security: mergeSecurity(left.security, right.security),
    middleware: uniqueBy([...left.middleware, ...right.middleware], (item) => `${item.kind}:${item.name}`),
    requiredEnvironment: unique([...left.requiredEnvironment, ...right.requiredEnvironment]),
    roles: unique([...left.roles, ...right.roles]),
    permissions: unique([...left.permissions, ...right.permissions]),
    prisma: uniqueBy(
      [...left.prisma, ...right.prisma],
      (item) => `${item.model}:${item.operation}:${item.source}`
    ),
    evidence: unique([
      ...left.evidence,
      ...right.evidence,
      `Merged ${left.framework} and ${right.framework} evidence for ${primary.method} ${primary.path}.`
    ]),
    confidence: Math.max(left.confidence, right.confidence)
  };
}

function mergeParameters(left: EndpointParameter[], right: EndpointParameter[]): EndpointParameter[] {
  const result = new Map<string, EndpointParameter>();
  for (const parameter of [...left, ...right]) {
    const key = `${parameter.in}:${parameter.name.toLowerCase()}`;
    const current = result.get(key);
    result.set(key, current
      ? {
          ...current,
          required: current.required || parameter.required,
          description: current.description || parameter.description,
          schema: mergeSchema(current.schema, parameter.schema),
          source: `${current.source}; ${parameter.source}`
        }
      : parameter);
  }
  return [...result.values()];
}

function mergeRequestBodies(
  left: EndpointContract["requestBody"],
  right: EndpointContract["requestBody"]
): EndpointContract["requestBody"] {
  if (!left) return right;
  if (!right) return left;
  const content: Record<string, ContractSchemaNode> = { ...left.content };
  for (const [mediaType, schema] of Object.entries(right.content)) {
    content[mediaType] = content[mediaType] ? mergeSchema(content[mediaType], schema) : schema;
  }
  return {
    required: left.required || right.required,
    content,
    source: `${left.source}; ${right.source}`
  };
}

function mergeResponses(left: ResponseContract[], right: ResponseContract[]): ResponseContract[] {
  const result = new Map<string, ResponseContract>();
  for (const response of [...left, ...right]) {
    const current = result.get(response.status);
    if (!current) {
      result.set(response.status, response);
      continue;
    }
    const content = { ...current.content };
    for (const [mediaType, schema] of Object.entries(response.content)) {
      content[mediaType] = content[mediaType] ? mergeSchema(content[mediaType], schema) : schema;
    }
    result.set(response.status, {
      status: response.status,
      description: current.description || response.description,
      headers: { ...response.headers, ...current.headers },
      content
    });
  }
  return [...result.values()];
}

function mergeSecurity(left: EndpointSecurity[], right: EndpointSecurity[]): EndpointSecurity[] {
  return uniqueBy([...left, ...right], (item) =>
    `${item.scheme}:${item.type}:${item.in || ""}:${item.name || ""}`
  );
}

export function mergeSchema(left: ContractSchemaNode, right: ContractSchemaNode): ContractSchemaNode {
  if (isUnknownSchema(left)) return right;
  if (isUnknownSchema(right)) return left;
  if (left.type && right.type && left.type !== right.type) {
    return { oneOf: uniqueSchemas([left, right]), source: joinSources(left.source, right.source) };
  }
  const properties: Record<string, ContractSchemaNode> = { ...(left.properties || {}) };
  for (const [name, schema] of Object.entries(right.properties || {})) {
    properties[name] = properties[name] ? mergeSchema(properties[name], schema) : schema;
  }
  return {
    ...right,
    ...left,
    enum: left.enum || right.enum,
    required: unique([...(left.required || []), ...(right.required || [])]),
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    items: left.items && right.items ? mergeSchema(left.items, right.items) : left.items || right.items,
    oneOf: uniqueSchemas([...(left.oneOf || []), ...(right.oneOf || [])]),
    anyOf: uniqueSchemas([...(left.anyOf || []), ...(right.anyOf || [])]),
    allOf: uniqueSchemas([...(left.allOf || []), ...(right.allOf || [])]),
    source: joinSources(left.source, right.source)
  };
}

function isUnknownSchema(schema: ContractSchemaNode): boolean {
  return schema.type === "unknown" ||
    (!schema.type && !schema.ref && !schema.oneOf && !schema.anyOf && !schema.allOf);
}

function uniqueSchemas(schemas: ContractSchemaNode[]): ContractSchemaNode[] | undefined {
  const result = uniqueBy(schemas, (schema) => JSON.stringify(schema));
  return result.length > 0 ? result : undefined;
}

function joinSources(left?: string, right?: string): string | undefined {
  return unique([left, right].filter((value): value is string => Boolean(value))).join("; ") || undefined;
}

export function canonicalRoutePath(routePath: string): string {
  return normalizeRoutePath(routePath)
    .replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?\??/g, "{$1}");
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const itemKey = key(value);
    if (!result.has(itemKey)) result.set(itemKey, value);
  }
  return [...result.values()];
}
