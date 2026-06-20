import { logger } from "@opspilot/shared";
import { WorkflowDrivers } from "@opspilot/workflow-engine";

export class WorkflowReplayer {
  private drivers = new WorkflowDrivers();

  public async replay(
    workflowSteps: any[]
  ): Promise<{ success: boolean; logs: string[] }> {
    logger.info({ stepsCount: workflowSteps.length }, "Replaying original workflow steps against workspace");

    const logs: string[] = [];
    let success = true;

    for (const step of workflowSteps) {
      if (step.type === "HTTP") {
        const res = await this.drivers.executeHTTPStep(step.config);
        logs.push(res.log);
        if (!res.success) {
          success = false;
          break;
        }
      } else if (step.type === "BROWSER") {
        const res = await this.drivers.executeBrowserStep(step.config);
        logs.push(res.log);
        if (!res.success) {
          success = false;
          break;
        }
      }
    }

    return {
      success,
      logs
    };
  }
}
