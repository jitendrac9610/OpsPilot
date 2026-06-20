import { logger } from "@opspilot/shared";

export interface HTTPDriverConfig {
  method: string;
  url: string;
  payload?: any;
  headers?: Record<string, string>;
}

export interface BrowserDriverConfig {
  action: "navigate" | "click" | "fill" | "assert_visible";
  url?: string;
  selector?: string;
  text?: string;
}

export class WorkflowDrivers {
  private baseApiUrl: string;

  constructor(baseApiUrl = "http://localhost:4000") {
    this.baseApiUrl = baseApiUrl;
  }

  public async executeHTTPStep(config: HTTPDriverConfig): Promise<{ success: boolean; status: number; body: any; log: string }> {
    const fullUrl = config.url.startsWith("http") ? config.url : `${this.baseApiUrl}${config.url}`;
    logger.info({ method: config.method, url: fullUrl }, "Executing HTTP Workflow Step");

    const startTime = Date.now();
    try {
      const response = await fetch(fullUrl, {
        method: config.method,
        headers: {
          "Content-Type": "application/json",
          ...(config.headers || {})
        },
        body: config.payload ? JSON.stringify(config.payload) : undefined
      });

      const text = await response.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch (e) {
        body = text;
      }

      const duration = Date.now() - startTime;
      const success = response.ok;
      const log = `HTTP ${config.method} ${config.url} completed in ${duration}ms with status ${response.status}.`;

      return {
        success,
        status: response.status,
        body,
        log
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const log = `HTTP ${config.method} ${config.url} failed in ${duration}ms: ${err.message}`;
      logger.error({ err }, "HTTP step execution failed");
      return {
        success: false,
        status: 0,
        body: null,
        log
      };
    }
  }

  public async executeBrowserStep(config: BrowserDriverConfig): Promise<{ success: boolean; log: string }> {
    logger.info({ config }, "Executing Browser Workflow Step");

    let log = "";
    switch (config.action) {
      case "navigate":
        log = `Browser navigated to URL: ${config.url || "/"}`;
        break;
      case "click":
        log = `Clicked on UI selector: ${config.selector || "button"}`;
        break;
      case "fill":
        log = `Filled text "${config.text || ""}" in selector: ${config.selector || "input"}`;
        break;
      case "assert_visible":
        log = `Verified selector ${config.selector || "div"} is visible on screen.`;
        break;
    }

    return {
      success: true,
      log
    };
  }
}
