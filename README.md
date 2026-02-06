# API Registry Service

Open-source service that aggregates OpenAPI specs from multiple microservices into a single queryable registry. Designed for LLM-powered service-to-service discovery.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Registry Service                         │
│              https://your-registry.railway.app                   │
│                                                                  │
│  Aggregates OpenAPI specs from all registered services.          │
│  Provides discovery via REST endpoints and MCP tools.            │
│                                                                  │
│  REST: GET /llm-context                                          │
│  MCP:  POST /mcp (tools: list_services, search_endpoints, etc.) │
└──────────────────────────┬──────────────────────────────────────┘
                           │ fetches /openapi.json from each service
                           │
     ┌─────────┬───────────┼───────────┬──────────┬──────────┐
     ▼         ▼           ▼           ▼          ▼          ▼
  service-a  service-b  service-c  service-d  service-e  ... (N total)
```

## Quick Start

```bash
npm install
npm run dev
```

## Configuration

Register your services via environment variables:

### Option 1: Single env var (comma-separated)

```bash
SERVICES="api-service=https://api.example.com,campaign-service=https://campaign.example.com"
```

### Option 2: Individual env vars

```bash
SERVICE_API_URL=https://api.example.com
SERVICE_CAMPAIGN_URL=https://campaign.example.com
SERVICE_EMAIL_GEN_URL=https://emailgen.example.com
```

Each registered service must expose `GET /openapi.json` returning an OpenAPI 3.0 spec.

## Authentication

Protect the registry with an API key:

```bash
API_REGISTRY_SERVICE_API_KEY=your-secret-key-here
```

All endpoints except `/health` require authentication via:
- Header: `X-API-Key: your-secret-key-here`
- Or: `Authorization: Bearer your-secret-key-here`

If `API_REGISTRY_SERVICE_API_KEY` is not set, all routes are open (development mode).

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/services` | List all registered services |
| `GET` | `/openapi` | Fetch all OpenAPI specs |
| `GET` | `/openapi/:service` | Fetch spec for one service |
| `GET` | `/llm-context` | LLM-friendly summary of all endpoints |
| `POST` | `/refresh` | Refresh all cached specs |
| `POST` | `/refresh/:service` | Refresh one service's spec |

### `/llm-context` Response Format

Optimized for LLM consumption — compact, no header params, includes body fields:

```json
{
  "_description": "API Registry - Use this to discover available services and their endpoints.",
  "_usage": "To call an endpoint: send HTTP request to {baseUrl}{path}",
  "services": [
    {
      "service": "api-service",
      "baseUrl": "https://api.example.com",
      "title": "My API",
      "endpoints": [
        {
          "method": "POST",
          "path": "/v1/campaigns",
          "summary": "Create a campaign",
          "bodyFields": ["name", "brandUrl"]
        }
      ]
    }
  ]
}
```

## MCP Server

The registry exposes an MCP (Model Context Protocol) endpoint at `/mcp` so LLMs can discover and call APIs directly.

### MCP Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `list_services` | Returns all service names + base URLs | First step — see what exists |
| `get_all_endpoints` | Compact summary of every endpoint across all services | You need an overview of the full API surface |
| `search_endpoints` | Search by keyword (e.g. "campaign", "email", "brand") | You know what you need but not which service has it |
| `get_service_spec` | Full OpenAPI spec for one service | You need complete details (params, body, responses) |
| `call_api` | Actually call an endpoint on any service | Execute an API call through the registry |

### Connect from Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "api-registry": {
      "url": "https://your-registry.railway.app/mcp",
      "headers": {
        "X-API-Key": "your-secret-key-here"
      }
    }
  }
}
```

## How to Discover Services

### Option 1: MCP (Recommended for LLMs)

Connect to the registry's MCP endpoint and use its tools:

```
MCP endpoint: https://your-registry.railway.app/mcp
```

### Option 2: REST

```bash
# Get a compact summary of all services and endpoints (LLM-optimized)
curl -H "X-API-Key: your-key" https://your-registry.railway.app/llm-context

# Get the full OpenAPI spec for a specific service
curl -H "X-API-Key: your-key" https://your-registry.railway.app/openapi/campaign-service

# List all registered services
curl -H "X-API-Key: your-key" https://your-registry.railway.app/services
```

## How to Call Another Service

### From your service code (Node.js/TypeScript)

```typescript
// Direct HTTP call to another service
const response = await fetch("https://campaign-service.example.com/internal/campaigns", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.INTERNAL_API_KEY,  // if required
  },
  body: JSON.stringify({ name: "My Campaign", brandUrl: "https://example.com" }),
});
const data = await response.json();
```

### Key conventions

1. **Internal endpoints** are prefixed with `/internal/` — no user auth required, only service-to-service auth
2. **Public endpoints** are prefixed with `/v1/` — require Bearer JWT or API key
3. **Service auth** uses `X-API-Key` header when calling between services

## Workflow for an LLM Agent

When you need to interact with another service:

```
1. DISCOVER  →  Call registry: search_endpoints("what you need")
                or: get_all_endpoints() for full overview

2. UNDERSTAND →  Call registry: get_service_spec("service-name")
                 Read the OpenAPI spec to understand params, body, responses

3. CALL       →  Make HTTP request to the service directly
                 Use the baseUrl from the registry + the path from the spec
                 Include required headers (X-API-Key, etc.)

4. HANDLE     →  Parse the JSON response
                 Handle errors (4xx, 5xx) gracefully
```

## Adding OpenAPI to Your Services (Required)

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

The spec is regenerated at every build — always matches the deployed code.

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
    appId: "myapp",
    eventType: "campaign_created",
    userId: userId,
  }),
}).catch(err => console.warn("Lifecycle email failed:", err.message));
```

## Deploy on Railway

1. Connect this repo to Railway
2. Set `SERVICES` env var with your service URLs
3. Set `API_REGISTRY_SERVICE_API_KEY` for auth
4. Deploy

## Caching

Specs are cached for 5 minutes. Use `POST /refresh` to force a cache refresh.

### Refreshing the Registry

After deploying a service with updated endpoints, the registry cache refreshes automatically within 5 minutes. To force an immediate refresh:

```bash
# Refresh one service
curl -X POST -H "X-API-Key: your-key" https://your-registry.railway.app/refresh/campaign-service

# Refresh all
curl -X POST -H "X-API-Key: your-key" https://your-registry.railway.app/refresh
```

Add this to your CI/CD pipeline as a post-deploy webhook for instant discovery.

## License

MIT
