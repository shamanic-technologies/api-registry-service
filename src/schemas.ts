import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);
export const registry = new OpenAPIRegistry();

// -- Shared schemas --

const ServiceEntrySchema = z
  .object({
    name: z.string(),
    baseUrl: z.string(),
    openapiUrl: z.string(),
  })
  .openapi("ServiceEntry");

const ErrorSchema = z
  .object({
    error: z.string(),
    available: z.array(z.string()).optional(),
  })
  .openapi("Error");

const UnauthorizedErrorSchema = z
  .object({
    error: z.literal("Invalid or missing API key"),
  })
  .openapi("UnauthorizedError");

const unauthorizedResponse = {
  description: "Invalid or missing API key",
  content: { "application/json": { schema: UnauthorizedErrorSchema } },
} as const;

const MissingHeadersErrorSchema = z
  .object({
    error: z.literal("Missing required headers: x-org-id, x-user-id"),
  })
  .openapi("MissingHeadersError");

const badRequestIdentityResponse = {
  description: "Missing required identity headers",
  content: { "application/json": { schema: MissingHeadersErrorSchema } },
} as const;

const identityHeaders = [
  z.string().openapi({
    param: { name: "x-org-id", in: "header", required: true },
    description: "Internal org UUID from client-service",
  }),
  z.string().openapi({
    param: { name: "x-user-id", in: "header", required: true },
    description: "Internal user UUID from client-service",
  }),
];

const optionalIdentityHeaders = [
  z.string().optional().openapi({
    param: { name: "x-org-id", in: "header", required: false },
    description: "Internal org UUID from client-service (optional for read-only endpoints)",
  }),
  z.string().optional().openapi({
    param: { name: "x-user-id", in: "header", required: false },
    description: "Internal user UUID from client-service (optional for read-only endpoints)",
  }),
];

const workflowTrackingHeaders = [
  z.string().optional().openapi({
    param: { name: "x-campaign-id", in: "header", required: false },
    description: "Campaign identifier, injected automatically by workflow-service",
  }),
  z.string().optional().openapi({
    param: { name: "x-brand-id", in: "header", required: false },
    description:
      "Brand identifier(s), injected automatically by workflow-service. Supports CSV format for multi-brand campaigns (e.g. 'uuid1,uuid2,uuid3'). Single-brand campaigns send a single UUID.",
    example: "b1a2c3d4-0000-0000-0000-000000000001,b1a2c3d4-0000-0000-0000-000000000002",
  }),
  z.string().optional().openapi({
    param: { name: "x-workflow-slug", in: "header", required: false },
    description: "Slug of the executing workflow, injected automatically by workflow-service",
  }),
  z.string().optional().openapi({
    param: { name: "x-feature-slug", in: "header", required: false },
    description: "Feature slug identifier, propagated through the service chain",
  }),
];

// -- GET /health --

const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("api-registry"),
    registeredServices: z.number(),
  })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// -- GET /services --

const ServicesResponseSchema = z
  .object({
    services: z.array(ServiceEntrySchema),
  })
  .openapi("ServicesResponse");

registry.registerPath({
  method: "get",
  path: "/services",
  summary: "List all registered services",
  request: { headers: optionalIdentityHeaders },
  responses: {
    200: {
      description: "List of registered services",
      content: { "application/json": { schema: ServicesResponseSchema } },
    },
    401: unauthorizedResponse,
  },
});

// -- GET /openapi/:service --

const OpenApiSpecSchema = z
  .object({})
  .passthrough()
  .openapi("OpenApiSpec", { description: "An OpenAPI specification object" });

const ServiceSpecResultSchema = z
  .object({
    name: z.string(),
    baseUrl: z.string(),
    spec: OpenApiSpecSchema.nullable(),
    error: z.string().nullable(),
  })
  .openapi("ServiceSpecResult");

registry.registerPath({
  method: "get",
  path: "/openapi/{service}",
  summary: "Get OpenAPI spec for a specific service",
  request: {
    params: z.object({
      service: z.string().openapi({ description: "Service name" }),
    }),
    headers: optionalIdentityHeaders,
  },
  responses: {
    200: {
      description: "OpenAPI spec for the service",
      content: { "application/json": { schema: OpenApiSpecSchema } },
    },
    401: unauthorizedResponse,
    404: {
      description: "Service not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    502: {
      description: "Failed to fetch spec from upstream",
      content: {
        "application/json": {
          schema: z
            .object({ error: z.string(), detail: z.string() })
            .openapi("UpstreamError"),
        },
      },
    },
  },
});

// -- GET /search --

const SearchResultSchema = z
  .object({
    service: z.string(),
    method: z.string(),
    path: z.string(),
    summary: z.string(),
    score: z.number(),
    bodyFields: z.array(z.string()).optional(),
    responseFields: z.array(z.string()).optional(),
  })
  .openapi("SearchResult");

const SearchResponseSchema = z
  .object({
    query: z.string(),
    resultCount: z.number(),
    indexSize: z.number(),
    results: z.array(SearchResultSchema),
  })
  .openapi("SearchResponse");

registry.registerPath({
  method: "get",
  path: "/search",
  summary:
    "Search for API endpoints across all services using ranked full-text search. Supports fuzzy matching and prefix search.",
  request: {
    query: z.object({
      q: z.string().openapi({ description: "Search query (e.g. 'send email', 'brand extract')" }),
      service: z.string().optional().openapi({ description: "Filter to a specific service" }),
      method: z.string().optional().openapi({ description: "Filter by HTTP method (e.g. 'POST')" }),
      pathPrefix: z.string().optional().openapi({ description: "Filter by path prefix (e.g. '/v1/')" }),
      limit: z.string().optional().openapi({ description: "Max results (omit for all results)" }),
    }),
    headers: optionalIdentityHeaders,
  },
  responses: {
    200: {
      description: "Ranked search results",
      content: { "application/json": { schema: SearchResponseSchema } },
    },
    400: {
      description: "Missing query parameter",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: unauthorizedResponse,
  },
});

// -- GET /llm-context --

const LlmOverviewServiceSchema = z
  .object({
    service: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    error: z.string().optional(),
    endpointCount: z.number(),
  })
  .openapi("LlmOverviewService");

const LlmOverviewResponseSchema = z
  .object({
    _description: z.string(),
    _workflow: z.string(),
    serviceCount: z.number(),
    services: z.array(LlmOverviewServiceSchema),
  })
  .openapi("LlmOverviewResponse");

registry.registerPath({
  method: "get",
  path: "/llm-context",
  summary:
    "LLM-friendly overview: list all services with name, description, and endpoint count. Use GET /llm-context/{service} for endpoint details.",
  request: { headers: optionalIdentityHeaders },
  responses: {
    200: {
      description: "Lightweight service overview for LLM consumption",
      content: { "application/json": { schema: LlmOverviewResponseSchema } },
    },
    401: unauthorizedResponse,
  },
});

const LlmServiceEndpointSchema = z
  .object({
    method: z.string(),
    path: z.string(),
    summary: z.string(),
  })
  .openapi("LlmServiceEndpoint");

const LlmEndpointGroupSchema = z
  .object({
    group: z.string(),
    endpointCount: z.number(),
    endpoints: z.array(LlmServiceEndpointSchema),
  })
  .openapi("LlmEndpointGroup");

const LlmServiceDetailResponseSchema = z
  .object({
    service: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    endpointCount: z.number().optional(),
    endpoints: z.array(LlmServiceEndpointSchema).optional(),
    totalEndpoints: z.number().optional(),
    groupCount: z.number().optional(),
    groups: z.array(LlmEndpointGroupSchema).optional(),
  })
  .openapi("LlmServiceDetailResponse");

registry.registerPath({
  method: "get",
  path: "/llm-context/{service}",
  summary:
    "LLM-friendly endpoint list for a specific service. Supports filtering by method, path group, or path prefix. Large services (30+ endpoints) auto-group by path prefix.",
  request: {
    params: z.object({
      service: z.string().openapi({ description: "Service name" }),
    }),
    query: z.object({
      method: z.string().optional().openapi({ description: "Filter by HTTP method (e.g. 'POST')" }),
      group: z.string().optional().openapi({ description: "Filter by path group (e.g. 'campaigns', 'brands')" }),
      pathPrefix: z.string().optional().openapi({ description: "Filter by path prefix (e.g. '/v1/campaigns')" }),
    }),
    headers: optionalIdentityHeaders,
  },
  responses: {
    200: {
      description: "Endpoint list for the service (flat or grouped depending on size)",
      content: { "application/json": { schema: LlmServiceDetailResponseSchema } },
    },
    401: unauthorizedResponse,
    404: {
      description: "Service not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    502: {
      description: "Failed to fetch spec from upstream",
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), detail: z.string() }),
        },
      },
    },
  },
});

// -- POST /call/{service} --

const CallApiRequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z
      .string()
      .describe("Endpoint path on the target service (e.g. '/v1/campaigns')"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Additional headers to forward"),
    body: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Request body for POST/PUT/PATCH"),
  })
  .openapi("CallApiRequest");

const CallApiResponseSchema = z
  .object({
    status: z
      .number()
      .describe("HTTP status code from downstream service"),
    ok: z.boolean().describe("Whether the response status was 2xx"),
    data: z.unknown().describe("Response body from downstream service"),
  })
  .openapi("CallApiResponse");

const ProxyErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ProxyError");

registry.registerPath({
  method: "post",
  path: "/call/{service}",
  summary:
    "Proxy a request to a registered service with automatic API key injection",
  request: {
    params: z.object({
      service: z.string().openapi({ description: "Target service name" }),
    }),
    headers: [...identityHeaders, ...workflowTrackingHeaders],
    body: {
      content: {
        "application/json": { schema: CallApiRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Proxied response from downstream service",
      content: { "application/json": { schema: CallApiResponseSchema } },
    },
    400: badRequestIdentityResponse,
    401: unauthorizedResponse,
    404: {
      description: "Service not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    502: {
      description: "Downstream request failed",
      content: { "application/json": { schema: ProxyErrorSchema } },
    },
  },
});

// -- GET /openapi.json --

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "This service's own OpenAPI specification",
  responses: {
    200: {
      description: "OpenAPI 3.0 specification",
      content: { "application/json": { schema: OpenApiSpecSchema } },
    },
    404: {
      description: "Spec not generated yet",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// -- Agent discovery: GET /discover/* (three levels, each page ~2k tokens) --

const RunStatsSchema = z
  .object({
    successRate: z.number().nullable().describe("completed / (completed + failed) over the sampled runs; null when none ended"),
    avgCostUsd: z.number().describe("Mean whole-run cost in USD: the run's own and every sub-call's actual costs, at catalogue price"),
    avgDurationMs: z.number().nullable().describe("Mean duration of the sampled COMPLETED runs; null when none completed"),
    runs: z.number().describe("All-time run count of the task(s) behind this endpoint, all orgs"),
    sampled: z.number().describe("Runs measured: the most recent ones, at most 200 per task"),
    lastRunAt: z.string().nullable(),
    tasks: z.array(z.string()).optional().describe("Run task names merged into this endpoint, when more than one"),
  })
  .openapi("RunStats");

const EndpointStatsField = z
  .union([RunStatsSchema, z.string()])
  .describe("Run stats, or a sentence saying why there are none: 'no runs yet', 'no run of its own: this endpoint opens no run, so no metered cost of its own', or 'no runs recorded: this service tracks no runs, so no metered cost'");

const EndpointRoiSchema = z
  .object({
    step: z.string().describe("features-service step id the endpoint produces (e.g. lead_found)"),
    stepName: z.string(),
    valueUsd: z.number().nullable().describe("Value of one such step"),
    roi: z.number().nullable().describe("valueUsd / avgCostUsd; null with a note when it cannot be computed"),
    note: z.string().optional(),
  })
  .openapi("EndpointRoi");

const DiscoverServicesResponseSchema = z
  .object({
    serviceCount: z.number(),
    matched: z.number(),
    services: z.array(
      z.object({
        name: z.string(),
        description: z.string().describe("One line"),
        endpoints: z.number().nullable().describe("Endpoint count (health/openapi excluded); null when the spec is unreachable"),
        error: z.string().optional(),
      }),
    ),
    _next: z.string(),
  })
  .openapi("DiscoverServicesResponse");

registry.registerPath({
  method: "get",
  path: "/discover/services",
  summary: "Level 1: every running service with a one-line description",
  description: "Start here to explore the platform. Each service: name, one-line description, endpoint count. Next: GET /discover/services/{service}/endpoints.",
  request: {
    query: z.object({
      q: z.string().optional().describe("Text filter on name + description; every word must match"),
      limit: z.string().optional().describe("Max services returned (default all)"),
    }),
  },
  responses: {
    200: { description: "Services", content: { "application/json": { schema: DiscoverServicesResponseSchema } } },
    401: unauthorizedResponse,
  },
});

const DiscoverEndpointsResponseSchema = z
  .object({
    service: z.string(),
    description: z.string(),
    endpointCount: z.number(),
    matched: z.number(),
    shown: z.number(),
    _more: z.string().optional(),
    statsBasis: z.string().describe("How the stats are computed"),
    statsAsOf: z.string().optional(),
    statsError: z.string().optional().describe("Present when runs-service stats could not be read; endpoints then carry stats 'unavailable'"),
    roiBasis: z.string().describe("How roi is computed"),
    roiError: z.string().optional().describe("Present when features-service step values could not be read"),
    endpoints: z.array(
      z.object({
        method: z.string(),
        path: z.string(),
        summary: z.string().describe("One line"),
        stats: EndpointStatsField,
        roi: EndpointRoiSchema.optional().describe("Only on endpoints that produce a funnel step"),
      }),
    ),
    unlinkedTasks: z
      .array(
        z.object({
          task: z.string(),
          runs: z.number(),
          successRate: z.number().nullable(),
          avgCostUsd: z.number(),
          avgDurationMs: z.number().nullable(),
        }),
      )
      .optional()
      .describe("Run tasks of this service that no endpoint claims (crons, internal jobs), top 5 by runs"),
    unlinkedTaskCount: z.number().optional(),
    _next: z.string(),
  })
  .openapi("DiscoverEndpointsResponse");

registry.registerPath({
  method: "get",
  path: "/discover/services/{service}/endpoints",
  summary: "Level 2: a service's endpoints with avg cost, duration and success rate",
  description: "One line per endpoint plus stats measured on real runs across all orgs. Most-used first; 20 per page by default. Next: GET /discover/services/{service}/endpoint?method=&path=.",
  request: {
    params: z.object({ service: z.string() }),
    query: z.object({
      q: z.string().optional().describe("Text filter on method + path + summary; every word must match"),
      method: z.string().optional(),
      limit: z.string().optional().describe("Default 20, max 200"),
    }),
  },
  responses: {
    200: { description: "Endpoints with stats", content: { "application/json": { schema: DiscoverEndpointsResponseSchema } } },
    401: unauthorizedResponse,
    404: { description: "Service not found", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Service spec unreachable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const DiscoverEndpointResponseSchema = z
  .object({
    service: z.string(),
    method: z.string(),
    path: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    parameters: z.array(z.object({}).passthrough()).optional(),
    requestBody: z.object({}).passthrough().optional(),
    responses: z.object({}).passthrough().optional(),
    stats: EndpointStatsField,
    statsBasis: z.string().optional(),
    roi: z.union([EndpointRoiSchema, z.string()]).describe("ROI object, or 'produces no funnel step: cost only'"),
    roiBasis: z.string().optional(),
    roiError: z.string().optional(),
    testRun: z.object({ mcp: z.string(), http: z.string(), billing: z.string() }),
  })
  .openapi("DiscoverEndpointResponse");

registry.registerPath({
  method: "get",
  path: "/discover/services/{service}/endpoint",
  summary: "Level 3: one endpoint's full doc, run stats, and how to test-run it",
  description: "Full parameters, request and response schemas ($refs resolved, error responses included), the endpoint's run stats, and how to run it now via POST /call/{service} (a real run, billed to the calling org).",
  request: {
    params: z.object({ service: z.string() }),
    query: z.object({ method: z.string(), path: z.string() }),
  },
  responses: {
    200: { description: "Endpoint doc + stats", content: { "application/json": { schema: DiscoverEndpointResponseSchema } } },
    400: { description: "Missing method or path", content: { "application/json": { schema: ErrorSchema } } },
    401: unauthorizedResponse,
    404: { description: "Service, path or method not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});
