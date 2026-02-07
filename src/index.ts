import express from "express";
import { registerMcpEndpoint } from "./mcp.js";
import cors from "cors";
import { requireApiKey } from "./auth.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  requireApiKey(req, res, next);
});

// Service registry: name → base URL
// Configure via SERVICES env var: "service1=https://url1,service2=https://url2"
// Or via individual env vars: SERVICE_<NAME>_URL=https://url
function loadServices(): Record<string, string> {
  const services: Record<string, string> = {};

  // Method 1: SERVICES env var (comma-separated)
  const servicesEnv = process.env.SERVICES;
  if (servicesEnv) {
    for (const entry of servicesEnv.split(",")) {
      const [name, url] = entry.trim().split("=");
      if (name && url) {
        services[name.trim()] = url.trim();
      }
    }
  }

  // Method 2: Individual env vars matching these patterns:
  //   SERVICE_<NAME>_URL, <NAME>_SERVICE_URL, <NAME>_WORKER_URL
  for (const [key, value] of Object.entries(process.env)) {
    const match =
      key.match(/^SERVICE_(.+)_URL$/) ||
      key.match(/^(.+)_SERVICE_URL$/) ||
      key.match(/^(.+)_WORKER_URL$/);
    if (match && value) {
      const name = match[1].toLowerCase().replace(/_/g, "-");
      services[name] = value;
    }
  }

  return services;
}

const SERVICES = loadServices();

// Cache for fetched specs
interface CachedSpec {
  spec: unknown;
  fetchedAt: number;
  error?: string;
}

const specsCache = new Map<string, CachedSpec>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchSpec(name: string, url: string): Promise<CachedSpec> {
  const cached = specsCache.get(name);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const response = await fetch(`${url}/openapi.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const spec = await response.json();
    const entry: CachedSpec = { spec, fetchedAt: Date.now() };
    specsCache.set(name, entry);
    return entry;
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : "Unknown error";
    const entry: CachedSpec = {
      spec: null,
      fetchedAt: Date.now(),
      error,
    };
    specsCache.set(name, entry);
    return entry;
  }
}

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
  const services = Object.entries(SERVICES).map(([name, url]) => ({
    name,
    baseUrl: url,
    openapiUrl: `${url}/openapi.json`,
  }));
  res.json({ services });
});

// Get OpenAPI spec for a specific service
app.get("/openapi/:service", async (req, res) => {
  const { service } = req.params;
  const url = SERVICES[service];

  if (!url) {
    return res.status(404).json({
      error: `Service "${service}" not found`,
      available: Object.keys(SERVICES),
    });
  }

  const result = await fetchSpec(service, url);
  if (result.error) {
    return res.status(502).json({
      error: `Failed to fetch spec for "${service}"`,
      detail: result.error,
    });
  }

  res.json(result.spec);
});

// Fetch all specs at once
app.get("/openapi", async (_req, res) => {
  const results = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const result = await fetchSpec(name, url);
      return {
        name,
        baseUrl: url,
        spec: result.spec,
        error: result.error || null,
      };
    })
  );
  res.json({ services: results });
});

// LLM-friendly context endpoint
// Returns a compact summary of all services and their endpoints
app.get("/llm-context", async (_req, res) => {
  const services = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const result = await fetchSpec(name, url);

      if (result.error || !result.spec) {
        return {
          service: name,
          baseUrl: url,
          error: result.error,
          endpoints: [],
        };
      }

      const spec = result.spec as {
        info?: { title?: string; description?: string };
        paths?: Record<string, Record<string, {
          summary?: string;
          description?: string;
          parameters?: Array<{
            name: string;
            in: string;
            required?: boolean;
            schema?: { type?: string };
          }>;
          requestBody?: {
            content?: {
              "application/json"?: {
                schema?: { properties?: Record<string, unknown> };
              };
            };
          };
        }>>;
      };

      const endpoints = Object.entries(spec.paths || {}).flatMap(
        ([path, methods]) =>
          Object.entries(methods)
            .filter(([method]) =>
              ["get", "post", "put", "patch", "delete"].includes(method)
            )
            .map(([method, details]) => {
              const params = (details.parameters || [])
                .filter((p) => p.in !== "header")
                .map((p) => ({
                  name: p.name,
                  in: p.in,
                  required: p.required || false,
                  type: p.schema?.type,
                }));

              const bodyProps = details.requestBody?.content?.[
                "application/json"
              ]?.schema?.properties
                ? Object.keys(
                    details.requestBody.content["application/json"].schema
                      .properties
                  )
                : [];

              return {
                method: method.toUpperCase(),
                path,
                summary: details.summary || details.description || "",
                params: params.length > 0 ? params : undefined,
                bodyFields: bodyProps.length > 0 ? bodyProps : undefined,
              };
            })
      );

      return {
        service: name,
        baseUrl: url,
        title: spec.info?.title,
        description: spec.info?.description,
        endpoints,
      };
    })
  );

  res.json({
    _description:
      "API Registry - Use this to discover available services and their endpoints. Each service exposes a REST API.",
    _usage:
      "To call an endpoint: send HTTP request to {baseUrl}{path} with the documented method, params, and body fields.",
    services,
  });
});

// Invalidate cache for a specific service (webhook from CI/CD)
app.post("/refresh/:service", async (req, res) => {
  const { service } = req.params;
  specsCache.delete(service);

  const url = SERVICES[service];
  if (!url) {
    return res.status(404).json({ error: `Service "${service}" not found` });
  }

  const result = await fetchSpec(service, url);
  res.json({
    service,
    refreshed: true,
    error: result.error || null,
  });
});

// Refresh all caches
app.post("/refresh", async (_req, res) => {
  specsCache.clear();

  const results = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const result = await fetchSpec(name, url);
      return { name, error: result.error || null };
    })
  );

  res.json({ refreshed: true, services: results });
});

// Register MCP endpoint for LLM access
registerMcpEndpoint(app, {
  getServices: () => SERVICES,
  fetchSpec: async (name, url) => {
    const result = await fetchSpec(name, url);
    return { spec: result.spec, error: result.error };
  },
});
app.listen(Number(PORT), "::", () => {
  console.log(`API Registry running on port ${PORT}`);
  console.log(
    `Registered services: ${Object.keys(SERVICES).join(", ") || "(none - configure via SERVICES env var)"}`
  );
});

export default app;
