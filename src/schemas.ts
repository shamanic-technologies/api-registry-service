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

// -- GET /openapi --

const AllSpecsResponseSchema = z
  .object({
    services: z.array(ServiceSpecResultSchema),
  })
  .openapi("AllSpecsResponse");

registry.registerPath({
  method: "get",
  path: "/openapi",
  summary: "Fetch all OpenAPI specs at once",
  responses: {
    200: {
      description: "All service specs",
      content: { "application/json": { schema: AllSpecsResponseSchema } },
    },
    401: unauthorizedResponse,
  },
});

// -- GET /llm-context --

const EndpointParamSchema = z
  .object({
    name: z.string(),
    in: z.string(),
    required: z.boolean(),
    type: z.string().optional(),
  })
  .openapi("EndpointParam");

const EndpointSummarySchema = z
  .object({
    method: z.string(),
    path: z.string(),
    summary: z.string(),
    params: z.array(EndpointParamSchema).optional(),
    bodyFields: z.array(z.string()).optional(),
  })
  .openapi("EndpointSummary");

const LlmServiceSummarySchema = z
  .object({
    service: z.string(),
    baseUrl: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    error: z.string().optional(),
    endpoints: z.array(EndpointSummarySchema),
  })
  .openapi("LlmServiceSummary");

const LlmContextResponseSchema = z
  .object({
    _description: z.string(),
    _usage: z.string(),
    services: z.array(LlmServiceSummarySchema),
  })
  .openapi("LlmContextResponse");

registry.registerPath({
  method: "get",
  path: "/llm-context",
  summary:
    "LLM-friendly context: compact summary of all services and endpoints",
  responses: {
    200: {
      description: "Compact endpoint summary for LLM consumption",
      content: { "application/json": { schema: LlmContextResponseSchema } },
    },
    401: unauthorizedResponse,
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
