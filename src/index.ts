import express from "express";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { registerMcpEndpoint } from "./mcp.js";
import cors from "cors";
import { requireApiKey, requireIdentity, cleanHeader } from "./auth.js";
import { EndpointSearchIndex, derivePathGroup } from "./search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/openapi.json") return next();
  requireApiKey(req, res, () => {
    // MCP endpoint handles identity internally (optional headers captured during session init)
    if (req.path === "/mcp") return next();
    // Read-only spec/discovery endpoints: identity adds no value for service-to-service calls
    if (req.method === "GET" && ["/services", "/llm-context", "/search"].includes(req.path)) return next();
    if (req.method === "GET" && (req.path.startsWith("/openapi/") || req.path.startsWith("/llm-context/"))) return next();
    requireIdentity(req, res, next);
  });
});

// Service registry: name → { baseUrl, apiKey? }
// Configure via SERVICES env var: "service1=https://url1,service2=https://url2"
// Or via individual env vars: <NAME>_SERVICE_URL + <NAME>_SERVICE_API_KEY
export interface ServiceEntry {
  baseUrl: string;
  apiKey?: string;
}

function loadServices(): Record<string, ServiceEntry> {
  const services: Record<string, ServiceEntry> = {};

  // Method 1: SERVICES env var (comma-separated, no API key support)
  const servicesEnv = process.env.SERVICES;
  if (servicesEnv) {
    for (const entry of servicesEnv.split(",")) {
      const [name, url] = entry.trim().split("=");
      if (name && url) {
        services[name.trim()] = { baseUrl: url.trim() };
      }
    }
  }

  // Method 2: Individual env vars: <NAME>_SERVICE_URL or <NAME>_WORKER_URL
  // Also looks up matching <NAME>_SERVICE_API_KEY for each service
  // Skip RAILWAY_* vars to avoid picking up Railway internal env vars
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("RAILWAY_")) continue;
    const match =
      key.match(/^(.+)_SERVICE_URL$/) ||
      key.match(/^(.+)_WORKER_URL$/);
    if (match && value) {
      const prefix = match[1];
      const name = prefix.toLowerCase().replace(/_/g, "-");
      const apiKey = process.env[`${prefix}_SERVICE_API_KEY`];
      services[name] = { baseUrl: value, apiKey };
    }
  }

  // Validate URLs: must have a protocol, skip invalid entries
  for (const [name, entry] of Object.entries(services)) {
    if (!/^https?:\/\//.test(entry.baseUrl)) {
      console.warn(`Skipping service "${name}": invalid URL "${entry.baseUrl}" (missing https:// prefix)`);
      delete services[name];
    }
  }

  return services;
}

const SERVICES = loadServices();

async function fetchSpec(url: string): Promise<{ spec: unknown; error?: string }> {
  try {
    const response = await fetch(`${url}/openapi.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const spec = await response.json();
    return { spec };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : "Unknown error";
    return { spec: null, error };
  }
}

// OpenAPI spec
app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated" });
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "api-registry",
    registeredServices: Object.keys(SERVICES).length,
  });
});

// List all registered services
app.get("/services", (_req, res) => {
  const services = Object.entries(SERVICES).map(([name, { baseUrl }]) => ({
    name,
    baseUrl,
    openapiUrl: `${baseUrl}/openapi.json`,
  }));
  res.json({ services });
});

// Get OpenAPI spec for a specific service
app.get("/openapi/:service", async (req, res) => {
  const { service } = req.params;
  const entry = SERVICES[service];

  if (!entry) {
    return res.status(404).json({
      error: `Service "${service}" not found`,
      available: Object.keys(SERVICES),
    });
  }

  const result = await fetchSpec(entry.baseUrl);
  if (result.error) {
    return res.status(502).json({
      error: `Failed to fetch spec for "${service}"`,
      detail: result.error,
    });
  }

  res.json(result.spec);
});

// Search index with TTL cache (shared between REST and MCP via same logic)
const SEARCH_INDEX_TTL_MS = 60_000;
let cachedSearchIndex: EndpointSearchIndex | null = null;
let searchIndexBuiltAt = 0;

async function getOrBuildSearchIndex(): Promise<EndpointSearchIndex> {
  const now = Date.now();
  if (cachedSearchIndex && now - searchIndexBuiltAt < SEARCH_INDEX_TTL_MS) {
    return cachedSearchIndex;
  }

  const idx = new EndpointSearchIndex();
  await Promise.all(
    Object.entries(SERVICES).map(async ([name, { baseUrl }]) => {
      const result = await fetchSpec(baseUrl);
      if (result.error || !result.spec) return;
      const spec = result.spec as {
        paths?: Record<string, Record<string, {
          summary?: string;
          description?: string;
          requestBody?: {
            content?: { "application/json"?: { schema?: { properties?: Record<string, unknown> } } };
          };
          responses?: Record<string, {
            content?: { "application/json"?: { schema?: { properties?: Record<string, unknown>; $ref?: string } } };
          }>;
        }>>;
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
      };
      const schemas = spec.components?.schemas || {};

      for (const [path, methods] of Object.entries(spec.paths || {})) {
        for (const [method, details] of Object.entries(methods)) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
          const bodyProps = details.requestBody?.content?.["application/json"]?.schema?.properties
            ? Object.keys(details.requestBody.content["application/json"].schema.properties)
            : undefined;

          let responseFieldNames: string[] | undefined;
          const successResp = details.responses?.["200"] || details.responses?.["201"];
          if (successResp) {
            const respSchema = successResp.content?.["application/json"]?.schema;
            if (respSchema?.properties) {
              responseFieldNames = Object.keys(respSchema.properties);
            } else if (respSchema?.$ref) {
              const refName = respSchema.$ref.replace("#/components/schemas/", "");
              const resolved = schemas[refName];
              if (resolved?.properties) responseFieldNames = Object.keys(resolved.properties);
            }
          }

          idx.addEndpoint({
            service: name,
            method: method.toUpperCase(),
            path,
            summary: details.summary || details.description || "",
            bodyFields: bodyProps?.length ? bodyProps : undefined,
            responseFields: responseFieldNames?.length ? responseFieldNames : undefined,
            pathGroup: derivePathGroup(path),
          });
        }
      }
    })
  );

  cachedSearchIndex = idx;
  searchIndexBuiltAt = now;
  return idx;
}

// Search endpoints across all services (MiniSearch-powered ranked full-text search)
app.get("/search", async (req, res) => {
  const query = req.query.q as string;
  if (!query) {
    return res.status(400).json({ error: "Missing required query parameter: q" });
  }

  const service = req.query.service as string | undefined;
  const method = req.query.method as string | undefined;
  const pathPrefix = req.query.pathPrefix as string | undefined;
  const limitRaw = req.query.limit ? parseInt(req.query.limit as string) : undefined;
  const limit = limitRaw && !isNaN(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const idx = await getOrBuildSearchIndex();
  const results = idx.search({ query, service, method, pathPrefix, limit });

  res.json({
    query,
    resultCount: results.length,
    indexSize: idx.size,
    results,
  });
});

// LLM-friendly context endpoint
// Returns a lightweight overview of all services (name, description, endpoint count)
// Use GET /llm-context/:service for endpoint details of a specific service
app.get("/llm-context", async (_req, res) => {
  const services = await Promise.all(
    Object.entries(SERVICES).map(async ([name, { baseUrl }]) => {
      const result = await fetchSpec(baseUrl);

      if (result.error || !result.spec) {
        return { service: name, error: result.error, endpointCount: 0 };
      }

      const spec = result.spec as {
        info?: { title?: string; description?: string };
        paths?: Record<string, Record<string, unknown>>;
      };

      const endpointCount = Object.values(spec.paths || {}).reduce(
        (count, methods) =>
          count +
          Object.keys(methods).filter((m) =>
            ["get", "post", "put", "patch", "delete"].includes(m)
          ).length,
        0
      );

      return {
        service: name,
        title: spec.info?.title,
        description: spec.info?.description,
        endpointCount,
      };
    })
  );

  res.json({
    _description:
      "API Registry - Overview of all registered services. Use GET /llm-context/{service} for endpoint details.",
    _workflow:
      "1. GET /llm-context (overview) → 2. GET /llm-context/{service}?group=X (endpoints) → 3. GET /search?q=keyword (search) → 4. POST /call/{service} (execute)",
    serviceCount: services.length,
    services,
  });
});

// LLM-friendly endpoint list for a specific service
// Supports query filters: ?method=POST&group=campaigns&pathPrefix=/v1/campaigns
app.get("/llm-context/:service", async (req, res) => {
  const { service } = req.params;
  const entry = SERVICES[service];

  if (!entry) {
    return res.status(404).json({
      error: `Service "${service}" not found`,
      available: Object.keys(SERVICES),
    });
  }

  const result = await fetchSpec(entry.baseUrl);
  if (result.error || !result.spec) {
    return res.status(502).json({
      error: `Failed to fetch spec for "${service}"`,
      detail: result.error,
    });
  }

  const spec = result.spec as {
    info?: { title?: string; description?: string };
    paths?: Record<string, Record<string, {
      summary?: string;
      description?: string;
    }>>;
  };

  // Parse filters from query params
  const methodFilter = (req.query.method as string)?.toUpperCase();
  const groupFilter = req.query.group as string;
  const pathPrefixFilter = req.query.pathPrefix as string;

  let endpoints = Object.entries(spec.paths || {}).flatMap(
    ([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) =>
          ["get", "post", "put", "patch", "delete"].includes(method)
        )
        .map(([method, details]) => ({
          method: method.toUpperCase(),
          path,
          summary: details.summary || details.description || "",
          pathGroup: derivePathGroup(path),
        }))
  );

  // Apply filters
  if (methodFilter) {
    endpoints = endpoints.filter(ep => ep.method === methodFilter);
  }
  if (groupFilter) {
    endpoints = endpoints.filter(ep => ep.pathGroup === groupFilter.toLowerCase());
  }
  if (pathPrefixFilter) {
    endpoints = endpoints.filter(ep => ep.path.startsWith(pathPrefixFilter));
  }

  const isFiltered = !!(methodFilter || groupFilter || pathPrefixFilter);
  const useGrouped = !isFiltered && endpoints.length > 30;

  if (useGrouped) {
    // Group by path prefix for large services
    const groups: Record<string, Array<{ method: string; path: string; summary: string }>> = {};
    for (const ep of endpoints) {
      if (!groups[ep.pathGroup]) groups[ep.pathGroup] = [];
      groups[ep.pathGroup].push({ method: ep.method, path: ep.path, summary: ep.summary });
    }

    const groupSummary = Object.entries(groups).map(([name, eps]) => ({
      group: name,
      endpointCount: eps.length,
      endpoints: eps,
    }));

    return res.json({
      service,
      title: spec.info?.title,
      description: spec.info?.description,
      totalEndpoints: endpoints.length,
      groupCount: groupSummary.length,
      groups: groupSummary,
    });
  }

  res.json({
    service,
    title: spec.info?.title,
    description: spec.info?.description,
    endpointCount: endpoints.length,
    endpoints: endpoints.map(ep => ({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
    })),
  });
});

// Proxy endpoint: call any registered service with automatic API key injection
app.post("/call/:service", async (req, res) => {
  const { service } = req.params;
  const entry = SERVICES[service];

  if (!entry) {
    return res.status(404).json({
      error: `Service "${service}" not found`,
      available: Object.keys(SERVICES),
    });
  }

  const { method, path, body, headers: extraHeaders } = req.body;

  if (!method || !path) {
    return res.status(400).json({ error: "Missing required fields: method, path" });
  }

  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return res.status(400).json({ error: `Invalid method: ${method}` });
  }

  if (!path.startsWith("/")) {
    return res.status(400).json({ error: "Path must start with /" });
  }

  try {
    const url = `${entry.baseUrl}${path}`;
    const fetchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };

    // Forward identity headers (force-overwrite to prevent spoofing, clean trailing commas)
    const orgId = cleanHeader(req.headers["x-org-id"]);
    const userId = cleanHeader(req.headers["x-user-id"]);
    if (orgId) fetchHeaders["x-org-id"] = orgId;
    if (userId) fetchHeaders["x-user-id"] = userId;

    // Forward workflow tracking headers if present (clean trailing commas)
    for (const h of ["x-campaign-id", "x-brand-id", "x-workflow-slug", "x-feature-slug"] as const) {
      const val = cleanHeader(req.headers[h]);
      if (val) fetchHeaders[h] = val;
    }

    // Inject API key if available (force-overwrite any caller-provided key)
    if (entry.apiKey) {
      fetchHeaders["x-api-key"] = entry.apiKey;
    }

    const response = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body && ["POST", "PUT", "PATCH"].includes(method) ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const responseBody = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = responseBody;
    }

    res.status(200).json({
      status: response.status,
      ok: response.ok,
      data: parsed,
    });
  } catch (err: unknown) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Downstream request failed",
    });
  }
});

// Register MCP endpoint for LLM access
registerMcpEndpoint(app, {
  getServices: () => SERVICES,
  fetchSpec,
});
if (process.env.NODE_ENV !== "test") {
  app.listen(Number(PORT), "::", () => {
    console.log(`API Registry running on port ${PORT}`);
    console.log(
      `Registered services: ${Object.keys(SERVICES).join(", ") || "(none - configure via SERVICES env var)"}`
    );
  });
}

export default app;
