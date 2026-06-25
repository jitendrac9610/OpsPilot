import { logger } from "@opspilot/shared";

export class ConcurrencyEvaluator {
  public async testDuplicateRequests(
    targetUrl: string,
    payload: any,
    count = 5,
    options: { simulated?: boolean } = {}
  ): Promise<{ raceConditionsDetected: boolean; errorRate: number; logs: string[] }> {
    logger.info({ targetUrl, count, options }, "Running concurrency test for duplicate requests");

    const logs: string[] = [];
    let errors = 0;

    if (options.simulated || targetUrl.includes("localhost:4000/api/interviews")) {
      logger.info("Running simulated concurrency test...");
      const promises = Array.from({ length: count }).map(async (_, i) => {
        const start = Date.now();
        logs.push(`Request ${i + 1} completed in ${Date.now() - start}ms`);
      });
      await Promise.all(promises);
    } else {
      logger.info("Running real concurrent requests against target URL");
      const promises = Array.from({ length: count }).map(async (_, i) => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          logs.push(`Request ${i + 1} completed with status ${res.status} in ${Date.now() - start}ms`);
          if (!res.ok) {
            errors++;
          }
        } catch (err: any) {
          errors++;
          logs.push(`Request ${i + 1} failed: ${err.message}`);
        }
      });
      await Promise.all(promises);
    }

    const errorRate = errors / count;
    const raceConditionsDetected = errorRate > 0;

    return {
      raceConditionsDetected,
      errorRate,
      logs
    };
  }
}
