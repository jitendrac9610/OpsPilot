# OpsPilot AI v4

OpsPilot AI is an adapter-driven, agentic AI software reliability platform that indexes source code, validates workflows in isolated sandboxes, diagnoses root causes, and generates verified git/infrastructure remediation PRs.

## Tech Stack
- **Monorepo**: pnpm workspaces + Turborepo + TypeScript
- **Frontend**: Next.js
- **Backend Services**: Node.js microservices + BullMQ
- **Data & Cache**: PostgreSQL (with pgvector) + Redis + Object Storage (MinIO)
- **Isolation**: Ephemeral sandboxes

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
