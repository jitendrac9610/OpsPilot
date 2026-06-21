import { EndpointContract, ContractSchemaNode } from "@opspilot/schemas";
import { HTTPDriverConfig } from "./drivers.js";

export type RequestVariantKind =
  | "valid"
  | "missing-field"
  | "invalid-type"
  | "boundary"
  | "unauthorized"
  | "forbidden"
  | "duplicate"
  | "malformed";

export interface RequestGenerationContext {
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface GeneratedRequestVariant {
  kind: RequestVariantKind;
  description: string;
  config: HTTPDriverConfig;
  repetitions?: number;
}

export interface GeneratedRequestSuite {
  valid: GeneratedRequestVariant;
  negative: GeneratedRequestVariant[];
}

export class RequestGenerator {
  public generateRequestSuite(
    contract: EndpointContract,
    context: RequestGenerationContext = {}
  ): GeneratedRequestSuite {
    const valid = this.generateValidRequest(contract, context);
    return {
      valid,
      negative: this.generateFaultVariants(contract, valid.config, context)
    };
  }

  public generateValidRequest(
    contract: EndpointContract,
    context: RequestGenerationContext = {}
  ): GeneratedRequestVariant {
    const variables = context.variables || {};
    const headers = { ...(context.headers || {}) };
    const cookies = { ...(context.cookies || {}) };
    const query = new URLSearchParams();
    const pathVariables: Record<string, unknown> = {};

    for (const parameter of contract.parameters) {
      const supplied = findVariable(variables, parameter.name);
      const value = supplied ?? this.generateValidPayload(parameter.schema, parameter.name, variables);
      if (parameter.in === "path") pathVariables[parameter.name] = value;
      if (parameter.in === "query" && (parameter.required || supplied !== undefined)) {
        appendQueryValue(query, parameter.name, value);
      }
      if (parameter.in === "header" && (parameter.required || supplied !== undefined)) {
        headers[parameter.name] = String(value);
      }
      if (parameter.in === "cookie" && (parameter.required || supplied !== undefined)) {
        cookies[parameter.name] = String(value);
      }
    }

    if (Object.keys(cookies).length > 0) {
      const generatedCookies = Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      headers.Cookie = headers.Cookie
        ? `${headers.Cookie}; ${generatedCookies}`
        : generatedCookies;
    }

    const bodyContract = selectBodySchema(contract);
    const payload = bodyContract
      ? this.generateValidPayload(bodyContract.schema, "body", variables)
      : undefined;
    const url = appendQuery(this.resolvePath(contract.path, pathVariables), query);
    if (bodyContract && bodyContract.encoding !== "multipart" && !hasContentType(headers)) {
      headers["Content-Type"] = bodyContract.contentType;
    }

    return {
      kind: "valid",
      description: `Valid ${contract.method} ${contract.path} request`,
      config: {
        method: contract.method,
        url,
        payload,
        headers,
        bodyEncoding: bodyContract?.encoding,
        expectedStatus: successfulStatus(contract)
      }
    };
  }

  public generateValidPayload(
    schema?: ContractSchemaNode,
    fieldName = "value",
    variables: Record<string, unknown> = {}
  ): unknown {
    if (!schema) return undefined;
    const supplied = findVariable(variables, fieldName);
    if (supplied !== undefined && fieldName !== "body") return supplied;
    if (schema.const !== undefined) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (schema.example !== undefined) return schema.example;
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];
    if (schema.oneOf?.length) return this.generateValidPayload(schema.oneOf[0], fieldName, variables);
    if (schema.anyOf?.length) return this.generateValidPayload(schema.anyOf[0], fieldName, variables);
    if (schema.allOf?.length) {
      return schema.allOf.reduce<Record<string, unknown>>((combined, member) => {
        const generated = this.generateValidPayload(member, fieldName, variables);
        return generated && typeof generated === "object" && !Array.isArray(generated)
          ? { ...combined, ...generated as Record<string, unknown> }
          : combined;
      }, {});
    }
    if (schema.type === "object" && schema.properties) {
      const obj: Record<string, unknown> = {};
      const required = new Set(schema.required || []);
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (required.has(key) || findVariable(variables, key) !== undefined || shouldGenerateOptional(prop)) {
          obj[key] = this.generateValidPayload(prop, key, variables);
        }
      }
      return obj;
    }
    if (schema.type === "array" && schema.items) {
      const count = Math.max(1, schema.minItems || 1);
      return Array.from(
        { length: count },
        () => this.generateValidPayload(schema.items, fieldName, variables)
      );
    }

    switch (schema.type) {
      case "string":
        return generateString(schema, fieldName);
      case "integer":
      case "number": {
        const minimum = schema.minimum ?? 0;
        const maximum = schema.maximum;
        const candidate = maximum === undefined
          ? minimum
          : minimum + ((maximum - minimum) / 2);
        return schema.type === "integer" ? Math.ceil(candidate) : candidate;
      }
      case "boolean":
        return true;
      case "file":
        return {
          filename: `${sanitizeName(fieldName)}.txt`,
          content: "OpsPilot generated upload fixture",
          contentType: "text/plain"
        };
      case "null":
        return null;
      case "unknown":
        return valueFromFieldName(fieldName);
      default:
        if (schema.ref) return valueFromFieldName(fieldName);
        return valueFromFieldName(fieldName);
    }
  }

  public generateFaultVariants(
    contract: EndpointContract,
    validConfig: HTTPDriverConfig,
    context: RequestGenerationContext = {}
  ): GeneratedRequestVariant[] {
    const variants: GeneratedRequestVariant[] = [];
    const bodyContract = selectBodySchema(contract);
    const bodySchema = bodyContract?.schema;
    const baseBody = asObject(validConfig.payload);

    if (bodySchema?.type === "object" && bodySchema.properties && bodySchema.required?.length) {
      for (const requiredField of bodySchema.required) {
        const payload = { ...baseBody };
        delete payload[requiredField];
        variants.push({
          kind: "missing-field",
          description: `Missing required body field ${requiredField}`,
          config: {
            ...cloneConfig(validConfig),
            payload,
            expectedStatus: clientErrorStatus(contract, 400)
          }
        });
      }
    }

    if (bodySchema?.type === "object" && bodySchema.properties) {
      for (const [key, prop] of Object.entries(bodySchema.properties)) {
        const payload = { ...baseBody };
        payload[key] = invalidValueFor(prop);
        variants.push({
          kind: "invalid-type",
          description: `Invalid type for body field ${key}`,
          config: {
            ...cloneConfig(validConfig),
            payload,
            expectedStatus: clientErrorStatus(contract, 400)
          }
        });
      }
    }

    if (bodySchema?.type === "object" && bodySchema.properties) {
      for (const [key, prop] of Object.entries(bodySchema.properties)) {
        if (prop.type === "integer" || prop.type === "number") {
          if (prop.minimum !== undefined) {
            variants.push({
              kind: "boundary",
              description: `Body field ${key} below minimum`,
              config: {
                ...cloneConfig(validConfig),
                payload: { ...baseBody, [key]: prop.minimum - 1 },
                expectedStatus: clientErrorStatus(contract, 400)
              }
            });
          }
          if (prop.maximum !== undefined) {
            variants.push({
              kind: "boundary",
              description: `Body field ${key} above maximum`,
              config: {
                ...cloneConfig(validConfig),
                payload: { ...baseBody, [key]: prop.maximum + 1 },
                expectedStatus: clientErrorStatus(contract, 400)
              }
            });
          }
        }
        if (prop.type === "string") {
          if (prop.minLength !== undefined && prop.minLength > 0) {
            variants.push({
              kind: "boundary",
              description: `Body field ${key} below minimum length`,
              config: {
                ...cloneConfig(validConfig),
                payload: { ...baseBody, [key]: "a".repeat(prop.minLength - 1) },
                expectedStatus: clientErrorStatus(contract, 400)
              }
            });
          }
          if (prop.maxLength !== undefined) {
            variants.push({
              kind: "boundary",
              description: `Body field ${key} above maximum length`,
              config: {
                ...cloneConfig(validConfig),
                payload: { ...baseBody, [key]: "a".repeat(prop.maxLength + 1) },
                expectedStatus: clientErrorStatus(contract, 400)
              }
            });
          }
        }
      }
    }

    if (contract.security.length > 0) {
      const headers = removeAuthenticationHeaders(validConfig.headers || {}, contract);
      variants.push({
        kind: "unauthorized",
        description: "Missing authentication credentials",
        config: {
          ...cloneConfig(validConfig),
          headers,
          expectedStatus: responseStatus(contract, [401], 401)
        }
      });
    }

    if (contract.roles.length > 0 || contract.permissions.length > 0) {
      const headers = {
        ...(validConfig.headers || {}),
        ...(context.headers || {}),
        Authorization: "Bearer opspilot-insufficient-role"
      };
      variants.push({
        kind: "forbidden",
        description: "Authenticated identity lacks the required role or permission",
        config: {
          ...cloneConfig(validConfig),
          headers,
          expectedStatus: responseStatus(contract, [403], 403)
        }
      });
    }

    const idempotency = findIdempotencyLocation(contract, bodySchema);
    if (idempotency) {
      const duplicate = cloneConfig(validConfig);
      if (idempotency.location === "body") {
        duplicate.payload = { ...baseBody, [idempotency.name]: "opspilot-idempotency-key" };
      } else {
        duplicate.headers = {
          ...(duplicate.headers || {}),
          [idempotency.name]: "opspilot-idempotency-key"
        };
      }
      variants.push({
        kind: "duplicate",
        description: `Repeat request with the same ${idempotency.name}`,
        config: {
          ...duplicate,
          expectedStatus: responseStatus(contract, [200, 201, 202, 204, 409], duplicate.expectedStatus || 409)
        },
        repetitions: 2
      });
    }

    if (bodyContract?.encoding === "json") {
      variants.push({
        kind: "malformed",
        description: "Malformed JSON request body",
        config: {
          ...cloneConfig(validConfig),
          payload: "{\"opspilot\":",
          bodyEncoding: "raw",
          headers: {
            ...(validConfig.headers || {}),
            "Content-Type": "application/json"
          },
          expectedStatus: clientErrorStatus(contract, 400)
        }
      });
    }

    return variants;
  }

  public resolvePath(routePath: string, variables: Record<string, unknown>): string {
    let resolved = routePath;
    for (const [key, value] of Object.entries(variables)) {
      resolved = resolved
        .replace(new RegExp(`:${escapeRegex(key)}\\b`, "g"), encodeURIComponent(String(value)))
        .replace(new RegExp(`{${escapeRegex(key)}}`, "g"), encodeURIComponent(String(value)));
    }
    resolved = resolved
      .replace(/:([A-Za-z0-9_]+)/g, (_match, name) => encodeURIComponent(String(valueFromFieldName(name))))
      .replace(/{([A-Za-z0-9_]+)}/g, (_match, name) => encodeURIComponent(String(valueFromFieldName(name))));
    return resolved;
  }
}

function selectBodySchema(contract: EndpointContract): {
  schema: ContractSchemaNode;
  contentType: string;
  encoding: NonNullable<HTTPDriverConfig["bodyEncoding"]>;
} | undefined {
  const content = contract.requestBody?.content;
  if (!content) return undefined;
  const priority: Array<[string, NonNullable<HTTPDriverConfig["bodyEncoding"]>]> = [
    ["application/json", "json"],
    ["application/problem+json", "json"],
    ["multipart/form-data", "multipart"],
    ["application/x-www-form-urlencoded", "form"],
    ["text/plain", "raw"]
  ];
  for (const [contentType, encoding] of priority) {
    if (content[contentType]) return { schema: content[contentType], contentType, encoding };
  }
  const first = Object.entries(content)[0];
  if (!first) return undefined;
  return {
    schema: first[1],
    contentType: first[0],
    encoding: first[0].includes("json") ? "json" : "raw"
  };
}

function shouldGenerateOptional(schema: ContractSchemaNode): boolean {
  return schema.default !== undefined || schema.example !== undefined || schema.const !== undefined;
}

function generateString(schema: ContractSchemaNode, fieldName: string): string {
  if (schema.format === "uuid") return "123e4567-e89b-42d3-a456-426614174000";
  if (schema.format === "email") return "opspilot@example.com";
  if (schema.format === "date") return "2026-01-15";
  if (schema.format === "date-time") return "2026-01-15T12:00:00.000Z";
  if (schema.format === "uri" || schema.format === "url") return "https://example.com/opspilot";
  if (schema.format === "hostname") return "example.com";
  if (schema.format === "ipv4") return "192.0.2.1";
  if (schema.format === "binary") return "OpsPilot generated binary fixture";

  let value = String(valueFromFieldName(fieldName));
  if (schema.pattern) value = valueForPattern(schema.pattern, value);
  const minimum = schema.minLength || 0;
  if (value.length < minimum) value = value.padEnd(minimum, "x");
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    value = value.slice(0, schema.maxLength);
  }
  return value;
}

function valueForPattern(pattern: string, fallback: string): string {
  if (/^\^?\\d\+?\$?$/.test(pattern) || pattern.includes("[0-9]")) return "123456";
  if (pattern.includes("[A-Z]")) return "OPSPILOT";
  if (pattern.includes("[a-z]")) return "opspilot";
  if (pattern.includes("@")) return "opspilot@example.com";
  return fallback;
}

function valueFromFieldName(fieldName: string): unknown {
  const normalized = fieldName.toLowerCase();
  if (normalized === "id" || normalized.endsWith("id") || normalized.endsWith("_id")) {
    return "123e4567-e89b-42d3-a456-426614174000";
  }
  if (normalized.includes("email")) return "opspilot@example.com";
  if (normalized.includes("password")) return "OpsPilot-Test-Password-42!";
  if (normalized.includes("phone")) return "+15550102020";
  if (normalized.includes("url")) return "https://example.com/opspilot";
  if (normalized.includes("name")) return "OpsPilot Test";
  if (normalized.includes("token")) return "opspilot-test-token";
  return "opspilot-test-value";
}

function findVariable(variables: Record<string, unknown>, name: string): unknown {
  if (variables[name] !== undefined) return variables[name];
  const normalized = name.toLowerCase();
  const match = Object.entries(variables).find(([key]) => key.toLowerCase() === normalized);
  return match?.[1];
}

function appendQueryValue(query: URLSearchParams, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => query.append(name, String(item)));
  } else if (value !== undefined && value !== null) {
    query.append(name, String(value));
  }
}

function appendQuery(url: string, query: URLSearchParams): string {
  const serialized = query.toString();
  if (!serialized) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${serialized}`;
}

function successfulStatus(contract: EndpointContract): number | undefined {
  const declared = contract.responses
    .map((response) => Number(response.status))
    .find((status) => status >= 200 && status < 400);
  if (declared) return declared;
  if (contract.method === "POST") return 201;
  if (contract.method === "DELETE") return 204;
  return 200;
}

function clientErrorStatus(contract: EndpointContract, fallback: number): number {
  return responseStatus(contract, [400, 422], fallback);
}

function responseStatus(contract: EndpointContract, preferred: number[], fallback: number): number {
  const declared = new Set(
    contract.responses
      .map((response) => Number(response.status))
      .filter(Number.isFinite)
  );
  return preferred.find((status) => declared.has(status)) || fallback;
}

function invalidValueFor(schema: ContractSchemaNode): unknown {
  switch (schema.type) {
    case "string": return 12345;
    case "integer":
    case "number": return "not-a-number";
    case "boolean": return "not-a-boolean";
    case "array": return { invalid: true };
    case "object": return ["not-an-object"];
    case "file": return 12345;
    case "null": return "not-null";
    default: return { invalid: true };
  }
}

function removeAuthenticationHeaders(
  input: Record<string, string>,
  contract: EndpointContract
): Record<string, string> {
  const securityNames = new Set(
    contract.security
      .flatMap((security) => [security.name, security.scheme])
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase())
  );
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== "authorization" &&
        normalized !== "cookie" &&
        normalized !== "x-api-key" &&
        !securityNames.has(normalized);
    })
  );
}

function findIdempotencyLocation(
  contract: EndpointContract,
  bodySchema?: ContractSchemaNode
): { location: "body" | "header"; name: string } | undefined {
  const bodyName = Object.keys(bodySchema?.properties || {})
    .find((name) => /idempotency[-_]?key/i.test(name));
  if (bodyName) return { location: "body", name: bodyName };
  const header = contract.parameters.find(
    (parameter) => parameter.in === "header" && /idempotency[-_]?key/i.test(parameter.name)
  );
  return header ? { location: "header", name: header.name } : undefined;
}

function cloneConfig(config: HTTPDriverConfig): HTTPDriverConfig {
  return {
    ...config,
    headers: { ...(config.headers || {}) },
    payload: config.payload && typeof config.payload === "object"
      ? structuredClone(config.payload)
      : config.payload
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-") || "upload";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
