/**
 * Gov-Sync Similarity Service クライアント
 *
 * Python FastAPI サービス（python-similarity）への型付きクライアント。
 * 依存ライブラリなし。Node.js / ブラウザどちらでも動作する。
 *
 * 使い方:
 *   import { SimilarityClient } from "./similarity-client";
 *   const client = new SimilarityClient("http://localhost:8000");
 *   const result = await client.similarity({ ... });
 */

// ---------------------------------------------------------------------------
// 型定義（Python の models.py と 1:1 対応）
// ---------------------------------------------------------------------------

/** POST /similarity リクエストボディ */
export interface SimilarityRequest {
  /** 比較元の自治体コード（例: "13100"） */
  base_cdArea: string;

  /**
   * 類似度を計算したい自治体コードのリスト
   * 子育てキーワードが含まれる場合は childcare エンジンが使われるため無視される
   */
  candidate_cdAreas?: string[];

  /** 返却する上位件数（デフォルト: 20） */
  limit?: number;

  /**
   * 施策キーワード
   * 子育て関連ワード（"子育て", "保育", "待機児童" 等）が含まれると
   * 自動的に childcare エンジン（多軸モデル）へ切り替わる
   */
  keywords?: string[];

  /**
   * 使用する指標名を明示指定（指定時は keywords より優先、general モードのみ有効）
   * 例: ["A1101_総人口【人】", "C610109_売上金額（民営）（情報通信業）【百万円】"]
   */
  indicators?: string[];
}

/** POST /similarity/childcare リクエストボディ */
export interface ChildcareSimilarityRequest {
  /** 対象自治体コード（例: "01100"） */
  target_cdArea: string;

  /** 返却する上位件数（デフォルト: 10） */
  limit?: number;

  /** 各隣接自治体に返す寄与特徴量の数（デフォルト: 5） */
  top_n_features?: number;

  /** 年度コード（デフォルト: "2020100000"） */
  year_code?: string;

  /** 政令市区を除外するか（デフォルト: true） */
  top_level_only?: boolean;
}

/** 軸別コサイン類似度（general モードでは全て 0） */
export interface AxisSimilarityDetail {
  need: number;
  support: number;
  feasibility: number;
}

/** 1 候補自治体の類似度情報 */
export interface UnifiedNeighbor {
  city: string;
  city_name: string;
  total_similarity: number;
  /** general モードでは全て 0 */
  axis_similarity: AxisSimilarityDetail;
  /** general モードでは空配列 */
  top_features: string[];
}

/**
 * POST /similarity・POST /similarity/childcare 共通レスポンス
 * model_used で実際に使われたエンジンを判別できる
 */
export interface UnifiedSimilarityResponse {
  target_city: string;
  model_used: "general" | "childcare";

  /** KMeans クラスタ ID（general モードでは 0） */
  cluster_id: number;

  /**
   * 軸スコア
   * general モードでは need/support/feasibility=0、total のみ有効
   */
  scores: {
    need: number;
    support: number;
    feasibility: number;
    total: number;
  };

  /** 類似自治体リスト（total_similarity 降順） */
  neighbors: UnifiedNeighbor[];

  /** 実際に使用した指標名（general モードのみ、childcare では null） */
  selected_indicators: string[] | null;
}

/** GET /health レスポンス */
export interface HealthResponse {
  status: "ok";
  areas_loaded: number;
}

/** GET /indicators レスポンス */
export interface IndicatorsResponse {
  indicators: string[];
}

// ---------------------------------------------------------------------------
// エラー型
// ---------------------------------------------------------------------------

export class SimilarityApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Similarity API error ${status}: ${body}`);
    this.name = "SimilarityApiError";
  }
}

// ---------------------------------------------------------------------------
// クライアント本体
// ---------------------------------------------------------------------------

export class SimilarityClient {
  private readonly baseUrl: string;

  /**
   * @param baseUrl Python サービスのベース URL（末尾スラッシュなし）
   *                例: "http://localhost:8000"
   *                    "https://similarity.internal"
   */
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** サービスの死活確認 */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  /** 利用可能な指標名の一覧を取得 */
  async indicators(): Promise<string[]> {
    const res = await this.get<IndicatorsResponse>("/indicators");
    return res.indicators;
  }

  /**
   * 自治体類似度を計算してランキングを返す。
   * keywords に子育て関連ワードが含まれると自動的に childcare エンジンへ切り替わる。
   *
   * @example
   * // 汎用（キーワードで指標自動選定）
   * const result = await client.similarity({
   *   base_cdArea: "13100",
   *   candidate_cdAreas: ["27100", "28100", "01100"],
   *   keywords: ["観光"],
   *   limit: 5,
   * });
   *
   * @example
   * // 子育てキーワード → childcare エンジンへ自動切替
   * const result = await client.similarity({
   *   base_cdArea: "13100",
   *   keywords: ["子育て", "保育"],
   *   limit: 10,
   * });
   * // result.model_used === "childcare"
   */
  async similarity(req: SimilarityRequest): Promise<UnifiedSimilarityResponse> {
    return this.post<UnifiedSimilarityResponse>("/similarity", req);
  }

  /**
   * 子育て特化エンジンで類似自治体を直接取得する。
   * /similarity に子育てキーワードを渡した場合と同じエンジンが動く。
   */
  async similarityChildcare(
    req: ChildcareSimilarityRequest,
  ): Promise<UnifiedSimilarityResponse> {
    return this.post<UnifiedSimilarityResponse>("/similarity/childcare", req);
  }

  // ---------------------------------------------------------------------------
  // 内部ユーティリティ
  // ---------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
