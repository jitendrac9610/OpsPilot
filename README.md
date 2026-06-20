# OpsPilot AI v4

OpsPilot is an agentic software reliability platform prototype with real repository indexing, snapshot-verified Docker sandboxing, static analysis, and initial runtime-test infrastructure.

The current Runtime Lab slice supports a root-level Node.js application with a deterministic lockfile. It can provision isolated PostgreSQL, Redis, and MongoDB services, run dependency installation and builds, apply discovered migrations, start the application on a dynamically allocated host port, verify HTTP health, run discovered tests, and clean up its Docker resources.

Root-cause localization, multi-service workspace execution, and independently verified remediation pull requests are still under development.

## Tech Stack
- **Monorepo**: pnpm workspaces + Turborepo + TypeScript
- **Frontend**: Next.js
- **Backend Services**: Node.js microservices + BullMQ
- **Data & Cache**: PostgreSQL (with pgvector) + Redis + Object Storage (MinIO)
- **Isolation**: Ephemeral sandboxes

## Runtime Lab API

After creating a sandbox from an indexed repository snapshot, run its managed lifecycle through:

```text
POST /api/sandboxes/:id/run
```

The lifecycle is:

```text
dependency services -> install -> build -> migrations -> start -> HTTP probe -> tests
```

Each sandbox receives an isolated Docker network. Application ports are published only on `127.0.0.1` using dynamically assigned host ports.

## Getting Started

### Prerequisites
- Node.js (v18+)
- pnpm (v9+)
- Docker & Docker Compose

### Running Dev Services
Start the database, cache, and object storage containers:
```bash
docker compose up -d
```

### Install Dependencies
```bash
pnpm install
```

### Run Monorepo in Development
```bash
pnpm dev
```

### Verify Runtime Lab

```bash
pnpm --filter @opspilot/sandbox-controller test
pnpm --filter @opspilot/control-api test
pnpm --filter @opspilot/sandbox-controller test:docker
```

The Docker smoke test requires a running Docker daemon and verifies the real PostgreSQL + Redis + Node lifecycle.
