import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, logger } from "@opspilot/shared";

export interface ContainerRunOptions {
  sandboxId: string;
  workspaceDir?: string;
  command: string[];
  allowNetwork?: boolean;
  network?: string;
  networkAliases?: string[];
  environment?: Record<string, string>;
  timeoutMs?: number;
  image?: string;
  user?: string | null;
}

export interface ContainerRunResult {
  success: boolean;
  exitCode: number | null;
  log: string;
  timedOut: boolean;
}

export interface PortBinding {
  containerPort: number;
  hostPort: number;
  internalUrl: string;
  externalUrl: string;
}

export class ContainerRunner {
  public async run(options: ContainerRunOptions): Promise<ContainerRunResult> {
    this.validateCommand(options.command);
    const containerName = this.containerName(options.sandboxId, "run");
    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--label", `opspilot.sandbox=${options.sandboxId}`,
      "--init",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(config.sandbox.pidLimit),
      "--memory", config.sandbox.memoryLimit,
      "--cpus", config.sandbox.cpuLimit,
      ...this.userArgs(options.user),
      ...this.workspaceArgs(options.workspaceDir),
      "--network", options.network || (options.allowNetwork ? "bridge" : "none"),
      ...this.environmentArgs(options.environment),
      options.image || config.sandbox.image,
      ...options.command
    ];

    const result = await this.executeDocker(args, options.timeoutMs);
    if (result.timedOut) await this.forceRemove(containerName);
    return result;
  }

  public async startDetached(
    options: ContainerRunOptions & { ports?: number[] }
  ): Promise<ContainerRunResult & { containerId?: string; portBindings: PortBinding[] }> {
    this.validateCommand(options.command);
    const containerName = this.containerName(options.sandboxId, options.command[0]);
    const portArgs = (options.ports || []).flatMap((port) => ["--publish", `127.0.0.1::${port}`]);
    const args = [
      "run",
      "--detach",
      "--rm",
      "--name", containerName,
      "--label", `opspilot.sandbox=${options.sandboxId}`,
      "--init",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(config.sandbox.pidLimit),
      "--memory", config.sandbox.memoryLimit,
      "--cpus", config.sandbox.cpuLimit,
      ...this.userArgs(options.user),
      ...this.workspaceArgs(options.workspaceDir),
      "--network", options.network || (options.allowNetwork ? "bridge" : "none"),
      ...(options.networkAliases || []).flatMap((alias) => ["--network-alias", alias]),
      ...portArgs,
      ...this.environmentArgs(options.environment),
      options.image || config.sandbox.image,
      ...options.command
    ];
    const result = await this.executeDocker(args, options.timeoutMs || 30_000);
    const containerId = result.success ? result.log.trim().split(/\s/)[0] : undefined;
    let portBindings: PortBinding[] = [];
    if (containerId) {
      try {
        portBindings = await Promise.all(
          (options.ports || []).map((port) =>
            this.inspectPort(containerId, port, options.networkAliases?.[0])
          )
        );
      } catch (error) {
        await this.stop(containerId).catch(() => undefined);
        return {
          ...result,
          success: false,
          log: `${result.log}\n${error instanceof Error ? error.message : String(error)}`,
          containerId: undefined,
          portBindings: []
        };
      }
    }
    return {
      ...result,
      containerId,
      portBindings
    };
  }

  public async createNetwork(sandboxId: string): Promise<string> {
    const networkName = this.networkName(sandboxId);
    const result = await this.executeDocker(
      ["network", "create", "--driver", "bridge", "--label", `opspilot.sandbox=${sandboxId}`, networkName],
      15_000
    );
    if (!result.success) {
      throw new Error(`SANDBOX_NETWORK_CREATE_FAILED: ${result.log}`);
    }
    return networkName;
  }

  public async removeNetwork(networkName: string): Promise<void> {
    await this.executeDocker(["network", "rm", networkName], 15_000);
  }

  public async cleanupSandboxResources(sandboxId: string): Promise<void> {
    const listed = await this.executeDocker(
      ["ps", "--all", "--quiet", "--filter", `label=opspilot.sandbox=${sandboxId}`],
      15_000
    );
    const containerIds = listed.success ? listed.log.trim().split(/\s+/).filter(Boolean) : [];
    await Promise.all(containerIds.map((containerId) => this.stop(containerId).catch(() => undefined)));
    await this.removeNetwork(this.networkName(sandboxId)).catch(() => undefined);
  }

  public async exec(containerId: string, command: string[], timeoutMs = 10_000): Promise<ContainerRunResult> {
    this.validateCommand(command);
    return this.executeDocker(["exec", containerId, ...command], timeoutMs);
  }

  public async logs(containerId: string): Promise<ContainerRunResult> {
    return this.executeDocker(["logs", "--tail", "200", containerId], 10_000);
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

  private workspaceArgs(workspaceDir?: string): string[] {
    if (!workspaceDir) return [];
    return [
      "--workdir", "/workspace",
      "--mount", `type=bind,source=${path.resolve(workspaceDir)},target=/workspace`
    ];
  }

  private userArgs(user: string | null | undefined): string[] {
    if (user === null) return [];
    return ["--user", user || "1000:1000"];
  }

  private containerName(sandboxId: string, suffix: string): string {
    const clean = `${sandboxId}-${suffix}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 50);
    return `${clean}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private networkName(sandboxId: string): string {
    return `opspilot-${sandboxId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 63);
  }

  private async inspectPort(containerId: string, containerPort: number, alias = "application"): Promise<PortBinding> {
    const result = await this.executeDocker(["port", containerId, `${containerPort}/tcp`], 10_000);
    if (!result.success) {
      throw new Error(`SANDBOX_PORT_INSPECTION_FAILED: ${result.log}`);
    }
    const firstBinding = result.log.trim().split(/\r?\n/)[0] || "";
    const match = firstBinding.match(/:(\d+)\s*$/);
    if (!match) {
      throw new Error(`SANDBOX_PORT_INSPECTION_FAILED: Unexpected Docker port output "${firstBinding}".`);
    }
    const hostPort = Number(match[1]);
    return {
      containerPort,
      hostPort,
      internalUrl: `http://${alias}:${containerPort}`,
      externalUrl: `http://127.0.0.1:${hostPort}`
    };
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
