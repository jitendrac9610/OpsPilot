import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverWebSocketContracts } from "../websocketDiscovery.js";
import { StatefulWorkflowPlanner } from "../statefulPlanner.js";
import { EndpointContract } from "@opspilot/schemas";

export async function runPhase8Tests() {
  console.log("=== Running Phase 8 WebSocket Automation Tests ===");

  const tempRoot = path.join(os.tmpdir(), `opspilot-ws-test-${Date.now()}`);
  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    // ----------------------------------------------------
    // Test 1: Discover WebSocket Contract from Mock Code
    // ----------------------------------------------------
    console.log("Testing WebSocket Contract Discovery...");
    
    const mockServerFile = path.join(tempRoot, "server.ts");
    await fs.promises.writeFile(mockServerFile, `
      import { Server } from "socket.io";
      import { createAdapter } from "@socket.io/redis-adapter";
      
      const io = new Server(3000);
      io.adapter(createAdapter(pubClient, subClient));
      
      const chatNsp = io.of("/chat");
      
      chatNsp.use((socket, next) => {
        const token = socket.handshake.auth.token;
        next();
      });
      
      chatNsp.on("connection", (socket) => {
        socket.on("send-message", (data) => {
          socket.join("room-123");
          socket.to("room-123").emit("message-delivered", { id: 1 });
        });
      });
    `);

    const contracts = await discoverWebSocketContracts(tempRoot);
    
    assert.strictEqual(contracts.length, 1, "Expected 1 WebSocket contract discovered");
    const contract = contracts[0];
    
    assert.strictEqual(contract.framework, "socket.io", "Expected framework socket.io");
    assert.deepStrictEqual(contract.namespaces, ["/chat"], "Expected namespace /chat");
    assert.strictEqual(contract.redisAdapter, true, "Expected redisAdapter detected");
    assert.strictEqual(contract.handshakeAuth.required, true, "Expected handshakeAuth detected");
    
    const sendMessageEvent = contract.events.find(e => e.name === "send-message");
    assert.ok(sendMessageEvent, "Expected send-message event discovered");
    assert.strictEqual(sendMessageEvent.direction, "client-to-server", "Expected client-to-server direction");
    assert.deepStrictEqual(sendMessageEvent.rooms, ["room-123"], "Expected room join detected");

    const messageDeliveredEvent = contract.events.find(e => e.name === "message-delivered");
    assert.ok(messageDeliveredEvent, "Expected message-delivered event discovered");
    assert.strictEqual(messageDeliveredEvent.direction, "server-to-client", "Expected server-to-client direction");
    
    console.log("✓ WebSocket Contract Discovery verified.");

    // ----------------------------------------------------
    // Test 2: Cross-Protocol Planning (HTTP + WebSocket)
    // ----------------------------------------------------
    console.log("Testing Cross-Protocol Workflow Planning...");

    const mockHttpContract: EndpointContract = {
      id: "post-api-messages",
      method: "POST",
      path: "/api/messages",
      framework: "express" as const,
      source: { file: "api.ts", line: 10 },
      summary: "Send Message API",
      tags: [],
      parameters: [],
      responses: [
        {
          status: "201",
          description: "Created",
          headers: {},
          content: {
            "application/json": {
              type: "object",
              properties: {
                id: { type: "string" }
              }
            }
          }
        }
      ],
      security: [],
      middleware: [],
      requiredEnvironment: [],
      roles: [],
      permissions: [],
      prisma: [],
      evidence: [],
      confidence: 1.0
    };

    const planner = new StatefulWorkflowPlanner("http://localhost:3000");
    const plan = await planner.planWorkflow("proj-123", [mockHttpContract], contracts);

    // Verify dynamic steps have been generated
    const steps = plan.steps;
    
    // We expect:
    // 1. Create message HTTP Step (Post Message API)
    // 2. Join WebSocket Room Step (since events match word "message")
    // 3. Listen/Emit WebSocket Steps
    const createStep = steps.find(s => s.type === "HTTP_REQUEST" && s.name.includes("Create Message"));
    assert.ok(createStep, "Expected HTTP create step generated");
    
    const joinStep = steps.find(s => s.type === "WEBSOCKET_OPEN" && s.config.action === "join_room");
    assert.ok(joinStep, "Expected Join Room WebSocket step generated");
    assert.strictEqual(joinStep.config.room, "room-${messages.id}", "Expected dynamic room parameter resolved using template variables");

    const listenStep = steps.find(s => s.type === "WEBSOCKET_OPEN" && s.config.action === "listen" && s.config.event === "message-delivered");
    assert.ok(listenStep, "Expected Listen Event WebSocket step generated");

    const emitStep = steps.find(s => s.type === "WEBSOCKET_OPEN" && s.config.action === "emit" && s.config.event === "send-message");
    assert.ok(emitStep, "Expected Emit Event WebSocket step generated");

    console.log("✓ Cross-Protocol Workflow Planning verified.");

  } finally {
    // Cleanup temp directory
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log("✓ All Phase 8 WebSocket Automation Tests Passed!");
}
