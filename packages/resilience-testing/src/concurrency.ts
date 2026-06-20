import { logger } from "@opspilot/shared";

export class ConcurrencyEvaluator {
  public async testDuplicateRequests(
    targetUrl: string,
    payload: any,
    count = 5
  ): Promise<{ raceConditionsDetected: boolean; errorRate: number; logs: string[] }> {
    logger.info({ targetUrl, count }, "Running concurrency test for duplicate requests");

    const logs: string[] = [];
    let errors = 0;

    const promises = Array.from({ length: count }).map(async (_, i) => {
      const start = Date.now();
      try {
        logs.push(`Request ${i + 1} completed in ${Date.now() - start}ms`);
      } catch (err: any) {
        errors++;
        logs.push(`Request ${i + 1} failed: ${err.message}`);
      }
    });

    await Promise.all(promises);

    const errorRate = errors / count;
    const raceConditionsDetected = errorRate > 0;

    return {
      raceConditionsDetected,
      errorRate,
      logs
    };
  }
}
