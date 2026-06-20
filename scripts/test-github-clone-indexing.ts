import dotenv from "dotenv";
dotenv.config();

import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

async function testGitHubCloneAndIndexing() {
  console.log("=========================================================");
  console.log("🔎 TESTING OPSPILOT AI v4 — REAL GITHUB REPO INDEXING TEST");
  console.log("=========================================================\n");

  const email = `github-tester-${Date.now()}@opspilot.ai`;
  const password = "password123";
  const orgName = "GitHub Test Org";
  const projectName = "GitHub Test Project";
  const repoName = "Spoon-Knife";
  const gitUrl = "https://github.com/octocat/Spoon-Knife.git";

  try {
    // 1. Register and login to control API (port 4000)
    console.log("📍 [Step 1/6] Registering and Authenticating User...");
    const regRes = await fetch("http://localhost:4000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!regRes.ok) {
      throw new Error(`Failed to register user: ${await regRes.text()}`);
    }
    const regData = await regRes.json();
    console.log(`  ✓ Registered user: ${regData.email}`);

    // Verify user email so they can log in
    await fetch("http://localhost:4000/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: regData.id })
    });

    const loginRes = await fetch("http://localhost:4000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!loginRes.ok) {
      throw new Error(`Failed to login user: ${await loginRes.text()}`);
    }
    const { token } = await loginRes.json();
    console.log("  ✓ Authenticated user. JWT token retrieved.");

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    };

    // 2. Create organization
    console.log("\n📍 [Step 2/6] Creating Organization...");
    const orgRes = await fetch("http://localhost:4000/api/organizations", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: orgName })
    });
    if (!orgRes.ok) {
      throw new Error(`Failed to create org: ${await orgRes.text()}`);
    }
    const org = await orgRes.json();
    console.log(`  ✓ Organization created: ${org.name} (${org.id})`);

    const headersWithOrg = {
      ...headers,
      "x-organization-id": org.id
    };

    // Ensure a free-tier subscription is created for limits check
    await fetch("http://localhost:4000/api/subscriptions", {
      method: "POST",
      headers: headersWithOrg,
      body: JSON.stringify({ planId: "free" })
    }).catch(() => {});

    // 3. Create project
    console.log("\n📍 [Step 3/6] Creating Project...");
    const projRes = await fetch("http://localhost:4000/api/projects", {
      method: "POST",
      headers: headersWithOrg,
      body: JSON.stringify({ name: projectName, organizationId: org.id })
    });
    if (!projRes.ok) {
      throw new Error(`Failed to create project: ${await projRes.text()}`);
    }
    const project = await projRes.json();
    console.log(`  ✓ Project created: ${project.name} (${project.id})`);

    // 4. Connect GitHub repository
    console.log("\n📍 [Step 4/6] Connecting Public GitHub Repo...");
    const repoRes = await fetch(`http://localhost:4000/api/repositories/projects/${project.id}/repositories`, {
      method: "POST",
      headers: headersWithOrg,
      body: JSON.stringify({
        name: repoName,
        gitUrl,
        branch: "main",
        directory: "/"
      })
    });
    if (!repoRes.ok) {
      throw new Error(`Failed to connect repository: ${await repoRes.text()}`);
    }
    const repo = await repoRes.json();
    console.log(`  ✓ Repository connected: ${repo.name} (${repo.gitUrl})`);

    // 5. Start indexing pipeline
    console.log("\n📍 [Step 5/6] Triggering Clone and Indexing Pipeline...");
    const indexRes = await fetch(`http://localhost:4000/api/repositories/${repo.id}/index`, {
      method: "POST",
      headers: headersWithOrg
    });
    if (!indexRes.ok) {
      throw new Error(`Failed to start indexing: ${await indexRes.text()}`);
    }
    console.log("  ✓ Indexing pipeline successfully triggered. Webhook dispatched.");

    // 6. Poll indexing status until INDEXED
    console.log("\n📍 [Step 6/6] Polling Repository Indexing Status...");
    let status = "UNINDEXED";
    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes

    while (status !== "INDEXED" && (Date.now() - startTime) < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const statusRes = await fetch(`http://localhost:4000/api/repositories/${repo.id}/status`, {
        method: "GET",
        headers: headersWithOrg
      });
      if (statusRes.ok) {
        const data = await statusRes.json();
        status = data.status;
        console.log(`  [Polling] Current Status: ${status} (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
      } else {
        console.log(`  [Polling] Warning: Failed to query status: ${statusRes.statusText}`);
      }
    }

    if (status !== "INDEXED") {
      throw new Error("Indexing test timed out before status reached INDEXED.");
    }

    console.log("\n⚡ INDEXING COMPLETED! Verifying results...");

    // Fetch capability profile
    const capRes = await fetch(`http://localhost:4000/api/repositories/${repo.id}/capabilities`, {
      method: "GET",
      headers: headersWithOrg
    });
    const capProfile = await capRes.json();
    console.log("\nDiscovered Capabilities Profile:");
    console.log(JSON.stringify(capProfile.profile, null, 2));

    // Fetch architecture graph
    const archRes = await fetch(`http://localhost:4000/api/repositories/${repo.id}/architecture`, {
      method: "GET",
      headers: headersWithOrg
    });
    const graph = await archRes.json();
    console.log(`\nDiscovered Architecture Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges.`);

    // Fetch static findings
    const findingsRes = await fetch(`http://localhost:4000/api/repositories/${repo.id}/findings`, {
      method: "GET",
      headers: headersWithOrg
    });
    const findings = await findingsRes.json();
    console.log(`Discovered Static Audit Findings: ${findings.length} findings.`);

    console.log("\n=========================================================");
    console.log("🎉 REAL GITHUB REPOSITORY CLONING AND INDEXING PASSED!");
    console.log("=========================================================");

  } catch (err: any) {
    console.error("\n❌ GitHub Repository Indexing Test Failed:", err);
    process.exit(1);
  }
}

testGitHubCloneAndIndexing().then(() => process.exit(0));
