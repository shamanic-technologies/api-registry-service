import MiniSearch from "minisearch";

export interface EndpointDocument {
  id: string;
  service: string;
  path: string;
  method: string;
  summary: string;
  description: string;
  bodyFields: string;
  responseFields: string;
  pathGroup: string; // e.g. "campaigns", "brands" — derived from first meaningful path segment
}

export interface IndexedEndpoint {
  service: string;
  method: string;
  path: string;
  summary: string;
  bodyFields?: string[];
  responseFields?: string[];
  pathGroup: string;
}

function derivePathGroup(path: string): string {
  // /v1/campaigns/{id}/leads → "campaigns"
  // /brands/{brandId}/extract-fields → "brands"
  // /health → "health"
  // /internal/app-keys → "internal/app-keys"
  const segments = path.split("/").filter(Boolean);
  // Skip version prefixes like "v1", "v2"
  const start = segments[0]?.match(/^v\d+$/) ? 1 : 0;
  const group = segments[start];
  if (!group) return "root";
  // If group is a path param like {id}, skip it
  if (group.startsWith("{")) return segments[start + 1] || "root";
  return group;
}

export interface SearchOptions {
  query: string;
  service?: string;
  method?: string;
  pathPrefix?: string;
  limit?: number;
}

export interface SearchResult {
  service: string;
  method: string;
  path: string;
  summary: string;
  score: number;
  bodyFields?: string[];
  responseFields?: string[];
}

export class EndpointSearchIndex {
  private index: MiniSearch<EndpointDocument>;
  private documents = new Map<string, IndexedEndpoint>();

  constructor() {
    this.index = new MiniSearch<EndpointDocument>({
      fields: ["service", "path", "method", "summary", "description", "bodyFields", "responseFields"],
      storeFields: ["service", "path", "method", "summary", "bodyFields", "responseFields", "pathGroup"],
      idField: "id",
      searchOptions: {
        boost: {
          summary: 3,
          description: 2,
          service: 2,
          path: 1.5,
          bodyFields: 1,
          responseFields: 0.8,
          method: 0.5,
        },
        prefix: true,
        fuzzy: 0.2,
        combineWith: "AND",
      },
      // Split path segments on / and - so "/brands/{brandId}/extract-fields" indexes as separate tokens
      tokenize: (text: string, fieldName?: string) => {
        if (fieldName === "path") {
          return text.split(/[/\-{}]+/).filter(Boolean).map(t => t.toLowerCase());
        }
        // Default tokenization: split on whitespace and punctuation
        return text.split(/[\s\-_/{}(),.]+/).filter(Boolean).map(t => t.toLowerCase());
      },
    });
  }

  clear(): void {
    this.index.removeAll();
    this.documents.clear();
  }

  addEndpoint(endpoint: IndexedEndpoint): void {
    const id = `${endpoint.service}:${endpoint.method}:${endpoint.path}`;
    if (this.documents.has(id)) return; // skip duplicates

    this.documents.set(id, endpoint);

    const doc: EndpointDocument = {
      id,
      service: endpoint.service,
      path: endpoint.path,
      method: endpoint.method,
      summary: endpoint.summary,
      description: endpoint.summary, // summary often contains the best searchable text
      bodyFields: endpoint.bodyFields?.join(" ") || "",
      responseFields: endpoint.responseFields?.join(" ") || "",
      pathGroup: endpoint.pathGroup,
    };

    this.index.add(doc);
  }

  addEndpoints(endpoints: IndexedEndpoint[]): void {
    for (const ep of endpoints) {
      this.addEndpoint(ep);
    }
  }

  search(options: SearchOptions): SearchResult[] {
    const { query, service, method, pathPrefix, limit = 20 } = options;

    const results = this.index.search(query, {
      filter: (result) => {
        if (service && result.service !== service) return false;
        if (method && result.method !== method.toUpperCase()) return false;
        if (pathPrefix && !result.path.startsWith(pathPrefix)) return false;
        return true;
      },
    });

    return results.slice(0, limit).map((r) => ({
      service: r.service as string,
      method: r.method as string,
      path: r.path as string,
      summary: r.summary as string,
      score: Math.round(r.score * 100) / 100,
      bodyFields: r.bodyFields ? (r.bodyFields as string).split(" ").filter(Boolean) : undefined,
      responseFields: r.responseFields ? (r.responseFields as string).split(" ").filter(Boolean) : undefined,
    }));
  }

  get size(): number {
    return this.documents.size;
  }
}

export { derivePathGroup };
