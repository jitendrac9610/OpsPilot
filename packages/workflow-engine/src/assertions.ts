import { logger } from "@opspilot/shared";

export interface DBAssertionConfig {
  query: string;
}

export interface QueueAssertionConfig {
  event: string;
}

export interface SDKAssertionConfig {
  sdk: "Clerk" | "GetStream" | "Stripe";
  action: string;
}

export interface AssertionAdapters {
  database?: (config: DBAssertionConfig) => Promise<{ success: boolean; log: string }>;
  queue?: (config: QueueAssertionConfig) => Promise<{ success: boolean; log: string }>;
  sdk?: (config: SDKAssertionConfig) => Promise<{ success: boolean; log: string }>;
}

export class AssertionEngine {
  constructor(private readonly adapters: AssertionAdapters = {}) {}

  public async assertDBState(config: DBAssertionConfig): Promise<{ success: boolean; log: string }> {
    logger.info({ config }, "Evaluating database assertion");
    if (!this.adapters.database) {
      return { success: false, log: "DATABASE_ASSERTION_ADAPTER_NOT_CONFIGURED" };
    }
    return this.adapters.database(config);
  }

  public async assertQueueEvent(config: QueueAssertionConfig): Promise<{ success: boolean; log: string }> {
    logger.info({ config }, "Evaluating queue assertion");
    if (!this.adapters.queue) {
      return { success: false, log: "QUEUE_ASSERTION_ADAPTER_NOT_CONFIGURED" };
    }
    return this.adapters.queue(config);
  }

  public async assertSDKState(config: SDKAssertionConfig): Promise<{ success: boolean; log: string }> {
    logger.info({ config }, "Evaluating SDK assertion");
    if (!this.adapters.sdk) {
      return { success: false, log: "SDK_ASSERTION_ADAPTER_NOT_CONFIGURED" };
    }
    return this.adapters.sdk(config);
  }
}
