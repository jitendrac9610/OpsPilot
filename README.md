# OpsPilot AI v4

OpsPilot is an agentic software-reliability platform prototype that indexes repositories, provisions isolated runtime environments, discovers application contracts, generates stateful tests, correlates evidence, and supports evidence-gated remediation.

## Feature status

| Capability | Status |
| --- | --- |
| Repository indexing and snapshot verification | Implemented |
| npm, pnpm, Yarn workspace and nested-app discovery | Implemented |
| Docker Compose and multi-service startup | Implemented |
| PostgreSQL, Redis and MongoDB provisioning | Implemented |
| Express, Next.js and OpenAPI HTTP contract discovery | Implemented |
| Zod, Joi, express-validator and TypeScript schema extraction | Implemented foundation |
| Authentication bootstrap and credential injection | Implemented foundation |
| Valid, boundary, malformed and authorization request generation | Implemented |
| Stateful resource planning, ID extraction and reverse cleanup | Implemented foundation |
| Read-only PostgreSQL/MongoDB and BullMQ assertions | Implemented foundation |
| Playwright, Socket.IO and signed webhook drivers | Implemented foundation |
| Cross-service correlation and root-cause localization | Implemented foundation |
| Verified patch replay and approval gates | Implemented foundation |
| Broad framework coverage, benchmark scoring and final dashboard | In progress |

“Foundation” means the capability executes and has contract tests, but still needs broader framework/provider coverage and production hardening.

## Architecture

```text
Repository URL
  -> snapshot + index
  -> stack, workspace, Compose and contract discovery
  -> isolated dependency and application services
  -> authentication + stateful request plan
  -> HTTP / browser / WebSocket / webhook execution
  -> database / queue / response assertions
  -> correlated evidence timeline
  -> diagnosis
  -> sandbox patch + workflow replay + verification gates
```

The monorepo uses pnpm workspaces, Turborepo and TypeScript. The control plane and workers use Node.js; the web application uses Next.js. Runtime dependencies include PostgreSQL with pgvector, Redis and optional MongoDB.

## Runtime Lab

Runtime Lab discovers npm, pnpm and Yarn workspaces plus nested applications such as `apps/api`, `server` and `frontend`. It classifies API, worker, frontend and general application processes; imports Docker Compose dependencies, ports, environment, health checks, images and build contexts; then starts services in dependency order.

```text
dependency services
  -> deterministic workspace installs
  -> builds and migrations
  -> API services
  -> background workers
  -> frontend services
  -> per-service readiness probes
  -> discovered tests
```

Each service runs in its own container with a stable network alias and dynamically allocated loopback-only host port. HTTP, TCP and process readiness are checked independently. Failed startup attempts are logged, terminated and retried according to the execution manifest.

Create a sandbox from an indexed snapshot, then run:

```text
POST /api/sandboxes/:id/run
```

The version-2 execution manifest records workspace and Compose files; per-service commands, directories, dependencies, environments and restart policy; deterministic lifecycle commands; startup order; health checks; and required environment variables.

## Contract-driven workflows

Workflow discovery merges OpenAPI/Swagger JSON or YAML with Express and Next.js source evidence. Contracts can include:

- nested router prefixes and inherited middleware;
- path, query, header and cookie parameters;
- JSON, form and multipart bodies;
- response schemas and security schemes;
- roles, permissions and required environment variables;
- Zod, Joi, express-validator and TypeScript request types;
- Prisma operations and selected relations;
- source locations, confidence and supporting evidence.

The request generator builds complete valid requests plus missing-field, invalid-type, boundary, unauthorized, forbidden, duplicate and malformed variants. Authentication bootstrap supports registration/login discovery, access and refresh tokens, cookies, API keys and role sessions without inventing credentials when authentication fails.

The stateful planner orders prerequisite resources, stores response variables, binds dependent path/body values, creates failure-path scenarios and emits reverse-order cleanup steps. Workflow replay resolves those variables and carries one correlation ID across supported drivers.

## Safety properties

- Application ports bind to `127.0.0.1`.
- Built-in database assertions use read-only PostgreSQL transactions and bounded MongoDB reads.
- Raw mutating SQL and assertion-layer cleanup are rejected.
- Tool inputs are schema-checked and workspace paths are traversal/symlink checked.
- Unconfigured SDK, rollback, approval and deployment tools fail closed.
- Agent approval cannot be self-issued by the default tool registry.
- Generated source artifacts and TypeScript build metadata are ignored.

## Getting started

Prerequisites:

- Node.js 18 or newer
- pnpm 9
- Docker with Docker Compose

```bash
docker compose up -d
pnpm install
pnpm dev
```

## Verification

```bash
pnpm build
pnpm test
pnpm --filter @opspilot/workflow-engine test
pnpm --filter @opspilot/sandbox-controller test
pnpm --filter @opspilot/control-api test
pnpm --filter @opspilot/sandbox-controller test:docker
```

The Docker smoke test requires a running Docker daemon and verifies a real PostgreSQL + Redis + Node lifecycle. GitHub Actions runs build, lint, tests and the Docker smoke test.

## Remaining MVP work

The largest remaining areas are broader WebSocket/webhook discovery, richer queue producer-consumer mapping, multi-role identity provisioning, provider-hosted authentication fixtures, stronger source-symbol localization, full temporary-worktree patch application, malicious-repository sandbox tests, benchmark scoring and the final evidence dashboard.
