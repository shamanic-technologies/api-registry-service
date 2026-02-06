# Service Communication Guide

This document explains how microservices in the MCPFactory platform discover and call each other. Every LLM agent operating within a service MUST read this before making inter-service calls.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Registry Service                         │
│                 https://registry.mcpfactory.org                  │
│                                                                  │
│  Aggregates OpenAPI specs from all 24 services.                 │
│  Provides discovery via REST endpoints and MCP tools.            │
│                                                                  │
│  REST: GET /llm-context                                          │
│  MCP:  POST /mcp (tools: list_services, search_endpoints, etc.) │
└──────────────────────────┬──────────────────────────────────────┘
                           │ fetches /openapi.json from each service
                           │
     ┌─────────┬───────────┼───────────┬──────────┬──────────┐
     ▼         ▼           ▼           ▼          ▼          ▼
  api-service  campaign  emailgen   brand     lead      ... (24 total)
```

## How to Discover Available Services

### Option 1: MCP (Recommended for LLMs)

Connect to the registry's MCP endpoint and use its tools:

```
MCP endpoint: https://registry.mcpfactory.org/mcp
```

Available tools:

| Tool | What it does | When to use |
|------|-------------|-------------|
| `list_services` | Returns all service names + base URLs | First step — see what exists |
| `get_all_endpoints` | Compact summary of every endpoint across all services | You need an overview of the full API surface |
| `search_endpoints` | Search by keyword (e.g. "campaign", "email", "brand") | You know what you need but not which service has it |
| `get_service_spec` | Full OpenAPI spec for one service | You need complete details (params, body, responses) |
| `call_api` | Actually call an endpoint on any service | Execute an API call through the registry |

### Option 2: REST

```bash
# Get a compact summary of all services and endpoints (LLM-optimized)
curl https://registry.mcpfactory.org/llm-context

# Get the full OpenAPI spec for a specific service
curl https://registry.mcpfactory.org/openapi/campaign-service

# List all registered services
curl https://registry.mcpfactory.org/services
```

## How to Call Another Service

### From your service code (Node.js/TypeScript)

```typescript
// Direct HTTP call to another service on Railway private network
const response = await fetch("https://campaign-service.railway.internal/internal/campaigns", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.INTERNAL_API_KEY,  // if required
    "x-clerk-org-id": orgId,                     // pass org context
  },
  body: JSON.stringify({ name: "My Campaign", brandUrl: "https://example.com" }),
});
const data = await response.json();
```

### Key conventions

1. **Internal endpoints** are prefixed with `/internal/` — no user auth required, only service-to-service auth
2. **Public endpoints** are prefixed with `/v1/` — require Bearer JWT or API key
3. **Org context** is passed via `x-clerk-org-id` header
4. **User context** is passed via `x-clerk-user-id` header (optional)
5. **Service auth** uses `X-API-Key` header when calling external services

### Service URLs

On Railway private network, services are accessible at:
```
http://<service-name>.railway.internal:<port>
```

Public URLs follow the pattern:
```
https://<service-name>.mcpfactory.org
```

## How to Expose Your Service's API (Required)

Every service MUST expose `GET /openapi.json` so the registry can discover it.

### Step 1: Install swagger-autogen

```bash
npm install swagger-autogen
npm install -D tsx  # if not already installed
```

### Step 2: Create `scripts/generate-openapi.ts`

```typescript
import swaggerAutogen from "swagger-autogen";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const doc = {
  info: {
    title: "YOUR SERVICE NAME",              // e.g. "Campaign Service"
    description: "WHAT THIS SERVICE DOES",   // e.g. "Manages campaign lifecycle"
    version: "1.0.0",
  },
  host: process.env.SERVICE_URL || "http://localhost:3000",
  basePath: "/",
  schemes: ["https"],
};

const outputFile = join(projectRoot, "openapi.json");
const routes = [join(projectRoot, "src/index.ts")];

swaggerAutogen({ openapi: "3.0.0" })(outputFile, routes, doc).then(() => {
  console.log("openapi.json generated");
});
```

### Step 3: Add the endpoint to your Express app

```typescript
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: pnpm generate:openapi" });
  }
});
```

### Step 4: Update package.json scripts

```json
{
  "scripts": {
    "build": "tsc && pnpm generate:openapi",
    "generate:openapi": "tsx scripts/generate-openapi.ts"
  }
}
```

### Step 5: Add to .gitignore

```
openapi.json
```

The spec is regenerated at every build → always matches the deployed code.

## Service Directory

| Service | Base URL | Description |
|---------|----------|-------------|
| api-service | https://api.mcpfactory.org | API Gateway — routes external requests to internal services |
| mcp-service | https://mcp.mcpfactory.org | MCP server for Claude/AI client integration |
| campaign-service | (Railway internal) | Campaign CRUD, scheduling, lifecycle |
| emailgen-service | (Railway internal) | Email generation via LLM |
| lead-service | (Railway internal) | Lead search and enrichment via Apollo |
| client-service | (Railway internal) | User and org management |
| brand-service | https://brand.mcpfactory.org | Brand profiles and ICP extraction |
| key-service | (Railway internal) | BYOK key storage and decryption |
| runs-service | (Railway internal) | Run tracking and cost accounting |
| scraping-service | (Railway internal) | Website scraping and analysis |
| lifecycle-service | (Railway internal) | Transactional and lifecycle emails |
| reply-qualification-service | (Railway internal) | AI-powered email reply classification |
| worker-service | (Railway internal) | Background job processing |
| performance-service | https://performance.mcpfactory.org | Public leaderboard dashboard |
| api-registry | https://registry.mcpfactory.org | This registry — service discovery |

> **Note**: This list may not be exhaustive. Always call `list_services` on the registry for the current list.

## Workflow for an LLM Agent

When you need to interact with another service:

```
1. DISCOVER  →  Call registry: search_endpoints("what you need")
                or: get_all_endpoints() for full overview

2. UNDERSTAND →  Call registry: get_service_spec("service-name")
                 Read the OpenAPI spec to understand params, body, responses

3. CALL       →  Make HTTP request to the service directly
                 Use the baseUrl from the registry + the path from the spec
                 Include required headers (x-clerk-org-id, X-API-Key, etc.)

4. HANDLE     →  Parse the JSON response
                 Handle errors (4xx, 5xx) gracefully
```

## Common Patterns

### Enriching data from multiple services

```typescript
// 1. Get campaigns from campaign-service
const campaigns = await fetch(`${CAMPAIGN_URL}/internal/campaigns`, { headers }).then(r => r.json());

// 2. Get run costs from runs-service
const runIds = campaigns.map(c => c.runId);
const runs = await fetch(`${RUNS_URL}/internal/runs/batch`, {
  method: "POST",
  headers,
  body: JSON.stringify({ ids: runIds }),
}).then(r => r.json());

// 3. Merge
const enriched = campaigns.map(c => ({
  ...c,
  cost: runs[c.runId]?.totalCostInUsdCents,
}));
```

### Fire-and-forget (lifecycle emails, notifications)

```typescript
// Don't await — fire and forget
fetch(`${LIFECYCLE_URL}/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    appId: "mcpfactory",
    eventType: "campaign_created",
    clerkUserId: userId,
  }),
}).catch(err => console.warn("Lifecycle email failed:", err.message));
```

## Refreshing the Registry

After deploying a service with updated endpoints, the registry cache refreshes automatically within 5 minutes. To force an immediate refresh:

```bash
# Refresh one service
curl -X POST https://registry.mcpfactory.org/refresh/campaign-service

# Refresh all
curl -X POST https://registry.mcpfactory.org/refresh
```

Add this to your CI/CD pipeline as a post-deploy webhook for instant discovery.
