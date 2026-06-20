import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner } from "./containerRunner.js";
import { ExecutionManifest } from "./executionManifest.js";

export class DependencyResolver {
  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner()
  ) {}

  public async resolve(
    workspaceDir: string,
    sandboxId: string,
    manifest: ExecutionManifest
  ): Promise<{ success: boolean; log: string; exitCode: number | null }> {
    logger.info({ workspaceDir, sandboxId }, "Installing locked dependencies in isolated container");

    if (manifest.installCommand.length === 0) {
      return this.persist(sandboxId, {
        success: false,
        exitCode: null,
        log: "LOCKFILE_REQUIRED: A deterministic install command could not be discovered."
      });
    }

    const result = await this.runner.run({
      sandboxId,
      workspaceDir,
      command: manifest.installCommand,
      allowNetwork: true
    });
    return this.persist(sandboxId, {
      success: result.success,
      exitCode: result.exitCode,
      log: result.log
    });
  }

  private async persist(
    sandboxId: string,
    result: { success: boolean; log: string; exitCode: number | null }
  ) {
    if (!this.dbFallback) {
      try {
        await prisma.buildRun.create({
          data: {
            sandboxId,
            success: result.success,
            log: result.log
          }
        });
      } catch (error) {
        logger.warn({ error }, "Failed to persist dependency installation result");
      }
    }
    return result;
  }
}
