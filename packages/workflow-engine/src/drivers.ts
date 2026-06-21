import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { logger } from "@opspilot/shared";

export interface HTTPDriverConfig {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  expectedStatus?: number;
  timeoutMs?: number;
  bodyEncoding?: "json" | "form" | "multipart" | "raw";
  correlationId?: string;
}

export interface BrowserDriverConfig {
  action: "navigate" | "click" | "fill" | "assert_visible";
  url?: string;
  selector?: string;
  text?: string;
  screenshotPath?: string;
  sessionId?: string;
  timeoutMs?: number;
  correlationId?: string;
}

export interface WebSocketDriverConfig {
  url: string;
  namespace?: string;
  event: string;
  payload?: unknown;
  action: "emit" | "listen" | "join_room";
  room?: string;
  auth?: Record<string, any>;
  timeoutMs?: number;
  requireAcknowledgement?: boolean;
  correlationId?: string;
}

export interface WebhookDriverConfig {
  type: "incoming" | "outgoing";
  endpointUrl?: string;
  provider?: "stripe" | "razorpay" | "github" | "custom";
  payload?: unknown;
  secret?: string;
  // Outgoing receiver config
  port?: number;
  responseStatus?: number;
  responseBody?: unknown;
  timeoutMs?: number;
  responseDelayMs?: number;
  correlationId?: string;
}

export interface BrowserDriverAdapter {
  execute(config: BrowserDriverConfig, correlationId: string): Promise<{ success: boolean; log: string }>;
}

export class WorkflowDrivers {
  private activeWsConnections = new Map<string, any>();
  private activeWebhookServers = new Map<number, http.Server>();
  private browserSessions = new Map<string, {
    browser: any;
    context: any;
    page: any;
    consoleErrors: string[];
    failedRequests: string[];
  }>();
  private capturedWebhooks = new Map<number, Array<{
    timestamp: string;
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>>();

  constructor(
    private readonly baseApiUrl = "http://localhost:4000",
    private readonly browserAdapter?: BrowserDriverAdapter
  ) {}

  public async executeHTTPStep(
    config: HTTPDriverConfig
  ): Promise<{ success: boolean; status: number; body: unknown; log: string; correlationId: string }> {
    const fullUrl = new URL(config.url, this.baseApiUrl).toString();
    const correlationId = config.correlationId || crypto.randomUUID();
    logger.info({ method: config.method, url: fullUrl, correlationId }, "Executing HTTP workflow step");

    const startedAt = Date.now();
    try {
      const { body: requestBody, headers } = encodeRequestBody(config);
      const response = await fetch(fullUrl, {
        method: config.method,
        headers: {
          "x-opspilot-correlation-id": correlationId,
          ...headers
        },
        body: requestBody,
        signal: AbortSignal.timeout(config.timeoutMs || 30_000)
      });
      const text = await response.text();
      let responseBody: unknown = text;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        // Preserve non-JSON response text as evidence.
      }

      const success = config.expectedStatus === undefined
        ? response.ok
        : response.status === config.expectedStatus;
      return {
        success,
        status: response.status,
        body: responseBody,
        correlationId,
        log: `HTTP ${config.method} ${fullUrl} returned ${response.status} in ${Date.now() - startedAt}ms [correlationId=${correlationId}]`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        status: 0,
        body: null,
        correlationId,
        log: `HTTP ${config.method} ${fullUrl} failed in ${Date.now() - startedAt}ms: ${message} [correlationId=${correlationId}]`
      };
    }
  }

  public async executeBrowserStep(
    config: BrowserDriverConfig
  ): Promise<{ success: boolean; log: string; correlationId: string }> {
    const correlationId = config.correlationId || crypto.randomUUID();

    if (this.browserAdapter) {
      const result = await this.browserAdapter.execute(config, correlationId);
      return { ...result, correlationId };
    }

    logger.info({ config, correlationId }, "Executing Playwright browser action");

    try {
      const session = await this.getBrowserSession(config.sessionId || "default", correlationId);
      const { page, consoleErrors, failedRequests } = session;
      const errorOffset = consoleErrors.length;
      const requestOffset = failedRequests.length;
      page.setDefaultTimeout(config.timeoutMs || 15_000);

      let logMessage = "";
      let success = false;

      if (config.action === "navigate") {
        if (!config.url) throw new Error("URL is required for navigate action");
        const targetUrl = new URL(config.url, this.baseApiUrl).toString();
        const res = await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        success = (res?.status() || 500) < 400;
        logMessage = `Navigated to ${targetUrl} with status ${res?.status()}`;
      } else if (config.action === "click") {
        if (!config.selector) throw new Error("Selector is required for click action");
        await page.click(config.selector);
        success = true;
        logMessage = `Clicked element matching selector ${config.selector}`;
      } else if (config.action === "fill") {
        if (!config.selector || config.text === undefined) throw new Error("Selector and text are required for fill action");
        await page.fill(config.selector, config.text);
        success = true;
        logMessage = `Filled selector ${config.selector} with ${config.text}`;
      } else if (config.action === "assert_visible") {
        if (!config.selector) throw new Error("Selector is required for assert_visible action");
        success = await page.isVisible(config.selector);
        logMessage = `Asserted visibility of selector ${config.selector} -> ${success}`;
      }

      const newConsoleErrors = consoleErrors.slice(errorOffset);
      const newFailedRequests = failedRequests.slice(requestOffset);
      if (newConsoleErrors.length > 0) {
        logMessage += `\n${newConsoleErrors.join("\n")}`;
      }
      if (newFailedRequests.length > 0) {
        logMessage += `\n${newFailedRequests.join("\n")}`;
        success = false;
      }

      if (config.screenshotPath || !success) {
        const screenshotFile = config.screenshotPath || path.join(process.cwd(), `screenshot-${correlationId}.png`);
        fs.mkdirSync(path.dirname(screenshotFile), { recursive: true });
        await page.screenshot({ path: screenshotFile });
        logMessage += `\nScreenshot saved: ${screenshotFile}`;
      }

      return {
        success: success && newConsoleErrors.length === 0,
        log: `${logMessage} [correlationId=${correlationId}]`,
        correlationId
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        log: `Playwright browser execution failed: ${msg} [correlationId=${correlationId}]`,
        correlationId
      };
    }
  }

  public async executeWebSocketStep(
    config: WebSocketDriverConfig
  ): Promise<{ success: boolean; log: string; correlationId: string }> {
    const correlationId = config.correlationId || crypto.randomUUID();
    logger.info({ config, correlationId }, "Executing WebSocket step");

    const isNativeWs = config.url.startsWith("ws://") || config.url.startsWith("wss://");

    try {
      if (isNativeWs) {
        let socket = this.activeWsConnections.get(config.url);
        if (!socket) {
          socket = new WebSocket(config.url);
          await new Promise<void>((resolve, reject) => {
            const onOpen = () => {
              socket.removeEventListener("open", onOpen);
              socket.removeEventListener("error", onError);
              resolve();
            };
            const onError = (err: any) => {
              socket.removeEventListener("open", onOpen);
              socket.removeEventListener("error", onError);
              reject(new Error(err.message || "Native WebSocket connection failed"));
            };
            socket.addEventListener("open", onOpen);
            socket.addEventListener("error", onError);
          });
          this.activeWsConnections.set(config.url, socket);
        }

        return new Promise((resolve) => {
          let settled = false;
          const finish = (result: { success: boolean; log: string; correlationId: string }) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          const timeoutMs = config.timeoutMs || 10_000;

          if (config.action === "emit") {
            const payloadStr = typeof config.payload === "string" ? config.payload : JSON.stringify(config.payload || {});
            socket.send(payloadStr);
            finish({
              success: true,
              log: `Sent native WebSocket payload on event/url ${config.event}: ${payloadStr} [correlationId=${correlationId}]`,
              correlationId
            });
          } else if (config.action === "listen") {
            let received = false;
            const handler = (event: any) => {
              const dataStr = typeof event.data === "string" ? event.data : String(event.data);
              let parsed: any;
              try {
                parsed = JSON.parse(dataStr);
              } catch {
                parsed = dataStr;
              }

              let matches = false;
              if (!config.event) {
                matches = true;
              } else if (typeof parsed === "object" && parsed !== null) {
                matches = parsed.event === config.event || parsed.type === config.event;
              } else {
                matches = parsed === config.event;
              }

              if (matches) {
                received = true;
                socket.removeEventListener("message", handler);
                finish({
                  success: true,
                  log: `Received native WebSocket matched message: ${dataStr} [correlationId=${correlationId}]`,
                  correlationId
                });
              }
            };
            socket.addEventListener("message", handler);

            setTimeout(() => {
              if (!received) {
                socket.removeEventListener("message", handler);
                finish({
                  success: false,
                  log: `Timeout waiting for native WebSocket event ${config.event || "any"} [correlationId=${correlationId}]`,
                  correlationId
                });
              }
            }, timeoutMs);
          } else if (config.action === "join_room") {
            const joinPayload = JSON.stringify({ event: "join", room: config.room });
            socket.send(joinPayload);
            finish({
              success: true,
              log: `Sent room join request: ${joinPayload} [correlationId=${correlationId}]`,
              correlationId
            });
          }
        });
      } else {
        const { io } = await import("socket.io-client");

        const connKey = `${config.url}#${config.namespace || ""}`;
        let socket = this.activeWsConnections.get(connKey);

        if (!socket) {
          const nspUrl = config.namespace ? `${config.url}/${config.namespace}` : config.url;
          socket = io(nspUrl, {
            auth: config.auth || {},
            extraHeaders: {
              "x-opspilot-correlation-id": correlationId
            },
            transports: ["websocket"],
            autoConnect: false
          });
          socket.connect();
          this.activeWsConnections.set(connKey, socket);
        }

        return new Promise((resolve) => {
          let settled = false;
          const finish = (result: { success: boolean; log: string; correlationId: string }) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          const timeoutMs = config.timeoutMs || 10_000;
          if (config.action === "emit") {
            socket.emit(config.event, config.payload, (ack: any) => {
              finish({
                success: true,
                log: `Emitted WebSocket event ${config.event} with ack response: ${JSON.stringify(ack)} [correlationId=${correlationId}]`,
                correlationId
              });
            });
            setTimeout(() => {
              const requireAck = config.requireAcknowledgement !== false;
              finish({
                success: !requireAck,
                log: requireAck
                  ? `Timed out waiting for acknowledgement of WebSocket event ${config.event} [correlationId=${correlationId}]`
                  : `Emitted WebSocket event ${config.event} without requiring acknowledgement [correlationId=${correlationId}]`,
                correlationId
              });
            }, timeoutMs);
          } else if (config.action === "listen") {
            let received = false;
            const handler = (data: any) => {
              received = true;
              socket.off(config.event, handler);
              finish({
                success: true,
                log: `Received WebSocket event ${config.event} with payload: ${JSON.stringify(data)} [correlationId=${correlationId}]`,
                correlationId
              });
            };
            socket.on(config.event, handler);

            setTimeout(() => {
              if (!received) {
                socket.off(config.event, handler);
                finish({
                  success: false,
                  log: `Timeout waiting for WebSocket event ${config.event} [correlationId=${correlationId}]`,
                  correlationId
                });
              }
            }, timeoutMs);
          } else if (config.action === "join_room") {
            socket.emit("join", config.room, (ack: any) => finish({
              success: true,
              log: `Joined WebSocket room ${config.room} with acknowledgement: ${JSON.stringify(ack)} [correlationId=${correlationId}]`,
              correlationId
            }));
            setTimeout(() => finish({
              success: false,
              log: `Timed out waiting for room acknowledgement: ${config.room} [correlationId=${correlationId}]`,
              correlationId
            }), timeoutMs);
          }
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        log: `WebSocket operation failed: ${msg} [correlationId=${correlationId}]`,
        correlationId
      };
    }
  }

  public async executeWebhookStep(
    config: WebhookDriverConfig
  ): Promise<{ success: boolean; log: string; correlationId: string }> {
    const correlationId = config.correlationId || crypto.randomUUID();
    logger.info({ type: config.type, provider: config.provider, correlationId }, "Executing webhook operation");

    if (config.type === "incoming") {
      if (!config.endpointUrl) {
        return { success: false, log: "Missing endpointUrl for incoming webhook simulation", correlationId };
      }
      if (!config.secret) {
        return {
          success: false,
          log: `Missing signing secret for ${config.provider || "custom"} webhook simulation`,
          correlationId
        };
      }
      try {
        const rawBody = JSON.stringify(config.payload || {});
        const signature = this.generateWebhookSignature(
          config.provider || "custom",
          rawBody,
          config.secret
        );
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-opspilot-correlation-id": correlationId
        };

        if (config.provider === "stripe") {
          headers["stripe-signature"] = signature;
        } else if (config.provider === "razorpay") {
          headers["x-razorpay-signature"] = signature;
        } else if (config.provider === "github") {
          headers["x-hub-signature-256"] = signature;
        } else {
          headers["x-webhook-signature"] = signature;
        }

        const res = await fetch(config.endpointUrl, {
          method: "POST",
          headers,
          body: rawBody,
          signal: AbortSignal.timeout(config.timeoutMs || 10000)
        });

        return {
          success: res.ok,
          log: `Simulated incoming ${config.provider} webhook POST ${config.endpointUrl} -> Status ${res.status} [correlationId=${correlationId}]`,
          correlationId
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, log: `Incoming webhook simulation failed: ${msg}`, correlationId };
      }
    } else {
      // Outgoing webhook server bootstrap
      const port = config.port || 4099;
      if (this.activeWebhookServers.has(port)) {
        return {
          success: true,
          log: `Outgoing webhook receiver already running on port ${port} [correlationId=${correlationId}]`,
          correlationId
        };
      }

      return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          let body = "";
          req.on("data", chunk => { body += chunk; });
          req.on("end", () => {
            const receivedHeaders = req.headers;
            logger.info({ receivedHeaders, body }, "Outgoing webhook receiver captured request");
            const captures = this.capturedWebhooks.get(port) || [];
            captures.push({
              timestamp: new Date().toISOString(),
              method: req.method,
              url: req.url,
              headers: receivedHeaders,
              body
            });
            this.capturedWebhooks.set(port, captures.slice(-100));

            setTimeout(() => {
              res.writeHead(config.responseStatus || 200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(config.responseBody || { success: true }));
            }, config.responseDelayMs || 0);
          });
        });

        server.listen(port, () => {
          this.activeWebhookServers.set(port, server);
          logger.info({ port }, "Started webhook receiver server");

          resolve({
            success: true,
            log: `Successfully started outgoing webhook receiver server on port ${port} [correlationId=${correlationId}]`,
            correlationId
          });
        });

        server.on("error", (error) => {
          resolve({
            success: false,
            log: `Webhook receiver server failed to start: ${error.message}`,
            correlationId
          });
        });
      });
    }
  }

  private generateWebhookSignature(provider: string, rawBody: string, secret: string): string {
    if (provider === "stripe") {
      const timestamp = Math.floor(Date.now() / 1000);
      const hmac = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      return `t=${timestamp},v1=${hmac}`;
    }
    const hmac = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (provider === "github") {
      return `sha256=${hmac}`;
    }
    return hmac;
  }

  public async closeAll() {
    for (const [key, socket] of this.activeWsConnections.entries()) {
      if (typeof socket.disconnect === "function") {
        socket.disconnect();
      } else if (typeof socket.close === "function") {
        socket.close();
      }
      this.activeWsConnections.delete(key);
    }
    for (const [port, server] of this.activeWebhookServers.entries()) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.activeWebhookServers.delete(port);
    }
    for (const [sessionId, session] of this.browserSessions.entries()) {
      await session.browser.close().catch(() => undefined);
      this.browserSessions.delete(sessionId);
    }
  }

  public getCapturedWebhooks(port = 4099) {
    return [...(this.capturedWebhooks.get(port) || [])];
  }

  private async getBrowserSession(sessionId: string, correlationId: string) {
    const existing = this.browserSessions.get(sessionId);
    if (existing) return existing;
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    await page.route("**/*", async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-opspilot-correlation-id": correlationId
        }
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`Console error: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(
        `Failed request: ${request.method()} ${request.url()} (${request.failure()?.errorText || "unknown"})`
      );
    });
    const session = { browser, context, page, consoleErrors, failedRequests };
    this.browserSessions.set(sessionId, session);
    return session;
  }
}

function encodeRequestBody(config: HTTPDriverConfig): {
  body?: BodyInit;
  headers: Record<string, string>;
} {
  const headers = { ...(config.headers || {}) };
  if (config.payload === undefined || ["GET", "HEAD"].includes(config.method.toUpperCase())) {
    return { headers };
  }

  const encoding = config.bodyEncoding || "json";
  if (encoding === "raw") {
    return {
      body: typeof config.payload === "string" ? config.payload : String(config.payload),
      headers
    };
  }

  if (encoding === "form") {
    if (!hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(asRecord(config.payload))) {
      if (value !== undefined && value !== null) values.append(key, String(value));
    }
    return { body: values, headers };
  }

  if (encoding === "multipart") {
    const form = new FormData();
    for (const [key, value] of Object.entries(asRecord(config.payload))) {
      if (value === undefined || value === null) continue;
      if (isGeneratedFile(value)) {
        form.append(
          key,
          new Blob([value.content], { type: value.contentType || "application/octet-stream" }),
          value.filename
        );
      } else if (Array.isArray(value)) {
        value.forEach((item) => form.append(key, String(item)));
      } else if (typeof value === "object") {
        form.append(key, JSON.stringify(value));
      } else {
        form.append(key, String(value));
      }
    }
    return { body: form, headers };
  }

  if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  return { body: JSON.stringify(config.payload), headers };
}

function hasHeader(headers: Record<string, string>, expected: string): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === expected);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isGeneratedFile(value: unknown): value is {
  filename: string;
  content: string;
  contentType?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.filename === "string" && typeof candidate.content === "string";
}
