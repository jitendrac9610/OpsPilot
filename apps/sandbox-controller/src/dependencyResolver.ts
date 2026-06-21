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
    manifest: ExecutionManifest,
    network?: string
  ): Promise<{ success: boolean; log: string; exitCode: number | null }> {
    logger.info({ workspaceDir, sandboxId }, "Installing locked dependencies in isolated container");

    const commands = manifest.installCommands?.length
      ? manifest.installCommands
      : manifest.installCommand.length > 0
        ? [{ id: "install:root", command: manifest.installCommand, workingDirectory: "." }]
        : [];
    if (commands.length === 0) {
      return this.persist(sandboxId, {
        success: false,
        exitCode: null,
        log: "LOCKFILE_REQUIRED: A deterministic install command could not be discovered."
      });
    }

    const logs: string[] = [];
    let exitCode: number | null = 0;
    let success = true;
    for (const install of commands) {
      const result = await this.runner.run({
        sandboxId,
        workspaceDir,
        workingDirectory: install.workingDirectory,
        command: install.command,
        allowNetwork: !network,
        network
      });
      logs.push(`[${install.id}]\n${result.log}`);
      exitCode = result.exitCode;
      if (!result.success) {
        success = false;
        break;
      }
    }
    return this.persist(sandboxId, {
      success,
      exitCode,
      log: logs.join("\n")
    });
  }

  private async persist(
    sandboxId: string,
    result: { success: boolean; log: string; exitCode: number | null }
  ) {
    return result;
  }
}
