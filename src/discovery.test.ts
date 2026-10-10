import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Every service running on the Hetzner box on 2026-10-10 (docker ps), by registry name.
const BOX_SERVICES = [
  "api", "api-registry", "apollo", "billing", "brand", "campaign", "chat", "client", "cloudflare",
  "content-generation", "costs", "crm", "email-gateway", "expert-quotes-requests", "features", "google",
  "human", "instantly", "journalists-quotes", "key", "lead", "mcp", "meta", "postmark", "runs",
  "scraping", "social", "stripe", "transactional-email", "twilio", "workflow",
];

vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("API_REGISTRY_SERVICE_API_KEY", "test-registry-key");
for (const name of BOX_SERVICES) {
  const prefix = name.toUpperCase().replace(/-/g, "_");
  vi.stubEnv(`${prefix}_SERVICE_URL`, `https://${name}.example.com`);
}
vi.stubEnv("RUNS_SERVICE_API_KEY", "runs-key");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { default: app, discovery, taskOutcomes } = await import("./index.js");

function resetCaches() {
  mockFetch.mockReset();
  discovery.clearSpecCache();
  taskOutcomes.clear();
}
const catalog = await import("./catalog.js");
const { TaskOutcomesCache } = await import("./run-stats.js");

const KEY_ONLY = { "x-api-key": "test-registry-key" };

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function outcome(taskName: string, o: Partial<import("./catalog.js").TaskOutcome> = {}) {
  return {
    taskName,
    totalRunCount: 1000,
    sampleSize: 200,
    completedCount: 190,
    failedCount: 10,
    runningCount: 0,
    successRate: 0.95,
    avgDurationMs: 50,
    sumCompletedDurationMs: 9500,
    avgCostInUsdCents: "8.5000000000",
    sumCostInUsdCents: "1700.0000000000",
    lastRunAt: "2026-10-10T08:00:00.000Z",
    ...o,
  };
}

const APOLLO_SPEC = {
  openapi: "3.0.0",
  info: { title: "Apollo Service", description: "Service for searching and enriching leads via the Apollo API" },
  paths: {
    "/health": { get: { summary: "Health check" } },
    "/openapi.json": { get: { summary: "OpenAPI" } },
    "/enrich": { post: { summary: "Enrich a person via Apollo to reveal their email" } },
    "/search/next": { post: { summary: "Get next page of search results for a campaign" } },
    "/match": { post: { summary: "Match a person by name and organization domain via Apollo" } },
    "/reference/industries": { get: { summary: "Get Apollo industries list" } },
    "/email-finder/find": { post: { summary: "Find a person's work email with treg.to or Explee (billed, idempotent)" } },
  },
};

const APOLLO_OUTCOMES = {
  serviceName: "apollo-service",
  sample: 200,
  tasks: [
    outcome("people-search-next", { totalRunCount: 30000, avgCostInUsdCents: "0", sumCostInUsdCents: "0" }),
    outcome("enrichment", { totalRunCount: 17000 }),
    outcome("email-find-treg", { totalRunCount: 2000, sampleSize: 100, completedCount: 80, failedCount: 20, sumCompletedDurationMs: 8000, sumCostInUsdCents: "200" }),
    outcome("email-find-explee", { totalRunCount: 13, sampleSize: 13, completedCount: 11, failedCount: 2, sumCompletedDurationMs: 11000, sumCostInUsdCents: "44" }),
    outcome("hold-reconcile-cron", { totalRunCount: 5, sampleSize: 5, completedCount: 5, failedCount: 0, sumCompletedDurationMs: 500, sumCostInUsdCents: "0" }),
  ],
};

/** Route fetch calls by URL: specs by host, runs-service task-outcomes by query. */
function routeFetch(handlers: { spec?: (host: string) => unknown; outcomes?: (service: string) => unknown | Error }) {
  mockFetch.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/openapi.json") {
      const host = u.hostname.replace(".example.com", "");
      const spec = handlers.spec?.(host) ?? { openapi: "3.0.0", info: { title: host }, paths: { "/x": { get: { summary: "X" } } } };
      return json(spec);
    }
    if (u.pathname === "/internal/stats/task-outcomes") {
      const r = handlers.outcomes?.(u.searchParams.get("serviceName")!);
      if (r instanceof Error) return json({ error: r.message }, 404);
      return json(r ?? { serviceName: u.searchParams.get("serviceName"), sample: 200, tasks: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// ---------------- pure logic ----------------

describe("catalog helpers", () => {
  it("oneLine keeps the first sentence and caps the length", () => {
    expect(catalog.oneLine("Does X. Then Y.")).toBe("Does X.");
    expect(catalog.oneLine("Line one\nLine two")).toBe("Line one");
    expect(catalog.oneLine("a".repeat(300), 20)).toHaveLength(20);
    expect(catalog.oneLine(undefined)).toBe("");
  });

  it("extractOperations drops /health and /openapi.json and reads x-run-task", () => {
    const ops = catalog.extractOperations({
      paths: {
        "/health": { get: {} },
        "/health/debug": { get: {} },
        "/openapi.json": { get: {} },
        "/a": { post: { summary: "A", "x-run-task": "task-a" }, parameters: [] },
        "/b": { get: { description: "B long. More." , "x-run-task": ["t1", "t2"] } },
      },
    });
    expect(ops).toEqual([
      { method: "POST", path: "/a", summary: "A", runTasks: ["task-a"] },
      { method: "GET", path: "/b", summary: "B long.", runTasks: ["t1", "t2"] },
    ]);
  });

  it("runsServiceName defaults to <name>-service with known overrides", () => {
    expect(catalog.runsServiceName("apollo")).toBe("apollo-service");
    expect(catalog.runsServiceName("cloudflare")).toBe("cloudflare-storage");
    expect(catalog.runsServiceName("workflow")).toBe("workflow");
    expect(catalog.runsServiceName("google")).toBe("google");
  });

  it("every service running on the box has a curated one-line description", () => {
    for (const name of BOX_SERVICES) {
      const d = catalog.SERVICE_DESCRIPTIONS[name];
      expect(d, name).toBeTruthy();
      expect(d.length, name).toBeLessThanOrEqual(110);
      expect(d, name).not.toMatch(/[—–]/);
    }
  });

  it("matchPathTask picks the most literal template and accepts {id} segments", () => {
    const ops = catalog.extractOperations({
      paths: {
        "/v1/brands/{brandId}": { get: { summary: "one" } },
        "/v1/brands/by-ids": { get: { summary: "many" } },
        "/v1/offers/{offerId}/revenue": { get: { summary: "rev" } },
      },
    });
    expect(catalog.matchPathTask("GET /v1/brands/by-ids", ops)?.path).toBe("/v1/brands/by-ids");
    expect(catalog.matchPathTask("GET /v1/brands/{id}", ops)?.path).toBe("/v1/brands/{brandId}");
    expect(catalog.matchPathTask("GET /v1/offers/{id}/revenue?x=1", ops)?.path).toBe("/v1/offers/{offerId}/revenue");
    expect(catalog.matchPathTask("POST /v1/brands/by-ids", ops)).toBeNull();
    expect(catalog.matchPathTask("enrichment", ops)).toBeNull();
  });

  it("mergeOutcomes merges exactly from sums, never averages of averages", () => {
    const m = catalog.mergeOutcomes([
      outcome("a", { sampleSize: 100, completedCount: 80, failedCount: 20, sumCompletedDurationMs: 8000, sumCostInUsdCents: "200", totalRunCount: 2000 }),
      outcome("b", { sampleSize: 10, completedCount: 10, failedCount: 0, sumCompletedDurationMs: 11000, sumCostInUsdCents: "40", totalRunCount: 10, lastRunAt: "2026-10-11T00:00:00.000Z" }),
    ])!;
    expect(m.successRate).toBe(Math.round((90 / 110) * 1000) / 1000);
    expect(m.avgDurationMs).toBe(Math.round(19000 / 90));
    expect(m.avgCostUsd).toBeCloseTo(240 / 110 / 100, 6);
    expect(m.runs).toBe(2010);
    expect(m.sampled).toBe(110);
    expect(m.lastRunAt).toBe("2026-10-11T00:00:00.000Z");
    expect(m.tasks).toEqual(["a", "b"]);
    expect(catalog.mergeOutcomes([outcome("z", { sampleSize: 0 })])).toBeNull();
  });

  it("joinStats: curated tasks, no runs yet, not linked, unlinked tasks", () => {
    const ops = catalog.extractOperations(APOLLO_SPEC);
    const { endpoints, unlinked } = catalog.joinStats("apollo", ops, APOLLO_OUTCOMES.tasks);
    const by = (p: string) => endpoints.find((e) => e.path === p)!;
    expect(by("/enrich").stats).toMatchObject({ runs: 17000, successRate: 0.95, avgCostUsd: 0.085, avgDurationMs: 50 });
    expect(by("/email-finder/find").stats).toMatchObject({ runs: 2013, sampled: 113, tasks: ["email-find-treg", "email-find-explee"] });
    expect(by("/match").stats).toBe(catalog.NO_RUNS_YET); // curated, never ran
    expect(by("/reference/industries").stats).toBe(catalog.NOT_LINKED);
    expect(unlinked.map((t) => t.task)).toEqual(["hold-reconcile-cron"]);
  });

  it("joinStats: a producer's x-run-task wins over the curated table", () => {
    const ops = catalog.extractOperations({ paths: { "/enrich": { post: { summary: "E", "x-run-task": "people-search-next" } } } });
    const { endpoints } = catalog.joinStats("apollo", ops, APOLLO_OUTCOMES.tasks);
    expect(endpoints[0].stats).toMatchObject({ runs: 30000 });
  });

  it("joinStats: on a METHOD /path service every endpoint is linked, absent = no runs yet", () => {
    const ops = catalog.extractOperations({
      paths: { "/v1/leads": { get: { summary: "L" } }, "/v1/offers/{offerId}/revenue": { get: { summary: "R" } }, "/v1/never": { post: { summary: "N" } } },
    });
    const { endpoints, unlinked } = catalog.joinStats("api", ops, [
      outcome("GET /v1/leads", { totalRunCount: 5000 }),
      outcome("GET /v1/offers/{id}/revenue", { totalRunCount: 4000 }),
      outcome("GET /v1/gone", { totalRunCount: 3 }),
    ]);
    expect(endpoints.map((e) => typeof e.stats === "string" ? e.stats : e.stats.runs)).toEqual([5000, 4000, catalog.NO_RUNS_YET]);
    expect(unlinked.map((t) => t.task)).toEqual(["GET /v1/gone"]);
  });
});

describe("TaskOutcomesCache", () => {
  beforeEach(resetCaches);

  it("serves stale while revalidating, keeps the stale value when the refresh fails", async () => {
    let now = 0;
    const cache = new TaskOutcomesCache({ getRunsEntry: () => ({ baseUrl: "https://runs.example.com", apiKey: "k" }), ttlMs: 1000, now: () => now });
    mockFetch.mockResolvedValueOnce(json(APOLLO_OUTCOMES));
    const first = await cache.get("apollo-service");
    expect(first.ok && first.outcomes.length).toBe(5);
    expect(mockFetch.mock.calls[0][0]).toBe("https://runs.example.com/internal/stats/task-outcomes?serviceName=apollo-service&sample=200");
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ "x-api-key": "k" });

    now = 5000;
    mockFetch.mockResolvedValueOnce(json({ error: "x" }, 500));
    const stale = await cache.get("apollo-service");
    expect(stale.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const still = await cache.get("apollo-service");
    expect(still.ok && still.outcomes.length).toBe(5);
  });

  it("a cold miss that fails says why, loudly", async () => {
    const cache = new TaskOutcomesCache({ getRunsEntry: () => ({ baseUrl: "https://runs.example.com" }) });
    mockFetch.mockResolvedValueOnce(json({ error: "Not found" }, 404));
    expect(await cache.get("x-service")).toEqual({ ok: false, error: "run stats unavailable: runs-service HTTP 404" });
  });

  it("rejects a response that does not match the contract", async () => {
    const cache = new TaskOutcomesCache({ getRunsEntry: () => ({ baseUrl: "https://runs.example.com" }) });
    mockFetch.mockResolvedValueOnce(json({ tasks: [{ taskName: 1 }] }));
    const r = await cache.get("x-service");
    expect(r.ok).toBe(false);
  });
});

// ---------------- HTTP ----------------

describe("GET /discover/services (level 1)", () => {
  beforeEach(resetCaches);

  it("401 without API key, 200 without identity headers", async () => {
    expect((await request(app).get("/discover/services")).status).toBe(401);
    routeFetch({});
    expect((await request(app).get("/discover/services").set(KEY_ONLY)).status).toBe(200);
  });

  it("lists every box service with a description, in under ~2k tokens", async () => {
    routeFetch({ spec: (h) => (h === "apollo" ? APOLLO_SPEC : undefined) });
    const res = await request(app).get("/discover/services").set(KEY_ONLY);
    expect(res.body.serviceCount).toBe(BOX_SERVICES.length);
    expect(res.body.services.map((s: { name: string }) => s.name)).toEqual([...BOX_SERVICES].sort());
    const apollo = res.body.services.find((s: { name: string }) => s.name === "apollo");
    expect(apollo).toEqual({ name: "apollo", description: catalog.SERVICE_DESCRIPTIONS.apollo, endpoints: 5 });
    // ~4 characters per token
    expect(JSON.stringify(res.body).length / 4).toBeLessThan(2000);
    expect(JSON.stringify(res.body)).not.toContain("example.com");
  });

  it("filters by text and limit", async () => {
    routeFetch({});
    const res = await request(app).get("/discover/services?q=email&limit=2").set(KEY_ONLY);
    expect(res.body.matched).toBeGreaterThan(2);
    expect(res.body.services).toHaveLength(2);
    for (const s of res.body.services) expect(`${s.name} ${s.description}`.toLowerCase()).toContain("email");
  });

  it("keeps a service whose spec is unreachable, with the reason", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.startsWith("https://meta.") ? json({}, 503) : json({ paths: {} }));
    const res = await request(app).get("/discover/services?q=meta").set(KEY_ONLY);
    const meta = res.body.services.find((s: { name: string }) => s.name === "meta");
    expect(meta.endpoints).toBeNull();
    expect(meta.error).toContain("spec unreachable");
  });
});

describe("GET /discover/services/:service/endpoints (level 2)", () => {
  beforeEach(resetCaches);

  it("apollo: per-endpoint avg cost, duration, success rate, most-used first", async () => {
    routeFetch({ spec: (h) => (h === "apollo" ? APOLLO_SPEC : undefined), outcomes: () => APOLLO_OUTCOMES });
    const res = await request(app).get("/discover/services/apollo/endpoints").set(KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.endpointCount).toBe(5);
    expect(res.body.roi).toBe(catalog.ROI_NOTE);
    expect(res.body.statsBasis).toContain("all orgs");
    expect(res.body.endpoints.map((e: { path: string }) => e.path)).toEqual([
      "/search/next", "/enrich", "/email-finder/find", "/match", "/reference/industries",
    ]);
    expect(res.body.endpoints[1]).toEqual({
      method: "POST",
      path: "/enrich",
      summary: "Enrich a person via Apollo to reveal their email",
      stats: { successRate: 0.95, avgCostUsd: 0.085, avgDurationMs: 50, runs: 17000, sampled: 200, lastRunAt: "2026-10-10T08:00:00.000Z" },
    });
    expect(res.body.unlinkedTasks).toEqual([
      { task: "hold-reconcile-cron", runs: 5, successRate: 1, avgCostUsd: 0, avgDurationMs: 100 },
    ]);
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("task-outcomes"))!;
    expect(String(call[0])).toContain("serviceName=apollo-service");
  });

  it("filters by q, method and limit, and says when more exist", async () => {
    routeFetch({ spec: (h) => (h === "apollo" ? APOLLO_SPEC : undefined), outcomes: () => APOLLO_OUTCOMES });
    const q = await request(app).get("/discover/services/apollo/endpoints?q=email%20find").set(KEY_ONLY);
    expect(q.body.endpoints.map((e: { path: string }) => e.path)).toEqual(["/email-finder/find"]);
    const m = await request(app).get("/discover/services/apollo/endpoints?method=get").set(KEY_ONLY);
    expect(m.body.endpoints.map((e: { path: string }) => e.path)).toEqual(["/reference/industries"]);
    const l = await request(app).get("/discover/services/apollo/endpoints?limit=2").set(KEY_ONLY);
    expect(l.body.shown).toBe(2);
    expect(l.body.matched).toBe(5);
    expect(l.body._more).toBeDefined();
  });

  it("defaults to 20 endpoints per page", async () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 45; i++) paths[`/r${i}`] = { get: { summary: `Route ${i}` } };
    routeFetch({ spec: (h) => (h === "brand" ? { paths } : undefined) });
    const res = await request(app).get("/discover/services/brand/endpoints").set(KEY_ONLY);
    expect(res.body.endpointCount).toBe(45);
    expect(res.body.endpoints).toHaveLength(20);
  });

  it("runs-service down: endpoints still listed, statsError says why", async () => {
    routeFetch({ spec: (h) => (h === "campaign" ? APOLLO_SPEC : undefined), outcomes: () => new Error("nope") });
    const res = await request(app).get("/discover/services/campaign/endpoints").set(KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.statsError).toBe("run stats unavailable: runs-service HTTP 404");
    expect(res.body.endpoints[0].stats).toBe("unavailable");
  });

  it("404 for an unknown service", async () => {
    routeFetch({});
    const res = await request(app).get("/discover/services/nope/endpoints").set(KEY_ONLY);
    expect(res.status).toBe(404);
    expect(res.body.available).toContain("apollo");
  });
});

describe("GET /discover/services/:service/endpoint (level 3)", () => {
  beforeEach(resetCaches);

  it("400 without method and path", async () => {
    const res = await request(app).get("/discover/services/apollo/endpoint").set(KEY_ONLY);
    expect(res.status).toBe(400);
  });

  it("returns the full doc, the stats and how to test-run it", async () => {
    const spec = {
      ...APOLLO_SPEC,
      paths: {
        ...APOLLO_SPEC.paths,
        "/enrich": {
          post: {
            summary: "Enrich a person via Apollo to reveal their email",
            description: "Long doc.",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/EnrichBody" } } } },
            responses: { "200": { description: "ok" }, "402": { description: "no credit" } },
          },
        },
      },
      components: { schemas: { EnrichBody: { type: "object", properties: { personId: { type: "string" } } } } },
    };
    routeFetch({ spec: (h) => (h === "apollo" ? spec : undefined), outcomes: () => APOLLO_OUTCOMES });
    const res = await request(app).get("/discover/services/apollo/endpoint?method=POST&path=/enrich").set(KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Long doc.");
    expect(res.body.requestBody.schema.properties.personId).toEqual({ type: "string" });
    expect(Object.keys(res.body.responses)).toEqual(["200", "402"]);
    expect(res.body.stats).toMatchObject({ runs: 17000, avgCostUsd: 0.085 });
    expect(res.body.testRun.http).toContain("POST /call/{service}");
    expect(res.body.testRun.billing).toContain("billed to the calling org");
  });

  it("404 for an unknown path, without dumping every path", async () => {
    routeFetch({ spec: (h) => (h === "apollo" ? APOLLO_SPEC : undefined), outcomes: () => APOLLO_OUTCOMES });
    const res = await request(app).get("/discover/services/apollo/endpoint?method=POST&path=/nope").set(KEY_ONLY);
    expect(res.status).toBe(404);
    expect(res.body.availablePaths).toBeUndefined();
    expect(res.body._next).toContain("discover_service_endpoints");
  });
});

describe("MCP discovery tools", () => {
  it("exposes discover_* next to the existing tools", async () => {
    const H = { ...KEY_ONLY, Accept: "application/json, text/event-stream" };
    const init = await request(app).post("/mcp").set(H).send({
      jsonrpc: "2.0", method: "initialize", id: 1,
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const sid = init.headers["mcp-session-id"];
    await request(app).post("/mcp").set({ ...H, "mcp-session-id": sid }).send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await request(app).post("/mcp").set({ ...H, "mcp-session-id": sid }).send({ jsonrpc: "2.0", method: "tools/list", id: 2 });
    const data = list.text.split("\n").find((l) => l.startsWith("data: "))!;
    const names = JSON.parse(data.slice(6)).result.tools.map((t: { name: string }) => t.name);
    for (const n of [
      "discover_services", "discover_service_endpoints", "discover_endpoint",
      "list_services", "list_service_endpoints", "get_all_endpoints", "search_endpoints", "get_endpoint_details", "call_api",
    ]) expect(names).toContain(n);
    await request(app).delete("/mcp").set({ ...H, "mcp-session-id": sid });
  });

  it("discover_service_endpoints returns the level 2 payload", async () => {
    resetCaches();
    routeFetch({ spec: (h) => (h === "apollo" ? APOLLO_SPEC : undefined), outcomes: () => APOLLO_OUTCOMES });
    const H = { ...KEY_ONLY, Accept: "application/json, text/event-stream" };
    const init = await request(app).post("/mcp").set(H).send({
      jsonrpc: "2.0", method: "initialize", id: 1,
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const sid = init.headers["mcp-session-id"];
    await request(app).post("/mcp").set({ ...H, "mcp-session-id": sid }).send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const call = await request(app).post("/mcp").set({ ...H, "mcp-session-id": sid }).send({
      jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "discover_service_endpoints", arguments: { service: "apollo", q: "enrich" } },
    });
    const data = call.text.split("\n").find((l) => l.startsWith("data: "))!;
    const body = JSON.parse(JSON.parse(data.slice(6)).result.content[0].text);
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0].stats.runs).toBe(17000);
    await request(app).delete("/mcp").set({ ...H, "mcp-session-id": sid });
  });
});
