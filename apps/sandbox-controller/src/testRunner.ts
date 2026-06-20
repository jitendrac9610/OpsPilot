import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner } from "./containerRunner.js";
import { ExecutionManifest } from "./executionManifest.js";

export class TestRunner {
  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner()
  ) {}

  public async runTests(
    sandboxId: string,
    workspaceDir: string,
    type: "unit" | "integration" | "e2e",
    manifest: ExecutionManifest
  ): Promise<{ success: boolean; log: string; exitCode: number | null }> {
    const test = manifest.testCommands.find((candidate) => candidate.type === type);
    if (!test) {
      return this.persist(sandboxId, type, {
        success: false,
        exitCode: null,
        log: `TEST_COMMAND_NOT_CONFIGURED: No ${type} test command was discovered in package.json.`
      });
    }

    logger.info({ sandboxId, workspaceDir, type, command: test.command }, "Running discovered test command");
    const result = await this.runner.run({
      sandboxId,
      workspaceDir,
      command: test.command,
      allowNetwork: false
    });

    return this.persist(sandboxId, type, {
      success: result.success,
      exitCode: result.exitCode,
      log: result.log
    });
  }

  private async persist(
    sandboxId: string,
    type: string,
    result: { success: boolean; log: string; exitCode: number | null }
  ) {
    if (!this.dbFallback) {
      try {
        await prisma.testRun.create({
          data: {
            sandboxId,
            type,
            success: result.success,
            log: result.log
          }
        });
      } catch (error) {
        logger.warn({ error }, "Failed to persist TestRun");
      }
    }
    return result;
  }
}
