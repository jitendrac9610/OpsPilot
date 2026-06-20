import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner } from "./containerRunner.js";
import { ExecutionManifest } from "./executionManifest.js";

export interface BuildResult {
  success: boolean;
  command: string[];
  exitCode: number | null;
  durationMs: number;
  log: string;
}

export class BuildRunner {
  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner()
  ) {}

  public async build(
    sandboxId: string,
    workspaceDir: string,
    manifest: ExecutionManifest,
    network?: string,
    environment: Record<string, string> = {}
  ): Promise<BuildResult> {
    if (!manifest.buildCommand) {
      return this.persist(sandboxId, {
        success: true,
        command: [],
        exitCode: 0,
        durationMs: 0,
        log: "BUILD_COMMAND_NOT_CONFIGURED: No build script was discovered; build stage skipped."
      });
    }

    const startedAt = Date.now();
    const result = await this.runner.run({
      sandboxId,
      workspaceDir,
      command: manifest.buildCommand,
      network,
      environment
    });
    const buildResult: BuildResult = {
      success: result.success,
      command: manifest.buildCommand,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      log: result.log
    };

    return this.persist(sandboxId, buildResult);
  }

  private async persist(sandboxId: string, buildResult: BuildResult): Promise<BuildResult> {
    if (!this.dbFallback) {
      try {
        await prisma.buildRun.create({
          data: {
            sandboxId,
            success: buildResult.success,
            command: buildResult.command.join(" "),
            exitCode: buildResult.exitCode,
            durationMs: buildResult.durationMs,
            log: buildResult.log
          }
        });
      } catch (error) {
        logger.warn({ error }, "Failed to persist application build result");
      }
    }
    return buildResult;
  }
}
