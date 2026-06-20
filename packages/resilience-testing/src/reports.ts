import { logger } from "@opspilot/shared";
import { LoadMetrics } from "./load.js";

export interface ReportCompareData {
  baseline: LoadMetrics;
  underStress: LoadMetrics;
}

export class PerformanceReporter {
  public generateReport(sandboxId: string, data: ReportCompareData): string {
    logger.info({ sandboxId }, "Generating performance report");

    const throughputDropPercent = ((data.baseline.throughput - data.underStress.throughput) / data.baseline.throughput) * 100;
    const latencyIncreasePercent = ((data.underStress.latencyP95 - data.baseline.latencyP95) / data.baseline.latencyP95) * 100;

    const report = `
# OpsPilot Reliability Performance Report
Sandbox ID: ${sandboxId}
Timestamp: ${new Date().toISOString()}

## Summary Metrics
- **Baseline Throughput**: ${data.baseline.throughput.toFixed(2)} req/sec
- **Stressed Throughput**: ${data.underStress.throughput.toFixed(2)} req/sec
- **Throughput Drop**: ${throughputDropPercent.toFixed(2)}%

- **Baseline P95 Latency**: ${data.baseline.latencyP95.toFixed(2)} ms
- **Stressed P95 Latency**: ${data.underStress.latencyP95.toFixed(2)} ms
- **Latency Increase**: ${latencyIncreasePercent.toFixed(2)}%

- **Baseline Error Rate**: ${(data.baseline.errorRate * 100).toFixed(2)}%
- **Stressed Error Rate**: ${(data.underStress.errorRate * 100).toFixed(2)}%

## Assessment Conclusion
${data.underStress.errorRate > 0.05 ? "CRITICAL: High error rate detected under load/resilience injection!" : "HEALTHY: Environment holds resilience thresholds successfully."}
`;

    return report.trim();
  }
}
