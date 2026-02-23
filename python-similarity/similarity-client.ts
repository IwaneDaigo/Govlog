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

  /** 類似度を計算したい自治体コードのリスト */
  candidate_cdAreas: string[];

  /** 返却する上位件数（デフォルト: 20） */
  limit?: number;

  /**
   * 施策キーワード（売上系指標の自動選定に使用）
   * 例: ["観光", "IT"]
   * 省略 or 空配列 → 全売上指標を使用
   */
  keywords?: string[];

  /**
   * 使用する指標名を明示指定（指定時は keywords より優先）
   * 例: ["A1101_総人口【人】", "C610109_売上金額（民営）（情報通信業）【百万円】"]
   */
  indicators?: string[];
}

/** POST /similarity レスポンスボディ */
export interface SimilarityResponse {
  /** 類似度が高い順の cdArea リスト */
  items: string[];

  /** cdArea → 自治体名（例: { "28100": "兵庫県神戸市" }） */
  names?: Record<string, string>;

  /** cdArea → 類似度スコア（-1 〜 1、高いほど類似） */
  scores?: Record<string, number>;

  /** 実際に使用した指標名のリスト */
  selected_indicators?: string[];
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
   * 自治体類似度を計算してランキングを返す
   *
   * @example
   * // キーワードで自動選定
   * const result = await client.similarity({
   *   base_cdArea: "13100",
   *   candidate_cdAreas: ["27100", "28100", "01100"],
   *   keywords: ["観光"],
   *   limit: 5,
   * });
   *
   * @example
   * // 指標を明示指定
   * const result = await client.similarity({
   *   base_cdArea: "13100",
   *   candidate_cdAreas: ["27100", "28100"],
   *   indicators: ["A1101_総人口【人】", "D2201_財政力指数（市町村財政）【‐】"],
   * });
   */
  async similarity(req: SimilarityRequest): Promise<SimilarityResponse> {
    return this.post<SimilarityResponse>("/similarity", req);
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
