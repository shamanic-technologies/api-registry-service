import express from "express";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { registerMcpEndpoint } from "./mcp.js";
import cors from "cors";
import { requireApiKey, requireIdentity } from "./auth.js";

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
    if (req.method === "GET" && ["/services", "/openapi", "/llm-context"].includes(req.path)) return next();
    if (req.method === "GET" && req.path.startsWith("/openapi/")) return next();
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

// Fetch all specs at once
app.get("/openapi", async (_req, res) => {
  const results = await Promise.all(
    Object.entries(SERVICES).map(async ([name, { baseUrl }]) => {
      const result = await fetchSpec(baseUrl);
      return {
        name,
        baseUrl,
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
    Object.entries(SERVICES).map(async ([name, { baseUrl }]) => {
      const result = await fetchSpec(baseUrl);

      if (result.error || !result.spec) {
        return {
          service: name,
          baseUrl,
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
        baseUrl,
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

    // Forward identity headers (force-overwrite to prevent spoofing)
    fetchHeaders["x-org-id"] = req.headers["x-org-id"] as string;
    fetchHeaders["x-user-id"] = req.headers["x-user-id"] as string;

    // Forward workflow tracking headers if present
    for (const h of ["x-campaign-id", "x-brand-id", "x-workflow-name"] as const) {
      const val = req.headers[h];
      if (val) fetchHeaders[h] = val as string;
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
