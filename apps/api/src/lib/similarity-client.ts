export interface SimilarityRequest {
  base_cdArea: string;
  candidate_cdAreas: string[];
  limit?: number;
  keywords?: string[];
  indicators?: string[];
}

export interface AxisSimilarityDetail {
  need: number;
  support: number;
  feasibility: number;
}

export interface UnifiedNeighbor {
  city: string;
  city_name: string;
  total_similarity: number;
  axis_similarity: AxisSimilarityDetail;
  top_features: string[];
}

export interface SimilarityResponse {
  target_city: string;
  model_used: "general" | "childcare";
  cluster_id: number;
  scores: { need: number; support: number; feasibility: number; total: number };
  neighbors: UnifiedNeighbor[];
  selected_indicators?: string[];
}

export interface HealthResponse {
  status: "ok";
  areas_loaded: number;
}

export interface MunicipalityDataResponse {
  cd_area: string;
  indicators: Record<string, number>;
}

export class SimilarityApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Similarity API error ${status}: ${body}`);
    this.name = "SimilarityApiError";
  }
}

export class SimilarityClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  async similarity(req: SimilarityRequest): Promise<SimilarityResponse> {
    return this.post<SimilarityResponse>("/similarity", req);
  }

  async municipalityData(cdArea: string): Promise<MunicipalityDataResponse> {
    return this.get<MunicipalityDataResponse>(`/municipality/${encodeURIComponent(cdArea)}`);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text();
      throw new SimilarityApiError(res.status, text);
    }
    return res.json() as Promise<T>;
  }
}

