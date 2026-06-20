import fs from "fs";
import path from "path";
import { ExtractedSymbol } from "./parser.js";

export interface GraphNodeData {
  id: string;
  type: string;
  name: string;
  metadata: any;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  evidence: {
    file: string;
    line: number;
    description: string;
  };
}

export interface GraphBuildResult {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

export function buildArchitectureGraph(
  projectRoot: string,
  snapshotId: string,
  files: Array<{ relativePath: string; language: string; symbols: ExtractedSymbol[] }>
): GraphBuildResult {
  const nodes: GraphNodeData[] = [];
  const edges: GraphEdgeData[] = [];
  const nodeIds = new Set<string>();

  const addNode = (node: GraphNodeData) => {
    if (!nodeIds.has(node.id)) {
      nodes.push(node);
      nodeIds.add(node.id);
    }
  };

  const addEdge = (edge: GraphEdgeData) => {
    if (!edge.id) {
      edge.id = `${edge.source}-${edge.target}-${edge.type}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    }
    edges.push(edge);
  };

  // 1. Root Application node
  const rootName = path.basename(projectRoot);
  const rootAppId = `app_${rootName}`;
  addNode({
    id: rootAppId,
    type: "application",
    name: rootName,
    metadata: { projectRoot, snapshotId }
  });

  // 2. Discover workspaces & services
  const services: { name: string; path: string; id: string }[] = [];
  const packages: { name: string; path: string; id: string }[] = [];
  
  // Look for services in apps/ or packages/ or root
  const appsDir = path.join(projectRoot, "apps");
  if (fs.existsSync(appsDir)) {
    try {
      const dirs = fs.readdirSync(appsDir);
      for (const dir of dirs) {
        const fullPath = path.join(appsDir, dir);
        if (fs.statSync(fullPath).isDirectory()) {
          const serviceId = `svc_${dir}`;
          services.push({ name: dir, path: path.join("apps", dir), id: serviceId });
          addNode({
            id: serviceId,
            type: "service",
            name: dir,
            metadata: { relativePath: path.join("apps", dir), techStack: {} }
          });
          addEdge({
            id: `app-to-svc-${dir}`,
            source: rootAppId,
            target: serviceId,
            type: "DEPENDS_ON",
            evidence: { file: "package.json", line: 1, description: "Monorepo application service" }
          });
        }
      }
    } catch {}
  }

  // Look for packages in packages/
  const pkgsDir = path.join(projectRoot, "packages");
  if (fs.existsSync(pkgsDir)) {
    try {
      const dirs = fs.readdirSync(pkgsDir);
      for (const dir of dirs) {
        const fullPath = path.join(pkgsDir, dir);
        if (fs.statSync(fullPath).isDirectory()) {
          const pkgId = `pkg_${dir}`;
          packages.push({ name: dir, path: path.join("packages", dir), id: pkgId });
          addNode({
            id: pkgId,
            type: "package",
            name: dir,
            metadata: { relativePath: path.join("packages", dir) }
          });
          addEdge({
            id: `app-to-pkg-${dir}`,
            source: rootAppId,
            target: pkgId,
            type: "DEPENDS_ON",
            evidence: { file: "package.json", line: 1, description: "Monorepo package dependency" }
          });
        }
      }
    } catch {}
  }

  // Fallback: If no services, treat root as the sole service
  if (services.length === 0) {
    const serviceId = `svc_${rootName}`;
    services.push({ name: rootName, path: "", id: serviceId });
    addNode({
      id: serviceId,
      type: "service",
      name: rootName,
      metadata: { relativePath: "", techStack: {} }
    });
  }

  // 3. Scan for infrastructure (docker-compose.yml)
  const composePath = path.join(projectRoot, "docker-compose.yml");
  if (fs.existsSync(composePath)) {
    try {
      const content = fs.readFileSync(composePath, "utf-8");
      // Basic YAML parsing for services
      const servicesSection = content.split("services:");
      if (servicesSection.length > 1) {
        const lines = servicesSection[1].split("\n");
        let currentInfraSvc = "";
        for (const line of lines) {
          const match = line.match(/^\s{2}([a-zA-Z0-9_-]+):/);
          if (match) {
            currentInfraSvc = match[1];
            let infraType = "Docker container";
            let name = currentInfraSvc;
            
            if (currentInfraSvc.includes("postgres") || currentInfraSvc.includes("db")) {
              infraType = "database";
              name = "PostgreSQL Database";
            } else if (currentInfraSvc.includes("redis") || currentInfraSvc.includes("cache")) {
              infraType = "cache";
              name = "Redis Cache";
            } else if (currentInfraSvc.includes("mongo")) {
              infraType = "database";
              name = "MongoDB Database";
            } else if (currentInfraSvc.includes("minio") || currentInfraSvc.includes("s3")) {
              infraType = "secret/configuration";
              name = "MinIO Object Storage";
            } else if (currentInfraSvc.includes("inngest")) {
              infraType = "queue/topic/event";
              name = "Inngest Event Engine";
            }

            const infraNodeId = `infra_${currentInfraSvc}`;
            addNode({
              id: infraNodeId,
              type: infraType,
              name: name,
              metadata: { dockerService: currentInfraSvc }
            });

            addEdge({
              id: `app-to-infra-${currentInfraSvc}`,
              source: rootAppId,
              target: infraNodeId,
              type: "RUNS_IN",
              evidence: { file: "docker-compose.yml", line: 1, description: "Runs infrastructure container" }
            });
          }
        }
      }
    } catch {}
  }

  // 4. Connect files, symbols, and dependencies
  const externalSdks = [
    { key: "clerk", name: "Clerk Authentication" },
    { key: "stripe", name: "Stripe Billing" },
    { key: "getstream", name: "GetStream Video" }
  ];

  for (const file of files) {
    // Standardize file paths using forward slashes
    const standardPath = file.relativePath.replace(/\\/g, "/");
    const fileNodeId = `file_${standardPath.replace(/\//g, "_").replace(/\./g, "_")}`;
    
    addNode({
      id: fileNodeId,
      type: "file",
      name: path.basename(standardPath),
      metadata: { relativePath: standardPath, language: file.language }
    });

    // Check if it belongs to a Service or a Package
    const owningSvc = services.find(s => s.path !== "" && standardPath.startsWith(s.path.replace(/\\/g, "/")));
    const owningPkg = packages.find(p => p.path !== "" && standardPath.startsWith(p.path.replace(/\\/g, "/")));

    if (owningSvc) {
      addEdge({
        id: `svc-file-${fileNodeId}`,
        source: owningSvc.id,
        target: fileNodeId,
        type: "IMPORTS",
        evidence: { file: standardPath, line: 1, description: "Service file membership" }
      });
    } else if (owningPkg) {
      addEdge({
        id: `pkg-file-${fileNodeId}`,
        source: owningPkg.id,
        target: fileNodeId,
        type: "IMPORTS",
        evidence: { file: standardPath, line: 1, description: "Package file membership" }
      });
    } else {
      // Fallback: connect file directly to root app
      addEdge({
        id: `app-file-${fileNodeId}`,
        source: rootAppId,
        target: fileNodeId,
        type: "IMPORTS",
        evidence: { file: standardPath, line: 1, description: "App root file membership" }
      });
    }

    // Add symbols and connect them to the file
    for (const sym of file.symbols) {
      const symNodeId = `sym_${fileNodeId}_${sym.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      
      let nodeType = "symbol";
      if (sym.kind === "route") nodeType = "route";
      else if (sym.kind === "query") nodeType = "symbol"; // keep it as symbol or route depending on query
      else if (sym.kind === "queue producer" || sym.kind === "queue consumer") nodeType = "symbol";

      addNode({
        id: symNodeId,
        type: nodeType,
        name: sym.name,
        metadata: { kind: sym.kind, line: sym.line, startLine: sym.startLine, endLine: sym.endLine }
      });

      addEdge({
        id: `file-sym-${symNodeId}`,
        source: fileNodeId,
        target: symNodeId,
        type: "CALLS",
        evidence: { file: standardPath, line: sym.line, description: `Defines ${sym.kind} Symbol` }
      });

      // Special Connection Rule 1: Connect database queries to Database nodes
      if (sym.kind === "query" || sym.name.toLowerCase().includes("prisma") || sym.name.toLowerCase().includes("mongodb")) {
        const dbId = sym.name.toLowerCase().includes("mongo") ? "infra_mongodb" : "infra_postgres";
        const hasDbNode = nodes.some(n => n.id === dbId);
        
        if (hasDbNode) {
          addEdge({
            id: `query-db-${symNodeId}`,
            source: symNodeId,
            target: dbId,
            type: "QUERIES",
            evidence: { file: standardPath, line: sym.line, description: `Performs database query: ${sym.name}` }
          });
        }
      }

      // Special Connection Rule 2: Connect external SDK usage to External Nodes
      for (const sdk of externalSdks) {
        if (sym.name.toLowerCase().includes(sdk.key)) {
          const sdkNodeId = `sdk_${sdk.key}`;
          addNode({
            id: sdkNodeId,
            type: "external SDK",
            name: sdk.name,
            metadata: { provider: sdk.key }
          });

          addEdge({
            id: `sym-sdk-${sdk.key}-${symNodeId}`,
            source: symNodeId,
            target: sdkNodeId,
            type: "CALLS_EXTERNAL",
            evidence: { file: standardPath, line: sym.line, description: `Invokes external ${sdk.name} SDK` }
          });
        }
      }

      // Special Connection Rule 3: BullMQ Queues and Workers
      if (sym.kind === "queue producer" && sym.name.startsWith("Queue: ")) {
        const queueName = sym.name.replace("Queue: ", "");
        const queueNodeId = `queue_${queueName}`;
        
        addNode({
          id: queueNodeId,
          type: "queue/topic/event",
          name: `${queueName} Queue`,
          metadata: { queueName }
        });

        addEdge({
          id: `sym-publish-queue-${queueName}-${symNodeId}`,
          source: symNodeId,
          target: queueNodeId,
          type: "PUBLISHES_TO",
          evidence: { file: standardPath, line: sym.line, description: `Publishes events to queue: ${queueName}` }
        });
      }

      if (sym.kind === "queue consumer" && sym.name.startsWith("Worker: ")) {
        const queueName = sym.name.replace("Worker: ", "");
        const queueNodeId = `queue_${queueName}`;
        
        addNode({
          id: queueNodeId,
          type: "queue/topic/event",
          name: `${queueName} Queue`,
          metadata: { queueName }
        });

        addEdge({
          id: `queue-consume-${queueName}-${symNodeId}`,
          source: queueNodeId,
          target: symNodeId,
          type: "CONSUMES_FROM",
          evidence: { file: standardPath, line: sym.line, description: `Worker consumes events from queue: ${queueName}` }
        });
      }

      // Special Connection Rule 4: Inngest Events
      if (sym.kind === "event" && sym.name.startsWith("Inngest Emit: ")) {
        const eventName = sym.name.replace("Inngest Emit: ", "");
        const eventNodeId = `inngest_event_${eventName.replace(/\./g, "_")}`;

        addNode({
          id: eventNodeId,
          type: "queue/topic/event",
          name: `Inngest Event: ${eventName}`,
          metadata: { eventName }
        });

        addEdge({
          id: `sym-emit-inngest-${eventName}-${symNodeId}`,
          source: symNodeId,
          target: eventNodeId,
          type: "PUBLISHES_TO",
          evidence: { file: standardPath, line: sym.line, description: `Emits Inngest Event: ${eventName}` }
        });
      }

      if (sym.kind === "event" && sym.name.startsWith("Inngest Function: ")) {
        // format: Inngest Function: process-interview-created (interview.created)
        const match = sym.name.match(/Inngest Function: ([^\s(]+) \(([^)]+)\)/);
        if (match) {
          const funcId = match[1];
          const eventName = match[2];
          const eventNodeId = `inngest_event_${eventName.replace(/\./g, "_")}`;

          addNode({
            id: eventNodeId,
            type: "queue/topic/event",
            name: `Inngest Event: ${eventName}`,
            metadata: { eventName }
          });

          addEdge({
            id: `inngest-trigger-${eventName}-${symNodeId}`,
            source: eventNodeId,
            target: symNodeId,
            type: "CONSUMES_FROM",
            evidence: { file: standardPath, line: sym.line, description: `Inngest function ${funcId} triggered by ${eventName}` }
          });
        }
      }
    }
  }

  return { nodes, edges };
}
