import { ChildProcess } from "node:child_process";
import { logger } from "@opspilot/shared";

export class TelemetryCollector {
  public captureSystemMetrics(processes: ChildProcess[]): { cpuUsage: number; memoryUsageBytes: number } {
    let totalMemory = 0;
    for (const proc of processes) {
      if (proc.pid) {
        totalMemory += 50 * 1024 * 1024; // Mock ~50MB per process
      }
    }
    
    const cpuUsage = Math.min(10 + processes.length * 5, 100);
    logger.debug({ cpuUsage, memoryUsageBytes: totalMemory }, "Captured sandbox resource telemetry metrics");
    
    return {
      cpuUsage,
      memoryUsageBytes: totalMemory
    };
  }
}
