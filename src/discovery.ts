import {
  ROI_NOTE,
  extractOperations,
  joinStats,
  matchesQuery,
  runsServiceName,
  serviceDescription,
  sortByRuns,
  NOT_LINKED,
} from "./catalog.js";
import { STATS_SAMPLE, type TaskOutcomesCache, type OutcomesResult } from "./run-stats.js";
import { getEndpointDetails } from "./mcp.js";

// The three discovery levels, shared by the HTTP routes (/discover/*) and the MCP tools
// (discover_services, discover_service_endpoints, discover_endpoint). Each level is
// sized so one page stays around 2k tokens.

export interface DiscoveryRegistry {
  getServices(): Record<string, { baseUrl: string; apiKey?: string }>;
  fetchSpec(url: string): Promise<{ spec: unknown; error?: string }>;
}

const SPEC_TTL_MS = 120_000;
export const DEFAULT_ENDPOINT_LIMIT = 20;
const MAX_LIMIT = 200;
const UNLINKED_SHOWN = 5;

export const STATS_BASIS =
  `Per endpoint, from its last ${STATS_SAMPLE} runs at most, all orgs: successRate = completed/(completed+failed); ` +
  "avgCostUsd = mean whole-run cost (its own and every sub-call's actual costs, catalogue price); " +
  "avgDurationMs = mean of completed runs; runs = all-time count.";

export const TEST_RUN = {
  mcp: "call_api(service, method, path, body)",
  http: "POST /call/{service} with JSON {method, path, body} and your x-org-id + x-user-id headers",
  billing: "A test run is a real run: its costs are billed to the calling org like any other run.",
};

function clampLimit(limit: number | undefined, fallback: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export class Discovery {
  private specs = new Map<string, { at: number; result: { spec: unknown; error?: string } }>();

  constructor(
    private readonly registry: DiscoveryRegistry,
    private readonly outcomes: TaskOutcomesCache,
  ) {}

  private async spec(baseUrl: string): Promise<{ spec: unknown; error?: string }> {
    const hit = this.specs.get(baseUrl);
    if (hit && Date.now() - hit.at < SPEC_TTL_MS) return hit.result;
    const result = await this.registry.fetchSpec(baseUrl);
    if (!result.error && result.spec) this.specs.set(baseUrl, { at: Date.now(), result });
    return result;
  }

  clearSpecCache(): void {
    this.specs.clear();
  }

  /** The registry with a cached spec fetch, for helpers that take a registry. */
  private cachedRegistry(): DiscoveryRegistry {
    return { getServices: () => this.registry.getServices(), fetchSpec: (u) => this.spec(u) };
  }

  /** Warm every service's run stats, one service at a time (background job). */
  async warmStats(): Promise<void> {
    for (const name of Object.keys(this.registry.getServices())) {
      await this.outcomes.refresh(runsServiceName(name));
    }
  }

  // ---- Level 1 ----
  async services(opts: { q?: string; limit?: number } = {}) {
    const all = await Promise.all(
      Object.entries(this.registry.getServices()).map(async ([name, { baseUrl }]) => {
        const r = await this.spec(baseUrl);
        if (r.error || !r.spec) {
          return { name, description: serviceDescription(name, null), endpoints: null, error: `spec unreachable: ${r.error ?? "empty"}` };
        }
        return { name, description: serviceDescription(name, r.spec), endpoints: extractOperations(r.spec).length };
      }),
    );
    all.sort((a, b) => a.name.localeCompare(b.name));
    const matched = all.filter((s) => matchesQuery(`${s.name} ${s.description}`, opts.q));
    const shown = matched.slice(0, clampLimit(opts.limit, MAX_LIMIT));
    return {
      serviceCount: all.length,
      matched: matched.length,
      services: shown,
      _next: "Level 2: discover_service_endpoints(service) or GET /discover/services/{service}/endpoints",
    };
  }

  // ---- Level 2 ----
  async endpoints(service: string, opts: { q?: string; method?: string; limit?: number } = {}) {
    const entry = this.registry.getServices()[service];
    if (!entry) return { status: 404 as const, body: { error: `Service "${service}" not found`, available: Object.keys(this.registry.getServices()).sort() } };
    const r = await this.spec(entry.baseUrl);
    if (r.error || !r.spec) return { status: 502 as const, body: { error: `Failed to fetch spec for "${service}"`, detail: r.error } };

    const ops = extractOperations(r.spec);
    const stats = await this.outcomes.get(runsServiceName(service));
    const joined = stats.ok ? joinStats(service, ops, stats.outcomes) : null;
    const rows = joined ? sortByRuns(joined.endpoints) : ops.map((op) => ({ method: op.method, path: op.path, summary: op.summary, stats: "unavailable" as string }));

    const method = opts.method?.toUpperCase();
    const matched = rows.filter((e) => (!method || e.method === method) && matchesQuery(`${e.method} ${e.path} ${e.summary}`, opts.q));
    const shown = matched.slice(0, clampLimit(opts.limit, DEFAULT_ENDPOINT_LIMIT));
    const unlinked = (joined?.unlinked ?? []).filter((t) => matchesQuery(t.task, opts.q));

    return {
      status: 200 as const,
      body: {
        service,
        description: serviceDescription(service, r.spec),
        endpointCount: ops.length,
        matched: matched.length,
        shown: shown.length,
        ...(shown.length < matched.length ? { _more: "Raise limit, or narrow with q / method." } : {}),
        statsBasis: STATS_BASIS,
        ...(stats.ok ? { statsAsOf: stats.fetchedAt } : { statsError: stats.error }),
        roi: ROI_NOTE,
        endpoints: shown,
        ...(unlinked.length
          ? { unlinkedTasks: unlinked.slice(0, UNLINKED_SHOWN), unlinkedTaskCount: unlinked.length }
          : {}),
        _next: "Level 3: discover_endpoint(service, method, path) or GET /discover/services/{service}/endpoint?method=&path=",
      },
    };
  }

  // ---- Level 3 ----
  async endpoint(service: string, method: string, path: string) {
    const details = await getEndpointDetails(this.cachedRegistry(), service, method, path, { includeErrors: true });
    if ("error" in details) {
      // availablePaths can list hundreds of paths: point at level 2 instead.
      const { availablePaths: _paths, ...rest } = details;
      const notFound = "availablePaths" in details || "availableMethods" in details || "available" in details;
      return {
        status: notFound ? (404 as const) : (502 as const),
        body: { ...rest, _next: "Find the path with discover_service_endpoints(service, q)." },
      };
    }

    const entry = this.registry.getServices()[service];
    const r = await this.spec(entry.baseUrl);
    const ops = extractOperations(r.spec);
    const stats: OutcomesResult = await this.outcomes.get(runsServiceName(service));
    // Join against ALL operations: a path task must land on its most literal template.
    const row = stats.ok
      ? joinStats(service, ops, stats.outcomes).endpoints.find((e) => e.method === method.toUpperCase() && e.path === path)
      : undefined;
    const runStats = stats.ok ? (row?.stats ?? NOT_LINKED) : stats.error;

    return {
      status: 200 as const,
      body: {
        ...details,
        stats: runStats,
        ...(runStats === NOT_LINKED ? {} : { statsBasis: STATS_BASIS }),
        roi: ROI_NOTE,
        testRun: TEST_RUN,
      },
    };
  }
}
