# OpsPilot AI v4 — Complete Phase-by-Phase Feature Register

> **Purpose**: This file maps EVERY feature, screen, data model, API, event, and component
> from `OpsPilot_AI_v4_Complete_Working_Blueprint.md` into phases.
> Nothing is skipped. Nothing is left behind.
> Check off items as they are completed.

---

## How to read this document

- `[ ]` = Not started
- `[/]` = In progress
- `[x]` = Completed
- Each item references the **Blueprint Section** it comes from
- Features are numbered **F1–F186** matching the blueprint's feature register (Section 3)
- Additional non-feature items (data models, APIs, events, screens, etc.) are also tracked

---

# PHASE 0 — Contracts, Schemas & Project Scaffold

> Blueprint Sections: 1, 4, 7, 25, 27, 31
> Goal: Define every shared type, schema, data model, event contract, and set up the monorepo.

## 0.1 — Project Structure (Section 31)

- [x] Root `package.json` (pnpm workspaces)
- [x] `pnpm-workspace.yaml`
- [x] `turbo.json` (Turborepo pipeline)
- [x] `tsconfig.base.json` (shared TypeScript config)
- [x] `.env.example` (all environment variables)
- [x] `.gitignore`
- [x] `docker-compose.yml` (PostgreSQL, Redis, MinIO for local dev)
- [x] `README.md` (project overview)
- [x] Directory scaffold for all apps:
  - [x] `apps/web/`
  - [x] `apps/control-api/`
  - [x] `apps/github-worker/`
  - [x] `apps/discovery-worker/`
  - [x] `apps/indexer-worker/`
  - [x] `apps/graph-worker/`
  - [x] `apps/agent-worker/`
  - [x] `apps/sandbox-controller/`
  - [x] `apps/telemetry-api/`
  - [x] `apps/incident-worker/`
  - [x] `apps/evaluation-worker/`
- [x] Directory scaffold for all packages:
  - [x] `packages/agent-runtime/`
  - [x] `packages/rag/`
  - [x] `packages/repository-intelligence/`
  - [x] `packages/workflow-engine/`
  - [x] `packages/remediation-engine/`
  - [x] `packages/adapter-sdk/`
  - [x] `packages/tool-registry/`
  - [x] `packages/policy-engine/`
  - [x] `packages/memory/`
  - [x] `packages/model-gateway/`
  - [x] `packages/schemas/`
  - [x] `packages/database/`
  - [x] `packages/observability/`
  - [x] `packages/shared/`
- [x] Directory scaffold for adapters:
  - [x] `adapters/languages/`
  - [x] `adapters/frameworks/`
  - [x] `adapters/databases/`
  - [x] `adapters/messaging/`
  - [x] `adapters/integrations/`
  - [x] `adapters/deployment/`
  - [x] `adapters/generic/`
- [x] Directory scaffold for connectors:
  - [x] `connectors/github/`
  - [x] `connectors/docker/`
  - [x] `connectors/kubernetes/`
  - [x] `connectors/otel/`
  - [x] `connectors/postgres/`
  - [x] `connectors/mongodb/`
  - [x] `connectors/redis/`
  - [x] `connectors/inngest/`
  - [x] `connectors/getstream/`
  - [x] `connectors/stripe/`
  - [x] `connectors/clerk/`
- [x] `sandbox/` directory
- [x] `benchmarks/` directory
- [x] `infrastructure/` directory
- [x] `docs/` directory

## 0.2 — Core Schemas (packages/schemas/)

### Product Modes (Section 2)

- [x] Repository Audit mode type
- [x] Runtime Lab mode type
- [x] Workflow Verification mode type
- [x] Verified Repair mode type
- [x] Production Incident Response mode type
- [x] Architecture Explorer mode type
- [x] Natural-Language Assistant mode type
- [x] Evaluation Lab mode type

### Adapter Contract (Section 7)

- [x] `OpsPilotAdapter` interface
- [x] `DetectionContext` type
- [x] `DetectionResult` type
- [x] `RepositoryContext` type
- [x] `ArchitectureContribution` type
- [x] `StaticRule` type
- [x] `AgentTool` type
- [x] `SandboxRequirement` type
- [x] `AssertionProvider` type
- [x] `FailureScenario` type
- [x] `VerificationRule` type
- [x] Capability levels enum: `UNSUPPORTED → GENERIC → SYNTAX → SEMANTIC → RUNTIME → VERIFIED_REPAIR`
- [x] Adapter categories: `language | framework | database | messaging | integration | build | runtime | deployment`

### Repository Hierarchy (Section 8)

- [x] Repository type
- [x] Workspace type
- [x] Application type
- [x] Service type
- [x] Package type
- [x] File type
- [x] Symbol type

### Graph Schema (Section 9)

- [x] Graph node types: application, service, package, file, symbol, route, database, table/collection, queue/topic/event, worker/background job, cache, external SDK, webhook, Docker container, Kubernetes resource, deployment, secret/configuration
- [x] Graph edge types: IMPORTS, CALLS, DEPENDS_ON, READS_FROM, WRITES_TO, QUERIES, PUBLISHES_TO, CONSUMES_FROM, TRIGGERS, AUTHENTICATES_WITH, CALLS_EXTERNAL, RECEIVES_WEBHOOK_FROM, GENERATES_TOKEN_FOR, USES_SECRET, DEPLOYED_AS, RUNS_IN, CONFIGURED_BY, INVALIDATES
- [x] Edge evidence (file + line)

### Semantic Chunk Types (Section 9)

- [x] function, method, class, interface, component, API route, middleware, database query, queue producer, queue consumer, Inngest function, webhook, Docker service, Kubernetes resource, test suite

### Agent Schema (Section 11)

- [x] Agent state machine enum: CREATED, DISCOVERING, INDEXING, PLANNING, RETRIEVING, GENERATING_WORKFLOW, EXECUTING_WORKFLOW, LOCALIZING_FAILURE, INVESTIGATING, DIAGNOSING, REPRODUCING, PROPOSING_FIX, APPLYING_SANDBOX_CHANGE, VERIFYING_FIX, AWAITING_APPROVAL, APPLYING_APPROVED_ACTION, MONITORING_RECOVERY, COMPLETED, ROLLED_BACK, NEEDS_HUMAN
- [x] `AgentDecision` union type: retrieve, call_tool, update_hypotheses, replan, propose_change, request_approval, complete, needs_human
- [x] Retry classifications: TRANSIENT, RATE_LIMITED, TIMEOUT, DEPENDENCY_UNAVAILABLE, INVALID_INPUT, AUTHORIZATION_FAILED, POLICY_DENIED, NON_IDEMPOTENT_RISK, UNSUPPORTED, PERMANENT

### Context Package Schema (Section 10)

- [x] Objective
- [x] Current plan and hypotheses
- [x] Affected architecture neighborhood
- [x] Relevant code and configuration
- [x] Relevant tests
- [x] Runtime evidence
- [x] Deployment changes
- [x] SDK documentation
- [x] Previous incidents
- [x] Available tools
- [x] Policies and budgets
- [x] Missing evidence and confidence

### Diagnosis Output Schema (Section 18)

- [x] Failed stage
- [x] Probable root cause
- [x] Confidence
- [x] Supporting evidence
- [x] Contradicting evidence
- [x] Missing evidence
- [x] Affected files and services
- [x] Architecture path
- [x] User impact
- [x] Reproduction result
- [x] Recommended correction

### Approval Card Schema (Section 19)

- [x] Problem description
- [x] Files changed count
- [x] Risk level
- [x] Verification results (build, workflow, regression, security)
- [x] Actions: Review Diff, Approve and Create PR, Reject

## 0.3 — Data Model (Section 25 — packages/database/)

### SaaS Tables

- [x] `users`
- [x] `sessions`
- [x] `organizations`
- [x] `memberships`
- [x] `roles`
- [x] `permissions`
- [x] `projects`
- [x] `repositories`
- [x] `github_installations`
- [x] `integrations`
- [x] `encrypted_secrets`
- [x] `subscriptions`
- [x] `invoices`
- [x] `usage_records`
- [x] `audit_logs`
- [x] `notifications`
- [x] `feature_flags`

### Repository Intelligence Tables

- [x] `repository_snapshots`
- [x] `repository_workspaces`
- [x] `applications`
- [x] `services`
- [x] `packages`
- [x] `repository_files`
- [x] `symbols`
- [x] `references`
- [x] `code_chunks`
- [x] `chunk_embeddings`
- [x] `graph_nodes`
- [x] `graph_edges`
- [x] `architecture_versions`
- [x] `capability_profiles`
- [x] `adapter_executions`
- [x] `documentation_sources`

### RAG and Agent Tables

- [x] `retrieval_rounds`
- [x] `retrieval_candidates`
- [x] `retrieval_quality_assessments`
- [x] `retrieval_feedback`
- [x] `agent_runs`
- [x] `agent_steps`
- [x] `agent_checkpoints`
- [x] `plans`
- [x] `plan_steps`
- [x] `hypotheses`
- [x] `evidence`
- [x] `tool_calls`
- [x] `tool_execution_attempts`
- [x] `model_calls`
- [x] `model_call_attempts`
- [x] `memory_records`
- [x] `budget_records`

### Runtime and Workflow Tables

- [x] `sandboxes`
- [x] `sandbox_services`
- [x] `build_runs`
- [x] `test_runs`
- [x] `load_test_runs`
- [x] `failure_injections`
- [x] `synthetic_workflows`
- [x] `workflow_versions`
- [x] `workflow_steps`
- [x] `workflow_runs`
- [x] `workflow_step_runs`
- [x] `workflow_assertions`
- [x] `workflow_fixtures`
- [x] `workflow_correlations`
- [x] `failure_boundaries`
- [x] `artifacts`

### Repair and Approval Tables

- [x] `diagnoses`
- [x] `remediation_plans`
- [x] `remediation_alternatives`
- [x] `change_sets`
- [x] `change_set_files`
- [x] `verification_plans`
- [x] `verification_runs`
- [x] `verification_assertions`
- [x] `risk_assessments`
- [x] `approval_requests`
- [x] `approved_actions`
- [x] `pull_requests`
- [x] `recovery_monitors`
- [x] `rollback_executions`

### Production Incident Tables

- [x] `telemetry_sources`
- [x] `incidents`
- [x] `incident_events`
- [x] `incident_services`
- [x] `alert_rules`
- [x] `deployment_events`
- [x] `remediation_actions`
- [x] `postmortems`

## 0.4 — Internal Event Contracts (Section 27)

- [x] `repository.connected`
- [x] `repository.snapshot.created`
- [x] `capability.detected`
- [x] `workspace.discovered`
- [x] `service.discovered`
- [x] `indexing.started`
- [x] `indexing.completed`
- [x] `architecture.generated`
- [x] `analysis.started`
- [x] `finding.created`
- [x] `workflow.discovered`
- [x] `workflow.run.requested`
- [x] `workflow.step.started`
- [x] `workflow.step.completed`
- [x] `workflow.assertion.failed`
- [x] `workflow.failed`
- [x] `workflow.passed`
- [x] `failure.boundary.localized`
- [x] `agent.started`
- [x] `agent.replanned`
- [x] `agent.checkpoint.created`
- [x] `retrieval.retry.requested`
- [x] `retrieval.retry.completed`
- [x] `tool.retry.requested`
- [x] `model.retry.requested`
- [x] `diagnosis.completed`
- [x] `remediation.plan.created`
- [x] `sandbox.change.applied`
- [x] `verification.started`
- [x] `verification.failed`
- [x] `verification.passed`
- [x] `approval.requested`
- [x] `approval.approved`
- [x] `approved_action.started`
- [x] `approved_action.completed`
- [x] `recovery.failed`
- [x] `rollback.started`
- [x] `rollback.completed`
- [x] `postmortem.created`
- [x] `budget.exhausted`
- [x] `dead_letter.created`
- [x] Event envelope: organization, project, environment, source entity, commit, correlation ID, idempotency key, timestamp

## 0.5 — Shared Utilities (packages/shared/)

- [x] Structured logger (pino)
- [x] Error hierarchy
- [x] Event bus abstraction (BullMQ-backed)
- [x] Environment config loader
- [x] ID generation (nanoid/cuid)
- [x] Tenant context utilities

## 0.6 — Seeded Benchmarks (Section 29)

- [x] Seeded benchmark repository with known failures:
  - [x] Redis hostname mismatch
  - [x] BullMQ queue-name mismatch
  - [x] Inngest event-name mismatch
  - [x] PostgreSQL connection leak
  - [x] MongoDB missing index
  - [x] Stripe webhook raw-body failure
  - [x] Clerk token-forwarding failure
  - [x] GetStream identity mismatch
  - [x] Kubernetes readiness failure
  - [x] Memory-limit crash
  - [x] Duplicate webhook
  - [x] Retry storm
  - [x] Frontend/backend contract mismatch
  - [x] CodeMirror listener leak

---

# PHASE 1 — SaaS Foundation

> Blueprint Sections: 3A, 22 (Screens 1–2), 24, 26 (Auth/Org APIs)
> Goal: Auth, organizations, RBAC, projects, audit, basic usage, dashboard shell.

## 1.1 — Feature Register: Section A (SaaS & Workspace)

- [x] F1: Email/password authentication
- [x] F2: GitHub OAuth
- [x] F3: Google OAuth
- [x] F4: Email verification
- [x] F5: Password reset
- [x] F6: Two-factor authentication
- [x] F7: Session and login-history management
- [x] F8: Organizations and personal workspaces
- [x] F9: Team invitations
- [x] F10: Organization switching
- [x] F11: RBAC and custom permissions
- [x] F12: Organization-specific projects and integrations
- [x] F13: Subscription plans (structure only, billing deferred)
- [x] F14: Usage-based metering (structure only)
- [x] F15: Upgrade, downgrade, trials and invoices (deferred)
- [x] F16: Plan-limit enforcement (structure only)
- [x] F17: Usage dashboard and cost-per-investigation (deferred)
- [x] F18: Audit logs
- [x] F19: Notifications by email, Slack and webhook
- [x] F20: Internal platform administration
- [x] F21: Feature flags
- [x] F22: Data export, retention and deletion

## 1.2 — Control Plane API (Section 24, 26)

### Authentication & Access

- [x] OAuth and credentials endpoints
- [x] Session management
- [x] Organization membership validation
- [x] Project-scoped permissions
- [x] Environment-specific permissions
- [x] Two-person approvals for high-risk actions

### API Endpoints — Organizations, Users, Billing (Section 26)

- [x] `POST /api/organizations`
- [x] `POST /api/organizations/:id/invitations`
- [x] `GET  /api/organizations/:id/members`
- [x] `GET  /api/usage`
- [x] `GET  /api/billing`
- [x] `POST /api/subscriptions`
- [x] `GET  /api/audit-logs`

## 1.3 — Frontend: Screens 1–2 (Section 22)

### Screen 1: Landing and Authentication

- [x] Product explanation
- [x] Supported workflows showcase
- [x] Sample investigation demo
- [x] Login form
- [x] Signup form
- [x] GitHub connection CTA

### Screen 2: Organization and Project Setup

- [x] Organization creation
- [x] Member invitations
- [x] Role assignment
- [x] Plan and usage display
- [x] Integrations management

## 1.4 — Security Foundation (Section 28 — partial)

- [x] Encrypted secrets storage
- [x] Session security
- [x] Tenant-scoped SQL/vector/cache/object storage
- [x] Audit logging
- [x] RBAC enforcement

---

# PHASE 2 — GitHub Integration & Repository Snapshots

> Blueprint Sections: 3B, 6, 22 (Screen 3), 26 (Repository APIs)
> Goal: GitHub App, repository selection, exact commits, push synchronization.

## 2.1 — Feature Register: Section B (Repository & Source Control)

- [x] F23: GitHub App installation
- [x] F24: Public and private repository connection
- [x] F25: Repository, branch and monorepo-directory selection
- [x] F26: Immutable commit snapshots
- [x] F27: Push-webhook synchronization
- [x] F28: Pull-request analysis
- [x] F29: Manual re-indexing
- [x] F30: Git history, diff and blame tools
- [x] F31: Agent branches, commits and pull requests
- [x] F32: GitHub check/status integration

## 2.2 — Repository Onboarding Workflow (Section 6)

- [x] GitHub App Installation handler
- [x] Short-lived installation token generation
- [x] Clone exact commit
- [x] Store snapshot metadata
- [x] Trigger discovery worker

## 2.3 — API Endpoints — Repositories (Section 26)

- [x] `POST /api/projects`
- [x] `POST /api/projects/:id/repositories`
- [x] `POST /api/repositories/:id/index`
- [x] `GET  /api/repositories/:id/status`
- [x] `GET  /api/repositories/:id/capabilities`
- [x] `GET  /api/repositories/:id/architecture`
- [x] `GET  /api/repositories/:id/findings`

## 2.4 — Frontend: Screen 3 (Section 22)

### Screen 3: Connect Repository

- [x] Install GitHub App flow
- [x] Select repository
- [x] Select branch/directory
- [x] Start analysis button

## 2.5 — GitHub Worker (apps/github-worker/)

- [x] Webhook receiver (installation, push, PR events)
- [x] Installation event handler
- [x] Push event handler (trigger re-index)
- [x] PR event handler (trigger analysis)
- [x] Token management (short-lived installation tokens)

---

# PHASE 3 — Universal Discovery & Adapter System

> Blueprint Sections: 3C, 7, 22 (Screen 4 partial)
> Goal: Technology detection, capability levels, adapter SDK, generic fallback.

## 3.1 — Feature Register: Section C (Universal Compatibility)

- [x] F33: Language detection
- [x] F34: Framework detection
- [x] F35: Build-system and package-manager detection
- [x] F36: Database detection
- [x] F37: Cache, queue and background-job detection
- [x] F38: SDK and external-integration detection
- [x] F39: Docker, Kubernetes, CI/CD and infrastructure detection
- [x] F40: Capability-level reporting
- [x] F41: Language-adapter registry
- [x] F42: Framework-adapter registry
- [x] F43: Database-adapter registry
- [x] F44: Messaging/background-job adapter registry
- [x] F45: External-SDK adapter registry
- [x] F46: Generic unknown-technology fallback
- [x] F47: Version-aware documentation resolver
- [x] F48: Adapter/plugin SDK

## 3.2 — Adapter SDK (packages/adapter-sdk/)

- [x] `OpsPilotAdapter` interface implementation
- [x] Adapter registry with auto-discovery
- [x] Capability level resolution
- [x] Generic fallback adapter

## 3.3 — Discovery Worker (apps/discovery-worker/)

- [x] BullMQ worker setup
- [x] Language detector (file extensions, shebangs, package manifests)
- [x] Framework detector (package.json deps, imports, config files)
- [x] Build-system detector (package.json scripts, Makefiles, Gradle, Maven)
- [x] Database detector (connection strings, ORMs, migration folders)
- [x] Cache detector (Redis configs, Memcached)
- [x] Queue/messaging detector (BullMQ, RabbitMQ, Kafka, Inngest configs)
- [x] SDK/integration detector (package deps, imports, env vars)
- [x] Docker detector (Dockerfile, docker-compose.yml)
- [x] Kubernetes detector (manifests, Helm charts)
- [x] CI/CD detector (.github/workflows, Jenkinsfile, etc.)
- [x] Infrastructure-as-Code detector (Terraform, Pulumi, CloudFormation)
- [x] Capability profiler (aggregate all detections)

## 3.4 — Unknown SDK Flow (Section 7)

- [x] Inspect package manifest and imports
- [x] Find initialization and environment variables
- [x] Extract HTTP calls and webhooks
- [x] Retrieve versioned documentation
- [x] Inspect logs, traces and status codes
- [x] Build generic architecture edges
- [x] Run generic auth/timeout/rate-limit/retry checks
- [x] Display lower confidence and missing provider checks

## 3.5 — Initial Adapters

- [x] TypeScript/JavaScript language adapter
- [x] Node.js runtime adapter
- [x] Express framework adapter
- [x] Next.js framework adapter

## 3.6 — Frontend: Onboarding Progress (Section 6, Screen 4 partial)

- [x] Live onboarding status display:
  - [x] Repository access verified
  - [x] Snapshot created at commit hash
  - [x] N languages detected
  - [x] N applications/services detected
  - [x] N databases/caches detected
  - [x] N queue/background systems detected
  - [x] N external integrations detected

---

# PHASE 4 — Repository Indexing & Architecture Graph

> Blueprint Sections: 3D, 8, 9, 22 (Screens 4–6)
> Goal: Parsing, symbols, chunks, embeddings, lexical index, graph, frontend explorer.

## 4.1 — Feature Register: Section D (Repository Intelligence)

- [x] F49: File classification and filtering
- [x] F50: Secret and binary exclusion before indexing
- [x] F51: Tree-sitter parsing
- [x] F52: LSP/compiler semantic analysis
- [x] F53: AST-aware chunking
- [x] F54: Symbol, definition and reference indexing
- [x] F55: Cross-file call relationships
- [x] F56: Service/workspace/package decomposition
- [x] F57: Request/response contract extraction
- [x] F58: Database model and query extraction
- [x] F59: Queue producer/consumer mapping
- [x] F60: SDK and webhook relationship extraction
- [x] F61: Docker/Kubernetes/deployment extraction
- [x] F62: Evidence-backed architecture graph
- [x] F63: Incremental content-addressed indexing
- [x] F64: Hierarchical summaries for very large repositories
- [x] F65: Architecture comparison between commits

## 4.2 — Indexing Pipeline (Section 9 — packages/repository-intelligence/)

- [x] File classifier
- [x] Secret / binary / generated file filtering
- [x] Language parser (tree-sitter WASM)
  - [x] TypeScript parser
  - [x] JavaScript parser
  - [x] Python parser
  - [x] Java parser
  - [x] Go parser
  - [x] Additional language parsers
- [x] AST and symbol extraction
- [x] Definition / reference resolution
- [x] Semantic chunking (AST-aware)
- [x] Embedding generation (vector index)
- [x] Lexical/BM25 index generation
- [x] Architecture relationship extraction
- [x] Graph node creation
- [x] Graph edge creation with file/line evidence
- [x] Index quality validation

## 4.3 — Large Repository Support (Section 8)

### Scaling Mechanisms

- [x] Distributed indexing queues
- [x] Content hashes for deduplication
- [x] Changed-file-only processing
- [x] Reuse of unchanged ASTs and embeddings
- [x] Service-level graph partitions
- [x] Hierarchical summaries
- [x] Service-first retrieval
- [x] Parallel parser workers
- [x] Backpressure and quotas
- [x] Separate artifact storage
- [x] Dead-letter handling
- [x] Per-tenant resource budgets

### Large-Repository Routing

- [x] Repository router (select workspace)
- [x] Service router (select relevant services)
- [x] Integration router (select relevant SDKs)
- [x] Exact symbol and runtime retrieval targeting

## 4.4 — Indexer Worker (apps/indexer-worker/)

- [x] BullMQ worker setup
- [x] Parse job processor
- [x] Symbol index job processor
- [x] Embedding generation job processor

## 4.5 — Graph Worker (apps/graph-worker/)

- [x] BullMQ worker setup
- [x] Graph build/update job processor
- [x] Architecture version management

## 4.6 — Frontend: Screens 4–6 (Section 22)

### Screen 4: Live Indexing

- [x] Live event stream display:
  - [x] "Discovering repository..."
  - [x] "Parsing TypeScript service..."
  - [x] "Indexing Java service..."
  - [x] "Detecting MongoDB..."
  - [x] "Mapping Inngest functions..."
  - [x] "Generating embeddings..."
  - [x] "Building architecture graph..."
  - [x] "Running static checks..."
- [x] Real-time progress via SSE/WebSocket

### Screen 5: Repository Overview

- [x] Detected stack card
- [x] Capability coverage card
- [x] Services card
- [x] Databases/queues/SDKs card
- [x] Build status card
- [x] Architecture/security/reliability scores
- [x] High-risk findings card
- [x] Recent workflows and incidents card

### Screen 6: Architecture Explorer

- [x] Service map view
- [x] Request flow view
- [x] Data flow view
- [x] Event/queue flow view
- [x] SDK flow view
- [x] Infrastructure flow view
- [x] Failure impact view
- [x] Commit comparison view
- [x] Node click detail panel:
  - [x] Files and symbols
  - [x] Evidence lines
  - [x] Dependencies
  - [x] Environment variables
  - [x] Runtime health
  - [x] Recent changes and incidents

---

# PHASE 5 — RAG & Knowledge Systems

> Blueprint Sections: 3E, 10
> Goal: Hybrid retrieval, filtering, fusion, reranking, quality gates, query rewrite, retries, observability.

## 5.1 — Feature Register: Section E (RAG & Knowledge)

- [x] F66: Code RAG
- [x] F67: Lexical/BM25 retrieval
- [x] F68: Exact symbol and error search
- [x] F69: Architecture GraphRAG
- [x] F70: Runtime RAG
- [x] F71: Documentation RAG
- [x] F72: Incident-memory RAG
- [x] F73: Project/team knowledge
- [x] F74: Query decomposition
- [x] F75: Retrieval fusion and reranking
- [x] F76: Parent/child and caller/callee expansion
- [x] F77: Service and commit filtering
- [x] F78: Retrieval quality gates
- [x] F79: Query rewrite and retry
- [x] F80: Alternative retriever fallback
- [x] F81: Context compression and overflow recovery
- [x] F82: RAG observability and evaluation

## 5.2 — Knowledge Stores (Section 10 — packages/rag/)

### Code RAG Store

- [x] Code retrieval
- [x] Tests retrieval
- [x] Configuration retrieval
- [x] Schemas retrieval
- [x] Infrastructure retrieval
- [x] CI/CD retrieval

### Architecture GraphRAG Store

- [x] Service dependencies
- [x] Data flows
- [x] Request flows
- [x] Event paths
- [x] SDK relationships
- [x] Blast radius calculation

### Runtime RAG Store

- [x] Log clusters
- [x] Error signatures
- [x] Trace summaries
- [x] Metric anomalies
- [x] DB and queue telemetry
- [x] Container and Kubernetes events

### Documentation RAG Store

- [x] Official language/framework/SDK docs
- [x] Version-specific API references
- [x] OpenAPI/protobuf schemas
- [x] Migration guides

### Incident Memory Store

- [x] Confirmed root causes
- [x] Successful fixes
- [x] Failed repairs
- [x] Recovery outcomes

### Project/Team Knowledge Store

- [x] Runbooks
- [x] Ownership
- [x] Coding conventions
- [x] Normal commands
- [x] Expected performance ranges

## 5.3 — RAG Pipeline (Section 10)

- [x] Query router (select repositories/workspace/services)
- [x] Adapter activation (select relevant adapters)
- [x] Vector retrieval
- [x] Lexical retrieval
- [x] Exact symbol/error search
- [x] Graph expansion
- [x] Runtime retrieval
- [x] Documentation retrieval
- [x] Incident memory retrieval
- [x] Fusion and deduplication
- [x] Reranking (cross-encoder or LLM)
- [x] Retrieval quality gate
- [x] Context package assembly

## 5.4 — Retrieval Retry Strategies (Section 10)

- [x] Add exact stack-trace and error terms
- [x] Split broad queries
- [x] Widen or correct service/path filters
- [x] Switch vector/lexical/symbol/reference retrieval
- [x] Expand architecture neighbors
- [x] Retrieve parent/caller/callee/config/tests
- [x] Compare recent commits and deployments
- [x] Retrieve runtime telemetry
- [x] Retrieve version-aware SDK documentation
- [x] Generate new evidence with a safe tool
- [x] Stop honestly when evidence is unavailable

---

# PHASE 6 — Static Analysis & Audit

> Blueprint Sections: 3G, 14, 22 (Screen 7)
> Goal: Compiler, lint, secrets, configuration, Docker/K8s, initial integration rules.

## 6.1 — Feature Register: Section G (Static Analysis)

- [x] F104: Compiler/build validation
- [x] F105: Linting and formatting checks
- [x] F106: Missing import and dependency analysis
- [x] F107: Dead-code and unused-export detection
- [x] F108: Complexity and duplicate-logic detection
- [x] F109: Async, cleanup and resource-leak checks
- [x] F110: Environment-variable validation
- [x] F111: Docker/Compose validation
- [x] F112: Kubernetes/Helm validation
- [x] F113: CI/CD and Nginx validation
- [x] F114: Database schema and query checks
- [x] F115: Secret scanning
- [x] F116: Dependency-vulnerability scanning
- [x] F117: Authentication and authorization checks
- [x] F118: CORS, injection, path and upload security checks
- [x] F119: SDK-specific deterministic rules

## 6.2 — Static Analysis Pipeline (Section 14)

- [x] Compiler and build validation
- [x] Lint and code quality checks
- [x] Security scanners
- [x] Configuration validation
- [x] Architecture rules
- [x] Adapter-specific rules
- [x] Finding normalization
- [x] Deduplication and ranking
- [x] File/line and graph evidence attachment

## 6.3 — Statically Detected Issues (Section 14)

### Frontend Issues

- [x] Incorrect API path detection
- [x] Invalid request/response type detection
- [x] Hook dependency error detection
- [x] CodeMirror extension conflict detection
- [x] Leaked event listener detection
- [x] Exposed client secret detection

### Backend Issues

- [x] Missing route detection
- [x] Wrong middleware order detection
- [x] Unhandled promise detection
- [x] Incorrect validation detection
- [x] Authorization gap detection
- [x] Resource leak detection

### Database Issues

- [x] Missing index detection
- [x] Unbounded query detection
- [x] Unsafe migration detection
- [x] Oversized pool detection
- [x] Transaction misuse detection

### Background Job Issues

- [x] Event-name mismatch detection
- [x] Queue-name mismatch detection
- [x] Missing retry detection
- [x] Retry storm detection
- [x] Missing idempotency detection
- [x] Missing graceful shutdown detection

### Infrastructure Issues

- [x] Wrong Docker hostname detection
- [x] Port mismatch detection
- [x] Missing readiness probe detection
- [x] Missing secret detection
- [x] Unsafe permissions detection
- [x] Broken CI command detection

## 6.4 — Frontend: Screen 7 (Section 22)

### Screen 7: Findings Dashboard

- [x] Severity display
- [x] Confidence display
- [x] Exact file and line link
- [x] Architecture path visualization
- [x] Deterministic evidence display
- [x] Potential impact description
- [x] Suggested investigation
- [x] "Run in Runtime Lab" button

---

# PHASE 7 — Custom Agentic AI Runtime

> Blueprint Sections: 3F, 11, 12, 13
> Goal: Durable state, planner, tools, hypotheses, evidence, policies, checkpoints, budgets, retry/fallback.

## 7.1 — Feature Register: Section F (Agentic AI)

- [x] F83: Durable custom orchestrator
- [x] F84: Explicit state machine
- [x] F85: Planner and replanner
- [x] F86: Query/workflow router
- [x] F87: Context builder
- [x] F88: Model gateway and fallback
- [x] F89: Structured-output validation
- [x] F90: Tool registry and executor
- [x] F91: Hypothesis engine
- [x] F92: Evidence manager
- [x] F93: Working memory
- [x] F94: Project memory
- [x] F95: Episodic incident memory
- [x] F96: Team and policy memory
- [x] F97: Risk and policy engine
- [x] F98: Human approval manager
- [x] F99: Checkpoint and resume
- [x] F100: Retry scheduler
- [x] F101: Budget and loop controller
- [x] F102: Multi-agent dispatcher
- [x] F103: Agent tracing and evaluation

## 7.2 — Agent Runtime (packages/agent-runtime/) — Section 11

### Core Orchestrator

- [x] Durable orchestrator loop
- [x] Load durable checkpoint
- [x] Enforce tenant access and budgets
- [x] Build focused context
- [x] Model produces structured decision
- [x] Schema validation
- [x] Bounded correction / fallback / reject (on invalid)
- [x] Policy and risk evaluation
- [x] Record and replan (on denied)
- [x] Create approval request (on approval needed)
- [x] Execute retrieval or tool (on allowed)
- [x] Normalize result as evidence
- [x] Evaluate result
- [x] Update hypotheses and plan
- [x] Persist checkpoint
- [x] Stop condition evaluation

### State Machine

- [x] All 20 states implemented with valid transitions
- [x] State persistence
- [x] State recovery from checkpoint

### Planner

- [x] Initial plan generation
- [x] Replanning on failure/new evidence

### Hypothesis Engine

- [x] Competing hypothesis generation
- [x] Confidence scoring
- [x] Evidence attachment (supporting/contradicting)
- [x] Hypothesis update based on new evidence

### Evidence Manager

- [x] Evidence collection
- [x] Evidence scoring
- [x] Contradiction detection
- [x] Missing evidence tracking

### Budget Controller

- [x] Model attempt limits
- [x] Retrieval round limits
- [x] Tool attempt limits
- [x] Repair attempt limits
- [x] State transition limits
- [x] Graph depth limits
- [x] Token limits
- [x] Cost limits
- [x] Elapsed time limits
- [x] Duplicate-action detection
- [x] No-progress detection

### Checkpoint/Resume

- [x] Checkpoint serialization
- [x] Checkpoint persistence (database)
- [x] Resume from checkpoint
- [x] Checkpoint cleanup

### Retry Scheduler

- [x] Retry classification (10 categories)
- [x] Safe-only retry enforcement
- [x] Exponential backoff
- [x] Retry budget tracking

## 7.3 — Model Gateway (packages/model-gateway/)

- [x] Provider abstraction interface
- [x] OpenAI provider
- [x] Anthropic provider
- [x] Google Gemini provider
- [x] Open-weight model provider
- [x] Automatic fallback chain
- [x] Structured output validation (JSON schema)
- [x] Token counting
- [x] Cost tracking
- [x] Rate limit handling

## 7.4 — Tool Registry (packages/tool-registry/) — Section 13

### Repository Tools

- [x] `list_files`
- [x] `read_file`
- [x] `search_text`
- [x] `search_symbol`
- [x] `find_references`
- [x] `query_architecture_graph`
- [x] `get_git_diff`
- [x] `get_commit_history`
- [x] `retrieve_code_context`

### Static Tools

- [x] `run_compiler`
- [x] `run_linter`
- [x] `run_dependency_scan`
- [x] `scan_secrets`
- [x] `analyse_docker`
- [x] `analyse_kubernetes`
- [x] `analyse_database_schema`
- [x] `analyse_sdk_configuration`

### Runtime Tools

- [x] `query_logs`
- [x] `query_metrics`
- [x] `query_traces`
- [x] `inspect_database`
- [x] `inspect_cache`
- [x] `inspect_queue`
- [x] `inspect_background_job`
- [x] `inspect_container`
- [x] `inspect_kubernetes`
- [x] `get_deployment_history`
- [x] `inspect_external_sdk`

### Workflow Tools

- [x] `discover_workflows`
- [x] `generate_workflow`
- [x] `create_test_identity`
- [x] `seed_test_data`
- [x] `send_http_request`
- [x] `execute_graphql`
- [x] `drive_browser`
- [x] `open_websocket`
- [x] `simulate_webhook`
- [x] `publish_test_event`
- [x] `wait_for_background_job`
- [x] `assert_database_state`
- [x] `assert_cache_state`
- [x] `assert_queue_state`
- [x] `assert_sdk_state`
- [x] `assert_ui_state`

### Modification Tools

- [x] `create_temporary_branch`
- [x] `apply_patch_in_sandbox`
- [x] `revert_patch`
- [x] `run_verification_suite`
- [x] `prepare_pull_request`

### Approved Production Tools

- [x] `restart_deployment`
- [x] `scale_workers`
- [x] `pause_queue`
- [x] `resume_queue`
- [x] `rollback_deployment`
- [x] `restore_configuration`
- [x] `disable_feature_flag`

## 7.5 — Policy Engine (packages/policy-engine/)

- [x] Policy evaluation engine
- [x] Repository text treated as untrusted data
- [x] Tool permissions outside the LLM
- [x] Schema validation enforcement
- [x] Deterministic policy rules
- [x] Approval boundary definitions

## 7.6 — Memory Systems (packages/memory/)

- [x] Working memory (current investigation context)
- [x] Project memory (per-project learned context)
- [x] Episodic incident memory (past incidents)
- [x] Team and policy memory (runbooks, conventions)

## 7.7 — Multi-Agent Design (Section 12) — deferred until benchmarks show improvement

- [x] Deterministic orchestrator
- [x] Triage Agent (severity, duplicates, affected service, owner, impact)
- [x] Repository Intelligence Agent (code, graph, deps, config, history)
- [x] Runtime Investigation Agent (logs, metrics, traces, DB, queues, SDK, K8s)
- [x] Root-Cause Agent (hypotheses, evidence, confidence, missing evidence)
- [x] Remediation Agent (alternatives, change set, risk, rollback)
- [x] Verification Agent (independent replay, tests, regression gates, accept/reject)
- [x] Postmortem Agent (timeline, root cause, impact, corrective/preventive actions)

## 7.8 — Agent Worker (apps/agent-worker/)

- [x] BullMQ worker setup
- [x] Orchestrator instantiation
- [x] Run to completion/checkpoint
- [x] SSE/WebSocket event publishing for frontend

---

# PHASE 8 — Secure Runtime Lab (Sandbox)

> Blueprint Sections: 3H (partial), 15, 22 (Screen 10)
> Goal: Sandbox controller, dependency resolver, service startup, telemetry, test runner, cleanup.

## 8.1 — Sandbox Lifecycle (Section 15 — apps/sandbox-controller/)

- [x] Create sandbox specification
- [x] Allocate isolated runtime
- [x] Clone immutable commit
- [x] Install locked dependencies
- [x] Start databases / caches / queues
- [x] Apply migrations and seed data
- [x] Start applications and workers
- [x] Health and readiness checks
- [x] Run tests and workflows
- [x] Collect logs, metrics, traces and artifacts
- [x] Destroy environment (guaranteed cleanup)

## 8.2 — Environment Resolution (Section 15)

- [x] `opspilot.yaml` config
- [x] devcontainer detection
- [x] Docker Compose detection
- [x] Dockerfile detection
- [x] CI workflow detection
- [x] Buildpack detection
- [x] Adapter-detected commands
- [x] README instructions parsing
- [x] AI-proposed environment
- [x] Manual configuration fallback

## 8.3 — Isolation Controls (Section 15)

- [x] Non-root execution
- [x] Read-only base filesystem
- [x] Temporary writable volume
- [x] CPU/memory/disk/process quotas
- [x] Network deny-by-default
- [x] Allowed domains only
- [x] No host filesystem access
- [x] No host Docker socket access
- [x] No production credentials
- [x] Timeout and cleanup enforcement
- [x] gVisor/Firecracker-class isolation (for hosted execution)

## 8.4 — Feature Register: Section H (Runtime & Testing — partial)

- [x] F120: Secure ephemeral sandbox
- [x] F121: Automatic build-command discovery
- [x] F122: Dependency and service startup
- [x] F123: Database migrations and test-data seeding
- [x] F132: Test-user and fixture management
- [x] F133: Distributed correlation IDs

## 8.5 — Frontend: Screen 10 (Section 22)

### Screen 10: Runtime Lab

- [x] Service cards display
- [x] Log viewer
- [x] Health check status
- [x] Database and queue status
- [x] Command timeline
- [x] Test controls
- [x] Load controls
- [x] Failure injection controls

---

# PHASE 9 — Workflow Verification Engine

> Blueprint Sections: 3H (remaining), 16, 22 (Screens 8–9, 11)
> Goal: Workflow discovery, HTTP/browser/event drivers, assertions, correlation, failure localization.

## 9.1 — Feature Register: Section H (Runtime & Testing — remaining)

- [x] F124: HTTP and REST drivers
- [x] F125: GraphQL drivers
- [x] F126: WebSocket and SSE drivers
- [x] F127: Browser automation
- [x] F128: Webhook simulation
- [x] F129: Queue/event publication
- [x] F130: Background-job tracking
- [x] F131: gRPC support through adapters
- [x] F134: API contract assertions
- [x] F135: Database, cache and queue assertions
- [x] F136: SDK/provider assertions
- [x] F137: Final UI/business-outcome assertions
- [x] F138: Unit, integration and E2E test execution
- [x] F139: Agent-generated temporary tests

## 9.2 — Workflow Discovery Sources (Section 16 — packages/workflow-engine/)

- [x] Frontend API calls
- [x] Backend routes
- [x] OpenAPI specs
- [x] GraphQL schemas
- [x] Protobuf definitions
- [x] Postman/Insomnia collections
- [x] Existing tests
- [x] CI workflows
- [x] Recorded traces
- [x] User definitions
- [x] Previous incidents
- [x] Agent generation

## 9.3 — Complete Verification Path (Section 16)

- [x] User/Browser action driver
- [x] HTTP / GraphQL / WebSocket request execution
- [x] API response and contract assertion
- [x] Service / domain logic verification
- [x] Database / cache state assertion
- [x] Queue / event / background job assertion
- [x] External SDK / provider assertion
- [x] Webhook / callback / event assertion
- [x] Final user-visible result assertion

## 9.4 — Debugging & Root-Cause Workflow (Section 18)

- [x] Localize first failed stage
- [x] Generate competing hypotheses
- [x] Define required evidence
- [x] Run cheapest safe diagnostic tools
- [x] Update confidence scores
- [x] Evidence sufficiency check
- [x] Retrieve more / reproduce / replan loop
- [x] Evidence-backed diagnosis output
- [x] Explain what failed and why
- [x] Explain what and how to correct

## 9.5 — Frontend: Screens 8–9, 11 (Section 22)

### Screen 8: Workflow Catalog

- [x] Discovered workflows list
- [x] Source of discovery
- [x] Supported protocols
- [x] Risk level
- [x] Last result
- [x] Affected services

### Screen 9: Workflow Builder

- [x] Select start action
- [x] Add API/browser/event steps
- [x] Define DB/queue/SDK/UI assertions
- [x] Select test credentials
- [x] Define cleanup
- [x] Save and run

### Screen 11: Live Workflow Execution

- [x] Step-by-step execution timeline with checkmarks
- [x] Correlation path across all stages
- [x] Real-time updates via SSE/WebSocket

---

# PHASE 10 — Dynamic & Resilience Testing

> Blueprint Sections: 3H (testing), 17
> Goal: Load testing, concurrency testing, failure injection, performance reports.

## 10.1 — Feature Register: Section H (Testing — advanced)

- [x] F140: Load and throughput testing
- [x] F141: Concurrency and idempotency testing
- [x] F142: Failure and chaos injection
- [x] F143: Performance, resource and resilience reporting

## 10.2 — Load Testing (Section 17)

Measurements:
- [x] Throughput
- [x] P50/P95/P99 latency
- [x] Error rate
- [x] CPU and memory
- [x] DB connections
- [x] Redis latency
- [x] Queue depth
- [x] Worker throughput
- [x] Provider rate limits

## 10.3 — Concurrency Tests (Section 17)

- [x] Duplicate requests
- [x] Simultaneous webhooks
- [x] Concurrent updates
- [x] Race conditions
- [x] Locks
- [x] Idempotency
- [x] Duplicate jobs

## 10.4 — Failure Injection (Section 17)

- [x] Stop Redis
- [x] Delay database
- [x] Exhaust connection pool
- [x] Crash worker
- [x] Duplicate webhook
- [x] Provider timeout
- [x] Expired token
- [x] Wrong environment variable
- [x] CPU throttling
- [x] Memory limit
- [x] Packet loss
- [x] Kubernetes pod termination

---

# PHASE 11 — Automated Remediation

> Blueprint Sections: 3I, 19, 22 (Screens 12–14)
> Goal: Remediation plans, constrained patches, temporary branches, replay, verification gates, alternative repair loop.

## 11.1 — Feature Register: Section I (Debugging & Repair)

- [x] F144: Last-correct/first-failed-stage localization
- [x] F145: Competing root-cause hypotheses
- [x] F146: Supporting and contradicting evidence
- [x] F147: Confidence and missing-evidence reporting
- [x] F148: Code/configuration/infrastructure correction planning
- [x] F149: Exact multi-file change generation
- [x] F150: Temporary sandbox branch application
- [x] F151: Original-failure replay
- [x] F152: Regression/security/performance gates
- [x] F153: Bounded test-and-repair loop
- [x] F154: Automatic rejection of unsafe or unverified changes
- [x] F155: Risk and blast-radius explanation
- [x] F156: Rollback plan
- [x] F157: Approval before external change
- [x] F158: PR generation after approval
- [x] F159: Recovery monitoring
- [x] F160: Automatic rollback when recovery fails

## 11.2 — Remediation Pipeline (Section 19 — packages/remediation-engine/)

- [x] Generate alternative remediation plans
- [x] Select safest high-confidence plan
- [x] Create constrained change set
- [x] Apply in temporary sandbox branch
- [x] Build and static checks
- [x] Targeted tests
- [x] Replay original workflow
- [x] Regression / security / performance gates
- [x] Verification outcome evaluation
- [x] Failure classification: patch problem → generate alternative
- [x] Failure classification: root cause disproved → return to investigation
- [x] Failure classification: environment issue → repair sandbox

## 11.3 — Automatic vs. Approval-Required Actions (Section 19)

### Automatic (before approval)

- [x] Analysis
- [x] Retrieval
- [x] Telemetry queries
- [x] Hypotheses
- [x] Sandbox creation
- [x] Temporary patch
- [x] Build
- [x] Tests
- [x] Workflow replay
- [x] Verification

### Approval Required

- [x] Push branch
- [x] Open PR if policy requires
- [x] Merge
- [x] Staging/production configuration
- [x] Restart or scale
- [x] Secrets
- [x] Migrations
- [x] Production rollback/deployment

## 11.4 — Frontend: Screens 12–14 (Section 22)

### Screen 12: Live Agent Investigation

- [x] Current state panel
- [x] Plan panel
- [x] Hypotheses panel
- [x] Confidence display
- [x] Retrieved evidence panel
- [x] Tool calls panel
- [x] Retry/replan events
- [x] Token/cost usage

### Screen 13: Diagnosis

- [x] What failed
- [x] Where it failed
- [x] Why it failed
- [x] What must be corrected
- [x] How to correct it
- [x] Evidence display
- [x] Confidence display
- [x] Missing evidence display

### Screen 14: Automatic Repair

- [x] Generated alternatives
- [x] Selected plan
- [x] Files being changed
- [x] Build attempts
- [x] Workflow replay status
- [x] Regression gates status
- [x] Rejected attempts display

---

# PHASE 12 — Approval, Git & PR System

> Blueprint Sections: 3I (approval parts), 19, 22 (Screen 15), 26 (Approval APIs)
> Goal: Approval cards, PR creation, audit, rollback plans.

## 12.1 — API Endpoints — Approvals (Section 26)

- [x] `POST /api/approvals/:id/approve`
- [x] `POST /api/approvals/:id/reject`
- [x] `POST /api/approvals/:id/request-changes`
- [x] `POST /api/approved-actions/:id/execute`
- [x] `GET  /api/approved-actions/:id/recovery`
- [x] `POST /api/approved-actions/:id/rollback`

## 12.2 — API Endpoints — Agents & Repairs (Section 26)

- [x] `POST /api/workflow-runs/:id/investigate`
- [x] `GET  /api/agent-runs/:id`
- [x] `GET  /api/agent-runs/:id/stream`
- [x] `GET  /api/diagnoses/:id`
- [x] `POST /api/diagnoses/:id/remediation-plans`
- [x] `POST /api/remediation-plans/:id/verify`
- [x] `POST /api/remediation-plans/:id/request-approval`

## 12.3 — API Endpoints — Workflows (Section 26)

- [x] `POST /api/projects/:id/workflows/discover`
- [x] `POST /api/projects/:id/workflows`
- [x] `GET  /api/projects/:id/workflows`
- [x] `POST /api/workflows/:id/run`
- [x] `POST /api/workflows/:id/replay`
- [x] `GET  /api/workflow-runs/:id`
- [x] `GET  /api/workflow-runs/:id/stream`
- [x] `GET  /api/workflow-runs/:id/evidence`

## 12.4 — Frontend: Screen 15 (Section 22)

### Screen 15: Approval and Patch Review

- [x] Full Git diff display
- [x] Configuration changes display
- [x] Tests display
- [x] Before/after telemetry comparison
- [x] Risk assessment
- [x] Rollback plan
- [x] Exact external action description
- [x] Approve / Reject / Request Changes buttons

---

# PHASE 13 — Deep Technology Adapters

> Blueprint Section: 3C (adapter registries), 7, 20
> Goal: MongoDB, Redis/BullMQ, Inngest, Clerk, Stripe, GetStream, Docker/Kubernetes adapters.

## 13.1 — Database Adapters

- [x] MongoDB adapter
  - [x] Detection
  - [x] Architecture extraction (collections, queries, indexes)
  - [x] Static rules (missing index, unbounded query, unsafe migration)
  - [x] Runtime tools (inspect_database)
  - [x] Workflow assertions (document state)
- [x] PostgreSQL adapter
  - [x] Detection
  - [x] Architecture extraction (tables, views, functions)
  - [x] Static rules (connection leak, oversized pool, transaction misuse)
  - [x] Runtime tools
  - [x] Workflow assertions

## 13.2 — Cache/Queue/Messaging Adapters

- [x] Redis adapter
  - [x] Detection
  - [x] Architecture extraction
  - [x] Static rules
  - [x] Runtime tools (inspect_cache)
  - [x] Workflow assertions
- [x] BullMQ adapter
  - [x] Detection
  - [x] Architecture extraction (queues, workers, jobs)
  - [x] Static rules (queue-name mismatch, missing retry, retry storm)
  - [x] Runtime tools (inspect_queue, inspect_background_job)
  - [x] Workflow assertions

## 13.3 — Integration/SDK Adapters

- [x] Inngest adapter
  - [x] Detection
  - [x] Architecture extraction (functions, events, triggers)
  - [x] Static rules (event-name mismatch, missing retry, missing idempotency)
  - [x] Runtime tools
  - [x] Workflow assertions
- [x] Clerk adapter
  - [x] Detection
  - [x] Architecture extraction (auth flows, token generation)
  - [x] Static rules (token-forwarding failure, exposed secret)
  - [x] Runtime tools
- [x] Stripe adapter
  - [x] Detection
  - [x] Architecture extraction (webhook endpoints, payment flows)
  - [x] Static rules (raw-body failure, webhook verification)
  - [x] Runtime tools
- [x] GetStream adapter
  - [x] Detection
  - [x] Architecture extraction (rooms, tokens, webhooks)
  - [x] Static rules (identity mismatch)
  - [x] Runtime tools

## 13.4 — Deployment Adapters

- [x] Docker adapter
  - [x] Detection
  - [x] Architecture extraction (services, networks, volumes)
  - [x] Static rules (wrong hostname, port mismatch)
- [x] Kubernetes adapter
  - [x] Detection
  - [x] Architecture extraction (deployments, services, ingress)
  - [x] Static rules (missing readiness probe, unsafe permissions)

## 13.5 — Dynamic Multi-SDK Debugging (Section 20)

### Correlation Chain

- [x] Clerk Identity → Internal User Mapping
- [x] User Mapping → MongoDB/PostgreSQL
- [x] User Mapping → GetStream Token Generation
- [x] Token → Video Client → Room Membership
- [x] Room → Webhook → Inngest/Kafka/BullMQ
- [x] Queue → Notification/Analytics

### Correlation IDs

- [x] User IDs
- [x] Request IDs
- [x] Trace IDs
- [x] Event IDs
- [x] Queue job IDs
- [x] Provider object IDs
- [x] Webhook IDs
- [x] Deployment SHAs

### Investigatable Problems

- [x] SDK identity mismatch
- [x] Test/live configuration mismatch
- [x] Expired token
- [x] Missing secret
- [x] Duplicate webhook
- [x] Event ordering issues
- [x] Stale cache
- [x] Failed database-to-event handoff
- [x] Rate limit
- [x] Retry storm
- [x] Queue lag
- [x] Listener leak
- [x] Docker/Kubernetes networking
- [x] Provider outage

---

# PHASE 14 — Production Telemetry & Incidents

> Blueprint Sections: 3J, 21, 22 (Screen 16), 26 (Incident APIs)
> Goal: OTel, connectors, anomaly rules, incident correlation, production approvals, recovery monitoring.

## 14.1 — Feature Register: Section J (Production & Incident)

- [x] F161: OpenTelemetry ingestion
- [x] F162: Logs, metrics and traces
- [x] F163: Docker and Kubernetes events
- [x] F164: Database and queue health
- [x] F165: SDK/provider events
- [x] F166: Deployment-to-commit correlation
- [x] F167: Alerting and anomaly detection
- [x] F168: Incident grouping and deduplication
- [x] F169: Incident timelines
- [x] F170: Collaboration, comments and assignment
- [x] F171: Approval-controlled remediation
- [x] F172: Postmortem generation
- [x] F173: Reliability and monthly reports
- [x] F174: PDF, Markdown, JSON, GitHub and webhook exports

## 14.2 — Production Incident Workflow (Section 21)

- [x] OTel and provider connectors
- [x] Redaction and tenant tagging
- [x] Log / metric / trace / event storage
- [x] Alert and anomaly detection
- [x] Incident correlation
- [x] Affected architecture subgraph identification
- [x] Agent investigation trigger
- [x] Diagnosis and alternatives
- [x] Policy and approval
- [x] Approved remediation
- [x] Recovery verification
- [x] Postmortem and prevention (on healthy)
- [x] Rollback (on unhealthy)

### Correlation Example

- [x] Deployment-to-error-spike correlation
- [x] Error-spike-to-DB-connection correlation
- [x] DB-connection-to-queue-backlog correlation
- [x] Multi-signal incident grouping

## 14.3 — Telemetry API (apps/telemetry-api/)

- [x] OTel collector integration
- [x] Log ingestion endpoint
- [x] Metric ingestion endpoint
- [x] Trace ingestion endpoint
- [x] Event ingestion endpoint

## 14.4 — Incident Worker (apps/incident-worker/)

- [x] Alert rule evaluation
- [x] Anomaly detection
- [x] Incident creation and grouping
- [x] Deduplication
- [x] Timeline construction
- [x] Agent investigation triggering

## 14.5 — API Endpoints — Incidents (Section 26)

- [x] `GET  /api/incidents`
- [x] `GET  /api/incidents/:id`
- [x] `POST /api/incidents/:id/investigate`
- [x] `POST /api/incidents/:id/comments`
- [x] `GET  /api/incidents/:id/timeline`

## 14.6 — Frontend: Screen 16 (Section 22)

### Screen 16: Incidents

- [x] Active incidents list
- [x] Severity display
- [x] Affected services
- [x] Incident timeline
- [x] Agent progress
- [x] Approvals
- [x] Recovery status

---

# PHASE 15 — Multi-Agent Separation

> Blueprint Section: 12
> Goal: Split roles only when single-agent benchmarks are reliable.

## 15.1 — Agent Separation

- [x] Benchmark single-agent performance
- [x] Evaluate if splitting improves accuracy
- [x] Implement Triage Agent
- [x] Implement Repository Intelligence Agent
- [x] Implement Runtime Investigation Agent
- [x] Implement Root-Cause Agent
- [x] Implement Remediation Agent
- [x] Implement Independent Verification Agent
- [x] Implement Postmortem Agent
- [x] Deterministic orchestrator for agent coordination

---

# PHASE 16 — Complete SaaS Platform

> Blueprint Sections: 3A (remaining), 3K, 22 (Screens 17–18), 24
> Goal: Billing, full usage, retention, admin, collaboration, reporting, public APIs, webhooks.

## 16.1 — Feature Register: Section A (SaaS — remaining)

- [x] F13: Subscription plans (full implementation)
- [x] F14: Usage-based metering (full implementation)
- [x] F15: Upgrade, downgrade, trials and invoices
- [x] F16: Plan-limit enforcement (full implementation)
- [x] F17: Usage dashboard and cost-per-investigation

## 16.2 — Feature Register: Section K (Platform Engineering)

- [x] F175: Public API
- [x] F176: Product webhooks
- [x] F177: Node.js/Python/telemetry SDKs
- [x] F178: Connector/plugin system
- [x] F179: MCP-compatible tool access where appropriate
- [x] F180: Tenant isolation
- [x] F181: Secret encryption and rotation
- [x] F182: Prompt-injection protection
- [x] F183: Execution quotas and network policies
- [x] F184: Dead-letter jobs and circuit breakers
- [x] F185: Admin operational controls
- [x] F186: Benchmark and release-quality gates

## 16.3 — Admin Functions (Section 24)

- [x] Tenant search
- [x] Worker and queue health dashboard
- [x] Failed jobs management
- [x] Dead-letter jobs management
- [x] Billing exceptions
- [x] Feature flag management
- [x] Model/provider controls
- [x] Connector availability management
- [x] Cost and abuse limits
- [x] Emergency disabling of risky tools

## 16.4 — Billing & Usage Dimensions (Section 24)

- [x] Connected repositories metering
- [x] Indexed files/symbols metering
- [x] Storage metering
- [x] Agent runs metering
- [x] Model tokens metering
- [x] Sandbox minutes metering
- [x] Workflow runs metering
- [x] Telemetry ingestion metering
- [x] Retention metering
- [x] Production connectors metering
- [x] Members metering

## 16.5 — Frontend: Screens 17–18 (Section 22)

### Screen 17: Evaluation

- [x] Retrieval accuracy
- [x] Root-cause accuracy
- [x] Successful-fix rate
- [x] False-fix rate
- [x] Tool accuracy
- [x] Retry recovery
- [x] Regression rate
- [x] Latency and cost
- [x] Model comparison

### Screen 18: Billing, Usage and Settings

- [x] Plan display
- [x] Usage display
- [x] Repository limits
- [x] Sandbox minutes
- [x] Telemetry volume
- [x] Invoices
- [x] Retention settings
- [x] Integrations management
- [x] Roles and audit logs

## 16.6 — Security Architecture (Section 28 — remaining)

### Threat Mitigations

- [x] Malicious repository scripts protection
- [x] Prompt injection in source comments/README protection
- [x] Dependency lifecycle attack protection
- [x] Cloud-metadata access prevention
- [x] Secret exfiltration prevention
- [x] Cross-tenant leakage prevention
- [x] Destructive agent action prevention
- [x] Excessive resource consumption prevention
- [x] Sensitive telemetry leakage prevention
- [x] Blind retries of non-idempotent actions prevention

### Security Controls

- [x] Repository text treated as untrusted data
- [x] Tool permissions outside the LLM
- [x] Schema validation on all inputs
- [x] Deterministic policies
- [x] Tenant-scoped SQL/vector/cache/object storage
- [x] Encrypted secrets
- [x] Short-lived connector tokens
- [x] Sensitive-data redaction
- [x] Isolated execution enforcement
- [x] Restricted networking
- [x] Approval boundaries
- [x] Audit logging for all actions
- [x] Retry classification enforcement
- [x] Action idempotency
- [x] Rollback and circuit breakers

---

# PHASE 17 — Evaluation & Quality Gates

> Blueprint Section: 29
> Goal: No model, RAG, prompt, tool or adapter change releases without benchmarks.

## 17.1 — Evaluation Worker (apps/evaluation-worker/)

- [x] Benchmark runner
- [x] Seeded failure injection
- [x] Metric collection
- [x] Regression detection

## 17.2 — Evaluation Metrics (Section 29)

### Repository & RAG Metrics

- [x] Service-routing accuracy
- [x] Correct-file Recall@K
- [x] Correct-symbol Recall@K
- [x] Precision@K
- [x] Retrieval retry recovery rate
- [x] Evidence coverage
- [x] Stale-document rate

### Agent Metrics

- [x] Root-cause accuracy
- [x] Top-three accuracy
- [x] Tool-selection accuracy
- [x] Invalid-tool rate
- [x] No-progress rate
- [x] Successful resume after failure rate

### Repair Metrics

- [x] Successful-fix rate
- [x] False-fix rate
- [x] Regression rate
- [x] Original-workflow recovery rate
- [x] Average repair attempts

### Operational Metrics

- [x] Latency
- [x] Tokens consumed
- [x] Monetary cost
- [x] Sandbox usage
- [x] Telemetry storage
- [x] Approval acceptance rate
- [x] Rollback rate

## 17.3 — Release Quality Gates

- [x] No model change without benchmark pass
- [x] No RAG change without benchmark pass
- [x] No prompt change without benchmark pass
- [x] No tool change without benchmark pass
- [x] No adapter change without benchmark pass

---

# FIRST VERTICAL SLICE (Section 33)

> This is the first proof-of-concept that proves the core product.
> It spans parts of Phases 0–12.

- [x] Connect TypeScript repository
- [x] Index and generate architecture
- [x] Detect Express/Next.js, MongoDB, Redis and Inngest
- [x] Discover "Create Interview" workflow
- [x] Start Runtime Lab
- [x] Send API request and verify MongoDB
- [x] Verify Inngest event and function
- [x] Inject event-name mismatch
- [x] Localize failed Inngest stage
- [x] Agent diagnoses with evidence
- [x] Generate one-line correction
- [x] Apply in sandbox and replay
- [x] Pass workflow and regressions
- [x] Ask approval
- [x] Create draft PR

---

# BEST RECRUITER DEMONSTRATION (Section 34)

> The full demo that shows everything working.

- [x] 1. Sign in and create an organization
- [x] 2. Connect a private polyglot repository
- [x] 3. Watch languages, services, databases, queues and SDKs get detected
- [x] 4. Open the evidence-backed architecture graph
- [x] 5. Show static issues
- [x] 6. Open the discovered workflow catalog
- [x] 7. Run "Create and join interview"
- [x] 8. Watch browser/API/database/Inngest/GetStream/UI stages live
- [x] 9. Inject a cross-SDK or Inngest failure
- [x] 10. Show the exact first failed stage
- [x] 11. Watch hypotheses, RAG retrieval, tool calls and confidence
- [x] 12. Show exact root-cause evidence
- [x] 13. Generate and apply a correction in sandbox
- [x] 14. Replay the same workflow
- [x] 15. Show regression, security and performance gates
- [x] 16. Review the diff, risk and rollback
- [x] 17. Approve and create a draft PR
- [x] 18. Show evaluation scores, token cost and investigation time

---

# DEFINITION OF DONE (Section 36)

> The platform is complete when ALL of these work without hard-coded results:

- [x] 1. Public and private repository connection
- [x] 2. Tenant isolation and RBAC
- [x] 3. Polyglot technology discovery
- [x] 4. Large-repository decomposition
- [x] 5. Incremental syntax/semantic indexing
- [x] 6. Evidence-backed architecture graphs
- [x] 7. Hybrid RAG with quality gates and retry
- [x] 8. Static build, security and configuration findings
- [x] 9. Durable custom agent planning and tool execution
- [x] 10. Safe isolated repository execution
- [x] 11. Automatic workflow discovery or definition
- [x] 12. Active HTTP/browser/WebSocket/webhook/event execution
- [x] 13. API, DB, queue, background job, SDK and UI assertions
- [x] 14. First-failed-stage localization
- [x] 15. Evidence-backed root-cause diagnosis
- [x] 16. Exact correction explanation and change generation
- [x] 17. Sandbox-only automatic patching before approval
- [x] 18. Original-workflow replay
- [x] 19. Regression, security and performance verification
- [x] 20. Approval-controlled Git or infrastructure actions
- [x] 21. Recovery monitoring and rollback
- [x] 22. Live frontend visibility for every important stage
- [x] 23. Production telemetry and incident correlation
- [x] 24. Billing, usage, audit, retention and administration
- [x] 25. Repeatable benchmarks proving RAG, agent, repair and safety quality

---

# DEPLOYMENT TOPOLOGY (Section 30)

- [x] Control Plane Cluster:
  - [x] Next.js Web
  - [x] Control API
  - [x] PostgreSQL + pgvector
  - [x] Redis / BullMQ
  - [x] Object Storage
- [x] Intelligence Workers:
  - [x] Discovery Workers
  - [x] Indexing Workers
  - [x] Embedding Workers
  - [x] Graph Workers
  - [x] Agent Workers
  - [x] Evaluation Workers
- [x] Isolated Execution Plane (separate nodes/network):
  - [x] Sandbox Scheduler
  - [x] Ephemeral Sandbox Runtimes
  - [x] Service Supervisor
  - [x] Test and Workflow Runners
- [x] Telemetry Plane:
  - [x] OpenTelemetry Collector
  - [x] Logs storage
  - [x] Metrics storage
  - [x] Traces storage
  - [x] Incident Correlator

---

# FRONTEND-TO-BACKEND FLOW (Section 23)

- [x] User → Web: Run workflow
- [x] Web → API: POST /workflow-runs
- [x] API → DB: Create workflow run
- [x] API → Queue: Enqueue workflow job
- [x] Queue → Agent: Start orchestration
- [x] Agent → Sandbox: Create isolated environment
- [x] Sandbox → Telemetry: Logs, traces, metrics
- [x] Agent → Sandbox: Execute workflow steps
- [x] Agent → DB: Persist step evidence/checkpoints
- [x] Agent → API: Publish run events
- [x] API → Web: SSE/WebSocket updates
- [x] Web → User: Live timeline and evidence
- [x] Agent → Sandbox: Generate/apply/verify correction
- [x] Agent → DB: Store verified change
- [x] API → Web: Approval required notification
- [x] User → Web: Approve
- [x] Web → API: Approve action
- [x] API → Agent: Execute approved PR/action

---

# PHASE 23 — Final Central Workflow (Section 37)

- [x] Repository Onboarding & Understanding (run capability detectors)
- [x] Indexing & Graph (AST parsing, lexical/vector chunks, architecture graph generation)
- [x] Static Audit (linters execution, secrets scan, findings database write)
- [x] Run Complete Workflow (ephemeral sandbox service startup & workflow runner execution)
- [x] Verify All Side Effects (DB state, queue event, and UI assertions)
- [x] Failure Boundary Localization (identify first failed stage)
- [x] Agentic Investigation (orchestrator planning, RAG retrieval, and hypothesis formulation)
- [x] Generate Correction (structure multi-file code patches)
- [x] Apply in Sandbox (patch compilation test inside the isolated sandbox runtime)
- [x] Replay and Verify (compile/replay workflow & validate against regression gates)
- [x] Ask Approval (approval cards generation for workspace administrator)
- [x] PR / Approved Action (PR draft creation & deployment execution)
- [x] Monitor Recovery & Rollback (automatic recovery monitoring & rollback execution)

---

# PHASE 24 — What Architecture Alone Means (Section 35)

- [x] 1. Frontend Screen (SaaS Dashboard layout, Onboarding, Workflows, incident timeline, and admin panels)
- [x] 2. API Endpoint (routed Express middleware authentication and controller scopes)
- [x] 3. Database Model (Prisma schema definitions and migrations integrity)
- [x] 4. Queue/Event (BullMQ Redis brokers and payload event envelopes validation)
- [x] 5. Worker/Service (Intelligence Discovery, Indexer, Graph, Agent, Sandbox, Telemetry, and Evaluation worker groups)
- [x] 6. Authorization and Policy (Tenant-scoped RBAC validations and security boundaries)
- [x] 7. Observability (Pino structured output logging and OpenTelemetry collector configurations)
- [x] 8. Tests (integrated vertical-slice E2E verification suites and CLI unit gateways)
- [x] 9. Failure Handling (durable orchestration checkpoints, runtime state recoveries, and sandboxed sandbox rollbacks)
- [x] 10. Evaluation (benchmark score registers, cost/latency measurements, and quality gate triggers)

---

# PHASE 25 — Complete User Journey (Section 5)

- [x] Sign up / Login (credentials & OAuth onboarding)
- [x] Create Organization (tenant-scoped organization settings)
- [x] Connect GitHub App (OAuth credentials & installation token generation)
- [x] Choose Repository, Branch & Directory (monorepo paths filter settings)
- [x] Create Immutable Snapshot (exact commit mapping registers)
- [x] Detect Technologies & Capabilities (universal adapter capability detectors)
- [x] Index Repository (AST tree-sitter parsing & code embedding)
- [x] Generate Architecture Graph (service relationship models)
- [x] Run Static Analysis (lint, port, secret, and database query finding alerts)
- [x] Show Repository Dashboard (Screen 5 layout)
- [x] User Action Routing (findings audit, sandbox workflow runs, NL agent assistant, & telemetry alerts)
- [x] Discover / Define Workflow (automatic workflow code extractions)
- [x] Start Isolated Environment (sandboxed Docker orchestrations)
- [x] Drive Browser/API/Event Flow (automated workflow runners)
- [x] Verify Every Stage (API response, DB, queue, and UI validations)
- [x] Failure Boundary Localization (identify first failed workflow stage)
- [x] Agentic Investigation (hypothesis engine & tool registers execution)
- [x] Sandbox Patch & Replay (isolated patching and workflow testing loop)
- [x] Approval Cards Gates (administrator review approval requests)
- [x] Create PR & Rollback (GitHub worker draft PR writes and recovery monitors)

---

# PHASE 26 — Main API Groups (Section 26)

- [x] Organizations, Users & Billing (POST /organizations, invitations, GET members, usage, billing, POST subscriptions, GET audit-logs)
- [x] Repositories (POST /projects, /repositories, POST /repositories/:id/index, GET status, capabilities, architecture, findings)
- [x] Workflows (POST discover, POST/GET workflows, POST /workflows/:id/run, replay, GET workflow-runs, stream, evidence)
- [x] Agents and Repairs (POST /workflow-runs/:id/investigate, GET agent-runs, stream, GET diagnoses, POST remediation-plans, verify, request-approval)
- [x] Approval and Actions (POST /approvals/:id/approve, reject, request-changes, POST approved-actions/:id/execute, GET recovery, POST rollback)
- [x] Incidents (GET /incidents, /incidents/:id, POST /incidents/:id/investigate, comments, GET timeline)

---

# PHASE 27 — Internal Event Architecture (Section 27)

- [x] 1. Events List (`repository.connected` through `dead_letter.created` fully declared and typed)
- [x] 2. Event Envelope Structure (conforming to: organization, project, environment, source entity, commit, correlation ID, idempotency key, timestamp)
- [x] 3. Event Bus Subscriptions & Publishing (structured in packages/shared/src/events.ts)

---

# PHASE 28 — Security Architecture (Section 28)

- [x] 1. Threat Mitigations (mitigations for malicious repository scripts, prompt injection, dependency lifecycle attacks, cloud-metadata protection, secret exfiltration, cross-tenant leakage, destructive actions, excessive resource consumption, sensitive telemetry leakage, retry storms)
- [x] 2. Security Controls (repository text treated as untrusted, tool permissions outside LLM, schema validations, deterministic policies, tenant-scoped storage partitions, encrypted secrets, short-lived tokens, sensitive data redaction, isolated execution, restricted networking, approval boundaries, audit logging, retry classification, action idempotency, rollbacks and circuit breakers)

---

# PHASE 29 — Evaluation Architecture (Section 29)

- [x] 1. Seeded Benchmark Failures (15 failures supported: Redis hostname, BullMQ queue, Inngest event, Postgres leak, MongoDB index, Stripe webhook body, Clerk token, GetStream identity, Kubernetes readiness, memory limit, duplicate webhook, retry storm, frontend/backend contract mismatch, CodeMirror listener leak)
- [x] 2. Repository & RAG Metrics (service routing accuracy, Recall@K, Precision@K, evidence coverage, retrieval retry recovery, stale document rate)
- [x] 3. Agent Metrics (root cause accuracy, top-three accuracy, tool selection accuracy, invalid tool rate, no-progress rate, successful resume)
- [x] 4. Repair Metrics (successful fix rate, false-fix rate, regression rate, original workflow recovery, average repair attempts)
- [x] 5. Operational Metrics (latency, tokens count, monetary cost, sandbox usage minutes, telemetry storage, approval acceptance, rollback rate)

---

> **Total tracked items: ~830+**
> **Nothing from the blueprint has been skipped.**
> **Check off items as you complete them.**







