import crypto from "node:crypto";
import { logger } from "@opspilot/shared";

export interface HTTPDriverConfig {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  expectedStatus?: number;
  timeoutMs?: number;
}

export interface BrowserDriverConfig {
  action: "navigate" | "click" | "fill" | "assert_visible";
  url?: string;
  selector?: string;
  text?: string;
}

export interface BrowserDriverAdapter {
  execute(config: BrowserDriverConfig, correlationId: string): Promise<{ success: boolean; log: string }>;
}

export class WorkflowDrivers {
  constructor(
    private readonly baseApiUrl = "http://localhost:4000",
    private readonly browserAdapter?: BrowserDriverAdapter
  ) {}

  public async executeHTTPStep(
    config: HTTPDriverConfig
  ): Promise<{ success: boolean; status: number; body: unknown; log: string; correlationId: string }> {
    const fullUrl = new URL(config.url, this.baseApiUrl).toString();
    const correlationId = crypto.randomUUID();
    logger.info({ method: config.method, url: fullUrl, correlationId }, "Executing HTTP workflow step");

    const startedAt = Date.now();
    try {
      const response = await fetch(fullUrl, {
        method: config.method,
        headers: {
          "Content-Type": "application/json",
          "x-opspilot-correlation-id": correlationId,
          ...(config.headers || {})
        },
        body: config.payload === undefined ? undefined : JSON.stringify(config.payload),
        signal: AbortSignal.timeout(config.timeoutMs || 30_000)
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Preserve non-JSON response text as evidence.
      }

      const success = config.expectedStatus === undefined
        ? response.ok
        : response.status === config.expectedStatus;
      return {
        success,
        status: response.status,
        body,
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
    const correlationId = crypto.randomUUID();
    if (!this.browserAdapter) {
      return {
        success: false,
        correlationId,
        log: `BROWSER_DRIVER_NOT_CONFIGURED: A Playwright browser adapter is required. [correlationId=${correlationId}]`
      };
    }
    const result = await this.browserAdapter.execute(config, correlationId);
    return { ...result, correlationId };
  }
}
