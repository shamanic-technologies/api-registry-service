import { z } from "zod";
import type { TaskOutcome } from "./catalog.js";

// Client + cache for runs-service GET /internal/stats/task-outcomes (fleet-wide,
// per task: last-N-runs outcomes, duration and whole-subtree cost).
// The query takes seconds to tens of seconds on the busiest services, so results
// are cached and refreshed in the background: a stale answer is served while the
// refresh runs, and only a cold miss waits.
//
// Refresh cadence (BOX-LOAD-1107): each figure is a mean over a task's newest 200
// runs, and in prod the median task adds ~5 runs an hour (2.5 % of its sample;
// 5 of 274 active tasks turn the full 200 over in an hour). So a service is
// fetched at most once per STATS_TTL_MS (60 min), counted from the last ATTEMPT
// (success or failure), whichever path asks: the background sweep or a stale read.

const num = z.coerce.number();
const nullableNum = z.union([z.null(), z.coerce.number()]);
const decimal = z.union([z.string(), z.number()]).transform(String);

const TaskOutcomeSchema = z.object({
  taskName: z.string(),
  totalRunCount: num,
  sampleSize: num,
  completedCount: num,
  failedCount: num,
  runningCount: num,
  successRate: nullableNum,
  avgDurationMs: nullableNum,
  sumCompletedDurationMs: num,
  avgCostInUsdCents: decimal,
  sumCostInUsdCents: decimal,
  lastRunAt: z.string().nullable(),
});

const TaskOutcomesResponseSchema = z.object({
  serviceName: z.string(),
  sample: num,
  tasks: z.array(TaskOutcomeSchema),
});

export const STATS_SAMPLE = 200;
export const STATS_TTL_MS = 60 * 60_000;
/** How often the background sweep wakes to refresh the services whose stats are due. */
export const STATS_SWEEP_CHECK_MS = 5 * 60_000;
// runs-service lets this query run up to 290s (api-service takes 30-120s on a busy box);
// stay under undici's 300s headers timeout.
const STATS_TIMEOUT_MS = 295_000;

export type OutcomesResult =
  | { ok: true; outcomes: TaskOutcome[]; fetchedAt: string }
  | { ok: false; error: string };

interface RunsEntry {
  baseUrl: string;
  apiKey?: string;
}

export class TaskOutcomesCache {
  private cache = new Map<string, { outcomes: TaskOutcome[]; fetchedAt: number }>();
  private inflight = new Map<string, Promise<OutcomesResult>>();
  /** Last fetch START per service, success or failure: the refresh clock. */
  private lastAttempt = new Map<string, number>();

  constructor(
    private readonly opts: {
      getRunsEntry: () => RunsEntry | undefined;
      ttlMs?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  clear(): void {
    this.cache.clear();
    this.lastAttempt.clear();
  }

  private ttl(): number {
    return this.opts.ttlMs ?? STATS_TTL_MS;
  }

  /** True when no fetch for this service started within the TTL (and none is running). */
  isDue(runsServiceName: string): boolean {
    if (this.inflight.has(runsServiceName)) return false;
    const at = this.lastAttempt.get(runsServiceName);
    return at === undefined || this.now() - at >= this.ttl();
  }

  /** Refresh only when due: the background sweep's entry point. */
  async refreshIfDue(runsServiceName: string): Promise<void> {
    if (this.isDue(runsServiceName)) await this.refresh(runsServiceName);
  }

  /** Outcomes for one runs-service `service_name`. Stale-while-revalidate. */
  async get(runsServiceName: string): Promise<OutcomesResult> {
    const hit = this.cache.get(runsServiceName);
    if (hit) {
      if (this.now() - hit.fetchedAt >= this.ttl() && this.isDue(runsServiceName)) {
        void this.refresh(runsServiceName);
      }
      return { ok: true, outcomes: hit.outcomes, fetchedAt: new Date(hit.fetchedAt).toISOString() };
    }
    return this.refresh(runsServiceName);
  }

  /** Fetch now (deduplicated per service). A failure keeps any previous cached value. */
  refresh(runsServiceName: string): Promise<OutcomesResult> {
    const running = this.inflight.get(runsServiceName);
    if (running) return running;
    this.lastAttempt.set(runsServiceName, this.now());
    const p = this.fetchOutcomes(runsServiceName).finally(() => this.inflight.delete(runsServiceName));
    this.inflight.set(runsServiceName, p);
    return p;
  }

  private async fetchOutcomes(runsServiceName: string): Promise<OutcomesResult> {
    const entry = this.opts.getRunsEntry();
    if (!entry) {
      const error = "runs service not registered (RUNS_SERVICE_URL missing)";
      console.error(`[api-registry] task-outcomes ${runsServiceName}: ${error}`);
      return { ok: false, error };
    }
    const url = `${entry.baseUrl}/internal/stats/task-outcomes?serviceName=${encodeURIComponent(runsServiceName)}&sample=${STATS_SAMPLE}`;
    try {
      const res = await fetch(url, {
        headers: entry.apiKey ? { "x-api-key": entry.apiKey } : {},
        signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`runs-service HTTP ${res.status}`);
      const parsed = TaskOutcomesResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error(`runs-service response shape: ${parsed.error.issues[0]?.message}`);
      const fetchedAt = this.now();
      this.cache.set(runsServiceName, { outcomes: parsed.data.tasks, fetchedAt });
      return { ok: true, outcomes: parsed.data.tasks, fetchedAt: new Date(fetchedAt).toISOString() };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[api-registry] task-outcomes ${runsServiceName} failed: ${error}`);
      return { ok: false, error: `run stats unavailable: ${error}` };
    }
  }
}
