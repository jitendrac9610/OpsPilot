import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const services = [
  { name: "web", dir: "apps/web", cmd: "npx", args: ["next", "dev", "-p", "3000"] },
  { name: "control-api", dir: "apps/control-api", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "github-worker", dir: "apps/github-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "discovery-worker", dir: "apps/discovery-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "indexer-worker", dir: "apps/indexer-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "graph-worker", dir: "apps/graph-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "telemetry-api", dir: "apps/telemetry-api", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "incident-worker", dir: "apps/incident-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "sandbox-controller", dir: "apps/sandbox-controller", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "agent-worker", dir: "apps/agent-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] },
  { name: "evaluation-worker", dir: "apps/evaluation-worker", cmd: "npx", args: ["tsx", "watch", "src/index.ts"] }
];

const children = [];

console.log("🚀 Starting all OpsPilot AI services...");

services.forEach(service => {
  console.log(`[System] Starting ${service.name}...`);
  
  // Set NODE_ENV: 'development' for web, 'production' for workers
  const env = { 
    ...process.env, 
    NODE_ENV: service.name === "web" ? "development" : "production" 
  };
  
  const child = spawn(service.cmd, service.args, {
    cwd: path.resolve(__dirname, "..", service.dir),
    stdio: "pipe",
    env,
    shell: true
  });

  child.stdout.on("data", data => {
    const output = data.toString().trim();
    if (output) {
      console.log(`[${service.name}] ${output}`);
    }
  });

  child.stderr.on("data", data => {
    const output = data.toString().trim();
    if (output) {
      console.error(`[${service.name} ERR] ${output}`);
    }
  });

  child.on("close", code => {
    console.log(`[System] ${service.name} exited with code ${code}`);
  });

  children.push(child);
});

// Graceful cleanup on exit
function cleanup() {
  console.log("\n🛑 Stopping all OpsPilot AI services...");
  children.forEach(child => {
    child.kill("SIGINT");
  });
  setTimeout(() => process.exit(), 1000);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
