import { z } from "zod";
import type { TaskOutcome } from "./catalog.js";

// Client + cache for runs-service GET /internal/stats/task-outcomes (fleet-wide,
// per task: last-N-runs outcomes, duration and whole-subtree cost).
// The query takes seconds to tens of seconds on the busiest services, so results
// are cached and refreshed in the background: a stale answer is served while the
// refresh runs, and only a cold miss waits.

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
export const STATS_TTL_MS = 15 * 60_000;
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
  }

  /** Outcomes for one runs-service `service_name`. Stale-while-revalidate. */
  async get(runsServiceName: string): Promise<OutcomesResult> {
    const hit = this.cache.get(runsServiceName);
    if (hit) {
      if (this.now() - hit.fetchedAt >= (this.opts.ttlMs ?? STATS_TTL_MS)) {
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
