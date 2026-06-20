import { exec } from "node:child_process";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import fs from "node:fs";
import path from "node:path";

export class TestRunner {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async runTests(
    sandboxId: string,
    workspaceDir: string,
    type: "unit" | "integration" | "e2e",
    command = "npm test"
  ): Promise<{ success: boolean; log: string }> {
    logger.info({ sandboxId, workspaceDir, type, command }, "Running test suite in sandbox");

    // Check if script exists in package.json
    let isNotConfigured = false;
    try {
      const pkgPath = path.join(workspaceDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (command.startsWith("npm run ")) {
          const scriptName = command.replace("npm run ", "").trim();
          if (!pkg.scripts || !pkg.scripts[scriptName]) {
            isNotConfigured = true;
          }
        } else if (command === "npm test") {
          // If "test" script is absent and there is no "test.js" fallback file, it's not configured
          if (!pkg.scripts || (!pkg.scripts.test && !fs.existsSync(path.join(workspaceDir, "test.js")))) {
            isNotConfigured = true;
          }
        }
      } else {
        isNotConfigured = true;
      }
    } catch (err) {
      logger.warn({ err, workspaceDir }, "Failed to read package.json scripts in test runner");
    }

    if (isNotConfigured) {
      logger.info({ command }, "Test command is not configured in package.json");
      const remediation = command === "npm run test:e2e" 
        ? "\n\nSuggested Setup Remediation:\nTo configure E2E testing in Next.js/JavaScript:\n1. Run: npm install -D playwright\n2. Add the script to package.json:\n   \"scripts\": {\n     \"test:e2e\": \"playwright test\"\n   }"
        : "\n\nSuggested Setup Remediation:\nTo configure unit testing:\n1. Add a test runner dependency (e.g. jest, vitest).\n2. Add the script to package.json:\n   \"scripts\": {\n     \"test\": \"vitest run\"\n   }";
      return { 
        success: false, 
        log: `NOT_CONFIGURED: The test script is not configured in package.json.\nCommand: ${command}${remediation}` 
      };
    }

    const result = await new Promise<{ success: boolean; log: string }>((resolve) => {
      exec(command, { cwd: workspaceDir }, (error, stdout, stderr) => {
        const log = stdout + "\n" + stderr;
        if (error) {
          logger.warn({ error, command }, "Test execution failed");
          resolve({ success: false, log });
        } else {
          logger.info({ command }, "Test execution completed successfully");
          resolve({ success: true, log });
        }
      });
    });

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
      } catch (err: any) {
        logger.warn({ err }, "Failed to write TestRun to database");
      }
    }

    return result;
  }
}
