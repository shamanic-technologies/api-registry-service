import { z } from "zod";

// Client + cache for features-service's step catalogue (GET /internal/catalogue/steps
// and /steps/{id}): each step's value in USD (fleet median lifetime revenue x the best
// rated route to Paid client) and, for a declared step, what produces it (`producedBy`).
// An endpoint's ROI = valueUsd of the step it produces / its average cost per call.

const ListSchema = z.object({
  total: z.coerce.number(),
  truncated: z.boolean(),
  rows: z.array(z.object({ id: z.string(), name: z.string(), valueUsd: z.union([z.null(), z.coerce.number()]) })),
});

const DetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  valueUsd: z.union([z.null(), z.coerce.number()]),
  producedBy: z.string().nullable().optional(),
});

export interface StepInfo {
  id: string;
  name: string;
  valueUsd: number | null;
  producedBy: string | null;
}

export type StepsResult = { ok: true; steps: Map<string, StepInfo> } | { ok: false; error: string };

export const STEPS_TTL_MS = 15 * 60_000;
const LIST_LIMIT = 25; // features-service max page

interface FeaturesEntry {
  baseUrl: string;
  apiKey?: string;
}

const PRODUCED_BY_RE = /^([a-z0-9-]+)\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i;

/**
 * "apollo POST /search/next" (or "apollo-service POST /search/next") -> registry
 * service + endpoint key. Anything else (a free-text producer) -> null.
 */
export function parseProducedBy(producedBy: string | null | undefined): { service: string; endpoint: string } | null {
  const m = producedBy?.trim().match(PRODUCED_BY_RE);
  if (!m) return null;
  return { service: m[1].toLowerCase().replace(/-service$/, ""), endpoint: `${m[2].toUpperCase()} ${m[3]}` };
}

export class StepCatalogCache {
  private cache: { steps: Map<string, StepInfo>; at: number } | null = null;
  private inflight: Promise<StepsResult> | null = null;

  constructor(
    private readonly opts: { getFeaturesEntry: () => FeaturesEntry | undefined; ttlMs?: number; now?: () => number },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  clear(): void {
    this.cache = null;
  }

  async get(): Promise<StepsResult> {
    if (this.cache) {
      if (this.now() - this.cache.at >= (this.opts.ttlMs ?? STEPS_TTL_MS)) void this.refresh();
      return { ok: true, steps: this.cache.steps };
    }
    return this.refresh();
  }

  refresh(): Promise<StepsResult> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<StepsResult> {
    const entry = this.opts.getFeaturesEntry();
    if (!entry) {
      const error = "features service not registered (FEATURES_SERVICE_URL missing)";
      console.error(`[api-registry] step catalogue: ${error}`);
      return { ok: false, error };
    }
    const headers = entry.apiKey ? { "x-api-key": entry.apiKey } : undefined;
    const read = async (path: string) => {
      const res = await fetch(`${entry.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`features-service ${path.split("?")[0]} HTTP ${res.status}`);
      return res.json();
    };
    try {
      const list = ListSchema.parse(await read(`/internal/catalogue/steps?limit=${LIST_LIMIT}`));
      if (list.truncated) {
        console.warn(`[api-registry] step catalogue truncated: read ${list.rows.length} of ${list.total} steps`);
      }
      const details = await Promise.all(
        list.rows.map(async (row) => DetailSchema.parse(await read(`/internal/catalogue/steps/${encodeURIComponent(row.id)}`))),
      );
      const steps = new Map<string, StepInfo>(
        details.map((d) => [d.id, { id: d.id, name: d.name, valueUsd: d.valueUsd, producedBy: d.producedBy ?? null }]),
      );
      this.cache = { steps, at: this.now() };
      return { ok: true, steps };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[api-registry] step catalogue failed: ${error}`);
      return { ok: false, error: `step values unavailable: ${error}` };
    }
  }
}
