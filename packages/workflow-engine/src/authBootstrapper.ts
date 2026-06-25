import crypto from "node:crypto";
import { EndpointContract, IdentityScenario, IdentityDefinition, IdentityRelation } from "@opspilot/schemas";
import { logger } from "@opspilot/shared";
import { RequestGenerator } from "./requestGenerator.js";

export interface AuthSession {
  accessToken?: string;
  refreshToken?: string;
  cookies: string[];
  apiKey?: string;
  role: string;
  username?: string;
  password?: string;
  authenticated: boolean;
  evidence: string[];
  tenantId?: string;
}

export interface AuthEndpoints {
  register?: EndpointContract;
  login?: EndpointContract;
  refresh?: EndpointContract;
}

export interface AuthBootstrapOptions {
  timeoutMs?: number;
  request?: typeof fetch;
  apiKeys?: Record<string, string>;
  credentialsFactory?: (role: string) => {
    username: string;
    password: string;
    profile?: Record<string, unknown>;
  };
}

export class AuthBootstrapper {
  private readonly sessions = new Map<string, AuthSession>();
  private readonly requestGenerator = new RequestGenerator();
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;
  private readonly apiKeys: Record<string, string>;
  private readonly credentialsFactory: NonNullable<AuthBootstrapOptions["credentialsFactory"]>;

  constructor(
    private readonly baseApiUrl = "http://localhost:4000",
    options: AuthBootstrapOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs || 10_000;
    this.request = options.request || fetch;
    this.apiKeys = options.apiKeys || {};
    this.credentialsFactory = options.credentialsFactory || defaultCredentials;
  }

  public findAuthEndpoints(contracts: EndpointContract[], role?: string): AuthEndpoints {
    return {
      register: bestEndpoint(contracts, "register", role),
      login: bestEndpoint(contracts, "login", role),
      refresh: bestEndpoint(contracts, "refresh", role)
    };
  }

  public async bootstrapRequiredRoles(
    contracts: EndpointContract[]
  ): Promise<Map<string, AuthSession>> {
    const roles = new Set(
      contracts.flatMap((contract) => contract.roles.length ? contract.roles : ["user"])
    );
    if (roles.size === 0) roles.add("user");
    for (const role of roles) await this.bootstrapAuth(contracts, role);
    return new Map(this.sessions);
  }

  public async bootstrapAuth(
    contracts: EndpointContract[],
    role = "user",
    customCredentials?: {
      username: string;
      password: string;
      profile?: Record<string, unknown>;
    }
  ): Promise<AuthSession | null> {
    const existing = this.sessions.get(role);
    if (existing?.authenticated) return existing;

    const apiKeySession = this.createApiKeySession(contracts, role);
    const { register, login } = this.findAuthEndpoints(contracts, role);
    if (!login) {
      if (apiKeySession) {
        this.sessions.set(role, apiKeySession);
        return apiKeySession;
      }
      logger.warn({ role }, "Authentication bootstrap skipped because no login contract was discovered");
      return null;
    }

    const credentials = customCredentials || this.credentialsFactory(role);
    const evidence: string[] = [];
    let cookies: string[] = [];
    let csrfToken: string | undefined;

    const needsCsrf = [register, login].some((c) =>
      c?.security.some((s) => s.type === "cookie" || s.type === "session") ||
      c?.requestBody?.content["application/x-www-form-urlencoded"]
    );

    if (needsCsrf) {
      // Probe for CSRF token
      const probePaths = [
        "/api/csrf",
        "/csrf",
        register?.path,
        login?.path
      ].filter((p): p is string => Boolean(p));

      for (const probePath of probePaths) {
        try {
          const probeUrl = new URL(probePath, this.baseApiUrl).toString();
          const probeRes = await this.request(probeUrl, {
            method: "GET",
            headers: cookies.length ? { Cookie: cookies.join("; ") } : undefined,
            signal: AbortSignal.timeout(this.timeoutMs)
          });
          cookies = mergeCookies(cookies, readSetCookies(probeRes.headers));
          const probeText = await probeRes.text();
          const probeBody = parseBody(probeText);
          
          const extracted = extractCsrfToken(probeBody, cookies);
          if (extracted) {
            csrfToken = extracted;
            evidence.push(`CSRF token probed from ${probePath}`);
            break;
          }
        } catch (e) {
          // Ignore probe failures
        }
      }
    }

    if (register) {
      const registration = await this.executeAuthRequest(
        register,
        credentials,
        role,
        cookies,
        csrfToken
      );
      cookies = mergeCookies(cookies, registration.cookies);
      const regCsrf = extractCsrfToken(registration.body, cookies);
      if (regCsrf) csrfToken = regCsrf;
      evidence.push(
        `${register.method} ${register.path} returned ${registration.status}`
      );
      if (!registration.success && registration.status !== 409) {
        logger.warn({
          role,
          path: register.path,
          status: registration.status
        }, "Test-user registration did not succeed; attempting login with the generated identity");
      }
    }

    const authentication = await this.executeAuthRequest(
      login,
      credentials,
      role,
      cookies,
      csrfToken
    );
    cookies = mergeCookies(cookies, authentication.cookies);
    evidence.push(`${login.method} ${login.path} returned ${authentication.status}`);
    if (!authentication.success) {
      logger.warn({
        role,
        path: login.path,
        status: authentication.status
      }, "Authentication bootstrap failed");
      return null;
    }

    const tokens = extractTokens(authentication.body);
    const tenantId = extractTenantId(authentication.body) || (tokens.accessToken ? extractTenantId(decodeJwt(tokens.accessToken)) : undefined);
    const session: AuthSession = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      cookies,
      apiKey: apiKeySession?.apiKey,
      role,
      username: credentials.username,
      password: credentials.password,
      authenticated: Boolean(tokens.accessToken || cookies.length || apiKeySession?.apiKey),
      evidence,
      tenantId
    };
    if (!session.authenticated) {
      logger.warn({ role, path: login.path }, "Login succeeded but returned no usable credential");
      return null;
    }

    this.sessions.set(role, session);
    logger.info({
      role,
      hasAccessToken: Boolean(session.accessToken),
      hasRefreshToken: Boolean(session.refreshToken),
      cookieCount: session.cookies.length,
      hasApiKey: Boolean(session.apiKey),
      tenantId: session.tenantId
    }, "Authentication session bootstrapped");
    return session;
  }

  public async refreshSession(
    contracts: EndpointContract[],
    role = "user"
  ): Promise<AuthSession | null> {
    const session = this.sessions.get(role);
    const refresh = this.findAuthEndpoints(contracts, role).refresh;
    if (!session || !refresh || (!session.refreshToken && session.cookies.length === 0)) {
      return null;
    }

    const credentials = {
      username: session.username || "",
      password: session.password || "",
      profile: session.refreshToken ? { refreshToken: session.refreshToken } : undefined
    };
    const response = await this.executeAuthRequest(
      refresh,
      credentials,
      role,
      session.cookies
    );
    if (!response.success) return null;

    const tokens = extractTokens(response.body);
    const refreshed: AuthSession = {
      ...session,
      accessToken: tokens.accessToken || session.accessToken,
      refreshToken: tokens.refreshToken || session.refreshToken,
      cookies: mergeCookies(session.cookies, response.cookies),
      evidence: [
        ...session.evidence,
        `${refresh.method} ${refresh.path} returned ${response.status}`
      ]
    };
    this.sessions.set(role, refreshed);
    return refreshed;
  }

  public setSession(role: string, session: Omit<AuthSession, "role">): void {
    this.sessions.set(role, { ...session, role });
  }

  public getSession(role = "user"): AuthSession | undefined {
    return this.sessions.get(role);
  }

  public getAuthHeaders(contract: EndpointContract): Record<string, string> {
    const requiredRole = contract.roles[0] || "user";
    const session = this.sessions.get(requiredRole) || this.sessions.get("user");
    if (!session?.authenticated) return {};

    const headers: Record<string, string> = {};
    for (const security of contract.security) {
      if ((security.type === "bearer" || security.type === "oauth2") && session.accessToken) {
        headers.Authorization = `Bearer ${session.accessToken}`;
      } else if (security.type === "basic" && session.username && session.password) {
        headers.Authorization = `Basic ${Buffer.from(`${session.username}:${session.password}`).toString("base64")}`;
      } else if ((security.type === "cookie" || security.type === "session") && session.cookies.length) {
        headers.Cookie = session.cookies.join("; ");
      } else if (security.type === "apiKey" && session.apiKey) {
        const keyName = security.name || "x-api-key";
        if (security.in === "cookie") {
          headers.Cookie = [headers.Cookie, `${keyName}=${session.apiKey}`]
            .filter(Boolean)
            .join("; ");
        } else {
          headers[keyName] = session.apiKey;
        }
      }
    }

    if (
      Object.keys(headers).length === 0 &&
      (contract.roles.length > 0 || contract.permissions.length > 0) &&
      session.accessToken
    ) {
      headers.Authorization = `Bearer ${session.accessToken}`;
    }
    return headers;
  }

  private createApiKeySession(
    contracts: EndpointContract[],
    role: string
  ): AuthSession | undefined {
    const schemes = contracts.flatMap((contract) =>
      contract.security.filter((security) => security.type === "apiKey")
    );
    for (const scheme of schemes) {
      const candidates = [
        role,
        scheme.name,
        scheme.scheme,
        "default"
      ].filter((value): value is string => Boolean(value));
      const key = candidates.map((candidate) => this.apiKeys[candidate]).find(Boolean);
      if (key) {
        return {
          apiKey: key,
          cookies: [],
          role,
          authenticated: true,
          evidence: [`API key loaded for ${scheme.name || scheme.scheme}`]
        };
      }
    }
    return undefined;
  }

  private async executeAuthRequest(
    contract: EndpointContract,
    credentials: {
      username: string;
      password: string;
      profile?: Record<string, unknown>;
    },
    role: string,
    cookies: string[],
    csrfToken?: string
  ): Promise<{
    success: boolean;
    status: number;
    body: unknown;
    cookies: string[];
  }> {
    const generated = this.requestGenerator.generateValidRequest(contract, {
      variables: {
        email: credentials.username,
        username: credentials.username,
        login: credentials.username,
        password: credentials.password,
        role,
        ...(credentials.profile || {})
      },
      headers: cookies.length ? { Cookie: cookies.join("; ") } : undefined
    });
    const config = generated.config;
    if (csrfToken) {
      config.headers = {
        ...config.headers,
        "X-CSRF-Token": csrfToken,
        "X-XSRF-Token": csrfToken
      };
      if (config.payload && typeof config.payload === "object" && !Array.isArray(config.payload)) {
        (config.payload as any)._csrf = csrfToken;
        (config.payload as any).csrf_token = csrfToken;
        (config.payload as any).csrfToken = csrfToken;
      }
    }

    const configHeaders = { ...config.headers };
    let body: any = undefined;
    if (config.payload !== undefined) {
      if (config.bodyEncoding === "form") {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(config.payload as Record<string, any>)) {
          params.append(k, String(v));
        }
        body = params.toString();
        configHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      } else if (config.bodyEncoding === "multipart") {
        const formData = new FormData();
        for (const [k, v] of Object.entries(config.payload as Record<string, any>)) {
          if (v && typeof v === "object" && "filename" in v) {
            const fileObj = v as any;
            formData.append(k, new Blob([fileObj.content]), fileObj.filename);
          } else {
            formData.append(k, String(v));
          }
        }
        body = formData;
        delete configHeaders["Content-Type"];
      } else {
        body = JSON.stringify(config.payload);
      }
    }

    const url = new URL(config.url, this.baseApiUrl).toString();
    try {
      const response = await this.request(url, {
        method: config.method,
        headers: configHeaders,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const text = await response.text();
      let responseCookies = readSetCookies(response.headers);
      let responseBody = parseBody(text);

      let redirectUrl: string | undefined;
      if (response.status >= 300 && response.status < 400) {
        redirectUrl = response.headers.get("location") || undefined;
      } else if (response.ok && responseBody && typeof responseBody === "object") {
        const bodyObj = responseBody as any;
        redirectUrl = bodyObj.redirect || bodyObj.redirectUrl || bodyObj.url || undefined;
      }

      if (redirectUrl) {
        const targetUrl = new URL(redirectUrl, this.baseApiUrl).toString();
        const mergedCookies = mergeCookies(cookies, responseCookies);
        const redirectRes = await this.request(targetUrl, {
          method: "GET",
          headers: {
            ...configHeaders,
            Cookie: mergedCookies.join("; ")
          },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const redirectText = await redirectRes.text();
        return {
          success: redirectRes.ok,
          status: redirectRes.status,
          body: parseBody(redirectText),
          cookies: mergeCookies(mergedCookies, readSetCookies(redirectRes.headers))
        };
      }

      return {
        success: response.ok,
        status: response.status,
        body: responseBody,
        cookies: responseCookies
      };
    } catch (error) {
      logger.warn({
        error: error instanceof Error ? error.message : String(error),
        method: contract.method,
        path: contract.path
      }, "Authentication request failed");
      return { success: false, status: 0, body: null, cookies: [] };
    }
  }

  public async bootstrapScenario(
    contracts: EndpointContract[],
    scenario: IdentityScenario
  ): Promise<Map<string, AuthSession>> {
    const scenarioSessions = new Map<string, AuthSession>();
    const tenantMap = new Map<string, string>();

    const sortedIdentities = [...scenario.identities].sort((a, b) => {
      const aDependsOnB = a.relations.some((r) => r.target === b.name);
      const bDependsOnA = b.relations.some((r) => r.target === a.name);
      if (aDependsOnB && !bDependsOnA) return 1;
      if (bDependsOnA && !aDependsOnB) return -1;
      return 0;
    });

    for (const identity of sortedIdentities) {
      const customContracts = [...contracts];
      
      if (identity.endpoints?.registerPath) {
        const regIndex = customContracts.findIndex((c) =>
          endpointScore(c, "register", identity.role) > 0
        );
        if (regIndex !== -1) {
          customContracts[regIndex] = {
            ...customContracts[regIndex],
            path: identity.endpoints.registerPath
          };
        }
      }
      if (identity.endpoints?.loginPath) {
        const logIndex = customContracts.findIndex((c) =>
          endpointScore(c, "login", identity.role) > 0
        );
        if (logIndex !== -1) {
          customContracts[logIndex] = {
            ...customContracts[logIndex],
            path: identity.endpoints.loginPath
          };
        }
      }

      const suffix = crypto.randomBytes(6).toString("hex");
      const credentials = {
        username: identity.credentials?.username || `opspilot.${sanitizeRole(identity.name)}.${suffix}@example.com`,
        password: identity.credentials?.password || `OpsPilot-${suffix}-Aa1!`,
        profile: {
          role: identity.role,
          name: `OpsPilot ${identity.name}`,
          ...(identity.credentials?.profile || {})
        }
      };

      for (const rel of identity.relations) {
        if (rel.type === "same-tenant" && tenantMap.has(rel.target)) {
          const tenantId = tenantMap.get(rel.target)!;
          (credentials.profile as any).tenantId = tenantId;
          (credentials.profile as any).orgId = tenantId;
          (credentials.profile as any).organizationId = tenantId;
          (credentials.profile as any).tenant_id = tenantId;
          (credentials.profile as any).org_id = tenantId;
        }
      }

      const session = await this.bootstrapAuth(customContracts, identity.role, credentials);

      if (session) {
        scenarioSessions.set(identity.name, session);
        this.sessions.set(identity.name, session);
        this.sessions.set(identity.role, session);

        if (session.tenantId) {
          tenantMap.set(identity.name, session.tenantId);
        }
      }
    }

    return scenarioSessions;
  }
}

function decodeJwt(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractCsrfToken(body: unknown, cookies: string[]): string | undefined {
  for (const cookie of cookies) {
    const parts = cookie.split("=")[0]?.trim().toLowerCase();
    if (parts && ["csrf", "xsrf-token", "_csrf", "csrf-token", "csrftoken"].some(k => parts.includes(k))) {
      return cookie.split("=")[1]?.split(";")[0]?.trim();
    }
  }
  if (body && typeof body === "object") {
    const flattened = flattenObject(body);
    for (const [path, val] of flattened) {
      const key = path.split(".").pop()?.toLowerCase();
      if (key && ["csrf", "xsrf", "csrftoken", "_csrf", "token"].some(k => key.includes(k)) && typeof val === "string") {
        return val;
      }
    }
  }
  return undefined;
}

function extractTenantId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const flattened = flattenObject(body);
  const tenantKeys = ["tenantid", "orgid", "organizationid", "companyid", "tenant_id", "org_id", "company_id"];
  for (const [path, val] of flattened) {
    const key = path.split(".").pop()?.toLowerCase();
    if (key && tenantKeys.includes(key) && (typeof val === "string" || typeof val === "number")) {
      return String(val);
    }
  }
  return undefined;
}

function bestEndpoint(
  contracts: EndpointContract[],
  kind: "register" | "login" | "refresh",
  role?: string
): EndpointContract | undefined {
  const candidates = contracts
    .filter((contract) => contract.method.toUpperCase() === "POST")
    .map((contract) => ({ contract, score: endpointScore(contract, kind, role) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.contract.confidence - a.contract.confidence);
  return candidates[0]?.contract;
}

function endpointScore(
  contract: EndpointContract,
  kind: "register" | "login" | "refresh",
  role?: string
): number {
  const path = contract.path.toLowerCase();
  const summary = `${contract.summary || ""} ${contract.operationId || ""}`.toLowerCase();
  const tokens = kind === "register"
    ? ["register", "signup", "sign-up", "create-user"]
    : kind === "login"
      ? ["login", "signin", "sign-in", "authenticate", "session", "token"]
      : ["refresh", "renew"];
  let score = 0;
  for (const token of tokens) {
    if (path.includes(token)) score += 5;
    if (summary.includes(token)) score += 3;
  }
  if (path.includes("/auth/")) score += 1;
  if (kind === "login" && path.includes("refresh")) score -= 10;
  if (kind !== "register" && path.includes("register")) score -= 10;

  if (role) {
    const roleLower = role.toLowerCase();
    if (contract.roles.map((r) => r.toLowerCase()).includes(roleLower)) {
      score += 15;
    }
    if (path.includes(roleLower)) score += 10;
    if (summary.includes(roleLower)) score += 5;

    const otherRoles = ["admin", "partner", "customer", "user", "service", "legacy"].filter(
      (r) => r !== roleLower
    );
    for (const other of otherRoles) {
      if (path.includes(other)) score -= 8;
      if (summary.includes(other)) score -= 4;
    }
  }

  return score;
}

function defaultCredentials(role: string): {
  username: string;
  password: string;
  profile: Record<string, unknown>;
} {
  const suffix = crypto.randomBytes(6).toString("hex");
  return {
    username: `opspilot.${sanitizeRole(role)}.${suffix}@example.com`,
    password: `OpsPilot-${suffix}-Aa1!`,
    profile: {
      role,
      name: `OpsPilot ${role} test user`
    }
  };
}

function sanitizeRole(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "user";
}

function extractTokens(body: unknown): {
  accessToken?: string;
  refreshToken?: string;
} {
  const values = flattenObject(body);
  const accessToken = findToken(values, [
    "accesstoken",
    "access_token",
    "token",
    "jwt",
    "idtoken",
    "id_token"
  ]);
  const refreshToken = findToken(values, ["refreshtoken", "refresh_token"]);
  return { accessToken, refreshToken };
}

function flattenObject(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (!value || typeof value !== "object") return [];
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    entries.push([path, child]);
    if (child && typeof child === "object" && !Array.isArray(child)) {
      entries.push(...flattenObject(child, path));
    }
  }
  return entries;
}

function findToken(entries: Array<[string, unknown]>, names: string[]): string | undefined {
  for (const name of names) {
    const match = entries.find(([path, value]) => {
      const key = path.split(".").pop()?.toLowerCase().replace(/-/g, "_");
      return key === name && typeof value === "string" && value.length > 0;
    });
    if (match) return match[1] as string;
  }
  return undefined;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.() || [];
  if (values.length) return values.map(cookiePair);
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookie(combined).map(cookiePair) : [];
}

function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((item) => item.trim());
}

function cookiePair(value: string): string {
  return value.split(";")[0].trim();
}

function mergeCookies(existing: string[], incoming: string[]): string[] {
  const cookies = new Map<string, string>();
  for (const cookie of [...existing, ...incoming]) {
    const name = cookie.split("=")[0]?.trim().toLowerCase();
    if (name) cookies.set(name, cookie);
  }
  return [...cookies.values()];
}
