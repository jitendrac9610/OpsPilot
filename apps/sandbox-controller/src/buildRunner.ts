import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner } from "./containerRunner.js";
import { ExecutionManifest } from "./executionManifest.js";

export interface BuildResult {
  success: boolean;
  command: string[];
  commands?: Array<{
    id: string;
    command: string[];
    workingDirectory: string;
    success: boolean;
    exitCode: number | null;
  }>;
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
    const commands = manifest.buildCommands?.length
      ? manifest.buildCommands
      : manifest.buildCommand
        ? [{ id: "build:root", command: manifest.buildCommand, workingDirectory: "." }]
        : [];
    if (commands.length === 0) {
      return this.persist(sandboxId, {
        success: true,
        command: [],
        exitCode: 0,
        durationMs: 0,
        log: "BUILD_COMMAND_NOT_CONFIGURED: No build script was discovered; build stage skipped."
      });
    }

    const startedAt = Date.now();
    const logs: string[] = [];
    const runs: NonNullable<BuildResult["commands"]> = [];
    let exitCode: number | null = 0;
    let success = true;
    for (const build of commands) {
      const result = await this.runner.run({
        sandboxId,
        workspaceDir,
        workingDirectory: build.workingDirectory,
        command: build.command,
        network,
        environment
      });
      logs.push(`[${build.id}]\n${result.log}`);
      runs.push({
        id: build.id,
        command: build.command,
        workingDirectory: build.workingDirectory,
        success: result.success,
        exitCode: result.exitCode
      });
      exitCode = result.exitCode;
      if (!result.success) {
        success = false;
        break;
      }
    }
    const buildResult: BuildResult = {
      success,
      command: commands[0].command,
      commands: runs,
      exitCode,
      durationMs: Date.now() - startedAt,
      log: logs.join("\n")
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
