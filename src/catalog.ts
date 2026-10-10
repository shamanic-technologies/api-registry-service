// Agent discovery catalog: the pure logic behind the three discovery levels.
//   Level 1: every service, one line each.
//   Level 2: one service's endpoints, one line each, with measured run stats.
//   Level 3: one endpoint's full doc + its stats + how to test-run it.
// No I/O here: callers pass specs and runs-service task stats in.

/** One-line description per registry service name. Shown at level 1. */
export const SERVICE_DESCRIPTIONS: Record<string, string> = {
  api: "Public API gateway (api.distribute.you): every customer /v1 route, proxies the services below.",
  "api-registry": "This registry: service and endpoint discovery, docs, run stats and test calls.",
  apollo: "Finds and enriches B2B people via Apollo: search, enrich, match, email find/verify, phone reveal.",
  billing: "Customer balance: prepaid credits, top-ups, daily budgets, spend authorization.",
  brand: "Brands and offers: brand fields, ICP and offers extracted by AI from a website.",
  campaign: "Campaigns: create, launch, pause, budgets, and the runs they trigger.",
  chat: "Every LLM call: text completion, Jev judgments (classification), images, RAG embed/score, chat.",
  client: "Orgs, users and memberships (internal ids, Clerk mapping).",
  cloudflare: "File storage on Cloudflare R2: upload and serve files.",
  "content-generation": "Writes outreach content (cold emails, pitches) from prompt templates.",
  costs: "Price catalogue: the cost per unit of every metered action.",
  crm: "Client CRM sync (GoHighLevel, Stripe, PostHog, Matrix) and per-person timelines.",
  "email-gateway": "Routes outgoing email to Postmark (transactional) or Instantly (cold); delivery stats.",
  "expert-quotes-requests": "Journalist quote requests ingested from Featured.com.",
  features: "Features, offers and outcomes: stats, revenue, ROI and funnel economics.",
  google: "Google Ads (MCC): OAuth, account linking, campaigns, reporting.",
  human: "People and audiences: who a person is, audience building, email verification.",
  instantly: "Cold email sending via Instantly: mailboxes, sends, replies, warmup, deliverability.",
  "journalists-quotes": "Journalist opportunities (HARO, Featured): ingestion, scoring, replies.",
  key: "API keys and BYOK provider credentials (encrypted), platform keys.",
  lead: "Serves the next qualified lead to a campaign: buffer, dedup, qualification, follow-ups.",
  mcp: "distribute.you MCP server: campaign tools for AI clients.",
  meta: "Meta (Facebook) Graph API: ad accounts, reporting, organic posts.",
  postmark: "Transactional email sending via Postmark, delivery events.",
  runs: "Run tracking and cost ledger: every run, its costs, cost stats.",
  scraping: "Scrapes and maps websites (Scrape.do, Firecrawl), extracts company info.",
  social: "LinkedIn presence for Kevin and distribute.you: posts, comments, engagement.",
  stripe: "Stripe wrapper: customers, checkout, payment intents, billing portal.",
  "transactional-email": "Templated lifecycle emails to customers and staff, with dedup.",
  twilio: "SMS and phone calls via Twilio.",
  workflow: "Workflow DAGs: create, version and execute workflows by slug.",
};

/** runs-service `service_name` for a registry service name, when it is not `<name>-service`. */
export const RUNS_SERVICE_NAME_OVERRIDES: Record<string, string> = {
  cloudflare: "cloudflare-storage",
  google: "google",
  workflow: "workflow",
};

export function runsServiceName(registryName: string): string {
  return RUNS_SERVICE_NAME_OVERRIDES[registryName] ?? `${registryName}-service`;
}

/**
 * Endpoint -> run task names, for services whose run `task_name` is free-form.
 * Read from each producer's code (git grep taskName) on 2026-10-10. A producer can
 * declare the same thing itself with an `x-run-task` operation extension in its
 * openapi (string or string[]); that declaration wins over this table.
 * Services whose task names are "METHOD /path" (api, expert-quotes-requests,
 * journalists-quotes) need no entry: they are matched by path.
 */
export const ENDPOINT_TASKS: Record<string, Record<string, string[]>> = {
  apollo: {
    "POST /search/next": ["people-search-next"],
    "POST /enrich": ["enrichment"],
    "POST /match": ["person-match"],
    "POST /people/{apolloPersonId}/phone-reveal": ["phone-reveal"],
    "POST /email-finder/find": ["email-find-treg", "email-find-explee"],
    "POST /email-verifications": ["verify-email"],
    "POST /internal/company-firmographics": ["company-firmographics"],
    "POST /internal/person-identity": ["person-role"],
    "GET /audiences/{apolloAudienceId}/preview": ["audience-companies"],
  },
  chat: {
    "POST /complete": ["complete"],
    "POST /internal/platform-complete": ["platform-complete"],
    "POST /orgs/judgments": ["judgments"],
    "POST /internal/platform-judgments": ["platform-judgments"],
    "POST /orgs/images/generate": ["generate-image"],
    "POST /orgs/rag/score": ["rag-score"],
    "POST /orgs/rag/embed": ["rag-embed"],
    "POST /chat": ["chat"],
  },
  scraping: {
    "POST /scrape": ["scrape"],
    "POST /map": ["map"],
  },
  postmark: {
    "POST /orgs/send": ["email-send"],
  },
  "content-generation": {
    "POST /generate": ["single-generation"],
  },
  lead: {
    "POST /orgs/buffer/next": ["lead-serve"],
  },
  cloudflare: {
    "POST /upload": ["upload"],
    "POST /upload/base64": ["upload-base64"],
    "POST /internal/upload/base64": ["upload-base64-platform"],
  },
};

export const ROI_NOTE =
  "ROI not available yet: features-service does not serve a value per step, so no endpoint output can be valued.";

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** First sentence (or line) of a text, capped to `max` characters. */
export function oneLine(text: string | undefined | null, max = 110): string {
  if (!text) return "";
  const firstLine = text.trim().split(/\n/)[0].trim();
  const sentence = firstLine.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? firstLine;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

export interface SpecOperation {
  method: string; // upper case
  path: string;
  summary: string; // one line
  runTasks?: string[]; // from x-run-task
}

interface RawSpec {
  info?: { title?: string; description?: string };
  paths?: Record<string, Record<string, unknown>>;
}

/** Operations of a spec, minus /health and /openapi.json (noise for an agent). */
export function extractOperations(spec: unknown): SpecOperation[] {
  const s = spec as RawSpec;
  const ops: SpecOperation[] = [];
  for (const [path, methods] of Object.entries(s.paths ?? {})) {
    if (path === "/health" || path.startsWith("/health/") || path === "/openapi.json") continue;
    for (const [method, raw] of Object.entries(methods ?? {})) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      const op = (raw ?? {}) as { summary?: string; description?: string; "x-run-task"?: unknown };
      const xTask = op["x-run-task"];
      const runTasks =
        typeof xTask === "string" ? [xTask]
        : Array.isArray(xTask) ? xTask.filter((t): t is string => typeof t === "string")
        : undefined;
      ops.push({
        method: method.toUpperCase(),
        path,
        summary: oneLine(op.summary || op.description),
        ...(runTasks?.length ? { runTasks } : {}),
      });
    }
  }
  return ops;
}

export function serviceDescription(name: string, spec: unknown): string {
  const curated = SERVICE_DESCRIPTIONS[name];
  if (curated) return curated;
  const info = (spec as RawSpec | null)?.info;
  return oneLine(info?.description || info?.title) || "(no description)";
}

/** Case-insensitive: every whitespace-separated token of `q` appears in `text`. */
export function matchesQuery(text: string, q: string | undefined): boolean {
  if (!q || !q.trim()) return true;
  const hay = text.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

// ---- run stats ----

/** One row of runs-service GET /internal/stats/task-outcomes. */
export interface TaskOutcome {
  taskName: string;
  totalRunCount: number;
  sampleSize: number;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  successRate: number | null;
  avgDurationMs: number | null;
  sumCompletedDurationMs: number;
  avgCostInUsdCents: string;
  sumCostInUsdCents: string;
  lastRunAt: string | null;
}

export interface RunStats {
  successRate: number | null;
  avgCostUsd: number;
  avgDurationMs: number | null;
  runs: number;
  sampled: number;
  lastRunAt: string | null;
  tasks?: string[];
}

export const NO_RUNS_YET = "no runs yet";
export const NOT_LINKED = "not measured: no run task linked to this endpoint yet";

/** Merge the outcomes of the tasks behind one endpoint. Exact: sums, then ratios. */
export function mergeOutcomes(outcomes: TaskOutcome[]): RunStats | null {
  const withRuns = outcomes.filter((o) => o.sampleSize > 0);
  if (withRuns.length === 0) return null;
  let sampled = 0, completed = 0, failed = 0, durMs = 0, costCents = 0, runs = 0;
  let lastRunAt: string | null = null;
  for (const o of withRuns) {
    sampled += o.sampleSize;
    completed += o.completedCount;
    failed += o.failedCount;
    durMs += o.sumCompletedDurationMs;
    costCents += Number(o.sumCostInUsdCents);
    runs += o.totalRunCount;
    if (o.lastRunAt && (!lastRunAt || o.lastRunAt > lastRunAt)) lastRunAt = o.lastRunAt;
  }
  const ended = completed + failed;
  return {
    successRate: ended > 0 ? Math.round((completed / ended) * 1000) / 1000 : null,
    avgCostUsd: Math.round((costCents / sampled / 100) * 1e6) / 1e6,
    avgDurationMs: completed > 0 ? Math.round(durMs / completed) : null,
    runs,
    sampled,
    lastRunAt,
    ...(withRuns.length > 1 ? { tasks: withRuns.map((o) => o.taskName) } : {}),
  };
}

const TASK_PATH_RE = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

/** "GET /v1/x/{id}?a=b" -> { method, segments } or null when the task is not a path. */
function parsePathTask(task: string): { method: string; segments: string[] } | null {
  const m = task.match(TASK_PATH_RE);
  if (!m) return null;
  return { method: m[1], segments: m[2].split("?")[0].split("/").filter(Boolean) };
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/**
 * The endpoint a "METHOD /path" task belongs to. A template `{param}` segment matches
 * any task segment; among several matching templates the most literal one wins
 * (`/brands/by-ids` beats `/brands/{id}`).
 */
export function matchPathTask(task: string, ops: SpecOperation[]): SpecOperation | null {
  const parsed = parsePathTask(task);
  if (!parsed) return null;
  let best: SpecOperation | null = null;
  let bestLiterals = -1;
  for (const op of ops) {
    if (op.method !== parsed.method) continue;
    const tpl = op.path.split("/").filter(Boolean);
    if (tpl.length !== parsed.segments.length) continue;
    let literals = 0;
    let ok = true;
    for (let i = 0; i < tpl.length; i++) {
      if (isParam(tpl[i])) continue;
      if (tpl[i] !== parsed.segments[i]) { ok = false; break; }
      literals++;
    }
    if (ok && literals > bestLiterals) { best = op; bestLiterals = literals; }
  }
  return best;
}

export interface EndpointWithStats {
  method: string;
  path: string;
  summary: string;
  stats: RunStats | string;
}

export interface UnlinkedTask {
  task: string;
  runs: number;
  successRate: number | null;
  avgCostUsd: number;
  avgDurationMs: number | null;
}

/**
 * Join a service's operations with its runs-service task outcomes.
 * Linking, in order: the producer's `x-run-task`, ENDPOINT_TASKS, "METHOD /path" task names.
 * An endpoint is "linked" when one of those names a task for it; a linked endpoint
 * with no runs says "no runs yet", an unlinked one says it is not measured.
 * Tasks that no endpoint claims are returned as `unlinked` (crons, internal jobs).
 */
export function joinStats(
  service: string,
  ops: SpecOperation[],
  outcomes: TaskOutcome[],
): { endpoints: EndpointWithStats[]; unlinked: UnlinkedTask[] } {
  const byTask = new Map(outcomes.map((o) => [o.taskName, o]));
  const curated = ENDPOINT_TASKS[service] ?? {};
  const claimed = new Set<string>();
  const tasksOf = new Map<SpecOperation, string[]>();

  for (const op of ops) {
    const names = op.runTasks ?? curated[`${op.method} ${op.path}`];
    if (names) {
      tasksOf.set(op, [...names]);
      names.forEach((n) => claimed.add(n));
    }
  }

  const pathConvention = outcomes.some((o) => TASK_PATH_RE.test(o.taskName));
  if (pathConvention) {
    for (const o of outcomes) {
      if (claimed.has(o.taskName)) continue;
      const op = matchPathTask(o.taskName, ops);
      if (!op) continue;
      tasksOf.set(op, [...(tasksOf.get(op) ?? []), o.taskName]);
      claimed.add(o.taskName);
    }
  }

  const endpoints = ops.map((op): EndpointWithStats => {
    const base = { method: op.method, path: op.path, summary: op.summary };
    const names = tasksOf.get(op);
    if (!names && !pathConvention) return { ...base, stats: NOT_LINKED };
    const merged = mergeOutcomes((names ?? []).map((n) => byTask.get(n)).filter((o): o is TaskOutcome => !!o));
    return { ...base, stats: merged ?? NO_RUNS_YET };
  });

  const unlinked = outcomes
    .filter((o) => !claimed.has(o.taskName) && o.sampleSize > 0)
    .map((o) => {
      const m = mergeOutcomes([o])!;
      return { task: o.taskName, runs: m.runs, successRate: m.successRate, avgCostUsd: m.avgCostUsd, avgDurationMs: m.avgDurationMs };
    });

  return { endpoints, unlinked };
}

/** Measured endpoints first (most runs first), then the spec's order. */
export function sortByRuns(endpoints: EndpointWithStats[]): EndpointWithStats[] {
  return endpoints
    .map((e, i) => ({ e, i, runs: typeof e.stats === "string" ? -1 : e.stats.runs }))
    .sort((a, b) => b.runs - a.runs || a.i - b.i)
    .map(({ e }) => e);
}
