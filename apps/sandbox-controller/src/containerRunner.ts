import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, logger } from "@opspilot/shared";

export interface ContainerRunOptions {
  sandboxId: string;
  workspaceDir: string;
  command: string[];
  allowNetwork?: boolean;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export interface ContainerRunResult {
  success: boolean;
  exitCode: number | null;
  log: string;
  timedOut: boolean;
}

export class ContainerRunner {
  public async run(options: ContainerRunOptions): Promise<ContainerRunResult> {
    this.validateCommand(options.command);
    const containerName = this.containerName(options.sandboxId, "run");
    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--init",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(config.sandbox.pidLimit),
      "--memory", config.sandbox.memoryLimit,
      "--cpus", config.sandbox.cpuLimit,
      "--user", "1000:1000",
      "--workdir", "/workspace",
      "--mount", `type=bind,source=${path.resolve(options.workspaceDir)},target=/workspace`,
      "--network", options.allowNetwork ? "bridge" : "none",
      ...this.environmentArgs(options.environment),
      config.sandbox.image,
      ...options.command
    ];

    const result = await this.executeDocker(args, options.timeoutMs);
    if (result.timedOut) await this.forceRemove(containerName);
    return result;
  }

  public async startDetached(options: ContainerRunOptions & { ports?: number[] }): Promise<ContainerRunResult & { containerId?: string }> {
    this.validateCommand(options.command);
    const containerName = this.containerName(options.sandboxId, options.command[0]);
    const portArgs = (options.ports || []).flatMap((port) => ["--publish", `${port}:${port}`]);
    const args = [
      "run",
      "--detach",
      "--rm",
      "--name", containerName,
      "--init",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(config.sandbox.pidLimit),
      "--memory", config.sandbox.memoryLimit,
      "--cpus", config.sandbox.cpuLimit,
      "--user", "1000:1000",
      "--workdir", "/workspace",
      "--mount", `type=bind,source=${path.resolve(options.workspaceDir)},target=/workspace`,
      "--network", options.allowNetwork ? "bridge" : "none",
      ...portArgs,
      ...this.environmentArgs(options.environment),
      config.sandbox.image,
      ...options.command
    ];
    const result = await this.executeDocker(args, options.timeoutMs || 30_000);
    return {
      ...result,
      containerId: result.success ? result.log.trim().split(/\s/)[0] : undefined
    };
  }

  public async stop(containerId: string): Promise<void> {
    await this.executeDocker(["stop", "--time", "5", containerId], 15_000);
  }

  private validateCommand(command: string[]) {
    if (command.length === 0 || command.some((part) => typeof part !== "string" || part.includes("\0"))) {
      throw new Error("A non-empty validated command array is required.");
    }
  }

  private environmentArgs(environment: Record<string, string> = {}): string[] {
    return Object.entries(environment).flatMap(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || value.includes("\0")) {
        throw new Error(`Invalid sandbox environment variable ${key}.`);
      }
      return ["--env", `${key}=${value}`];
    });
  }

  private containerName(sandboxId: string, suffix: string): string {
    const clean = `${sandboxId}-${suffix}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 50);
    return `${clean}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private async forceRemove(containerName: string) {
    await this.executeDocker(["rm", "--force", containerName], 15_000).catch(() => undefined);
  }

  private executeDocker(args: string[], timeoutMs = config.sandbox.commandTimeoutMs): Promise<ContainerRunResult> {
    logger.info({ args: args.slice(0, 12) }, "Executing isolated Docker command");
    return new Promise((resolve) => {
      let log = "";
      let timedOut = false;
      let settled = false;
      const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      const append = (chunk: Buffer) => {
        if (log.length >= config.sandbox.maxLogBytes) return;
        log += chunk.toString("utf8").slice(0, config.sandbox.maxLogBytes - log.length);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const finish = (exitCode: number | null, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (message) append(Buffer.from(message));
        resolve({ success: exitCode === 0 && !timedOut, exitCode, log, timedOut });
      };

      child.on("error", (error) => {
        const message = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "CONTAINER_RUNTIME_UNAVAILABLE: Docker executable was not found."
          : `CONTAINER_RUNTIME_ERROR: ${error.message}`;
        finish(null, message);
      });
      child.on("close", (code) => finish(code));
    });
  }
}
