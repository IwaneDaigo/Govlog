from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# リクエスト
# ---------------------------------------------------------------------------


class SimilarityRequest(BaseModel):
    """
    POST /similarity のリクエストボディ。
    TypeScript（Node バック）から送信される。
    子育て関連キーワードが含まれる場合は自動的に childcare エンジンへルーティングされる。
    """

    # 比較元の自治体コード
    base_cdArea: str

    # 類似度を計算したい自治体コードのリスト（childcare モード時は無視される）
    candidate_cdAreas: list[str] = Field(default_factory=list)

    # 返却する上位件数
    limit: int = 20

    # 施策キーワード（子育て系ワードが含まれると childcare エンジンへ自動切替）
    keywords: list[str] = Field(default_factory=list)

    # 使用する指標名を明示指定（指定時は keywords より優先、general モードのみ有効）
    indicators: Optional[list[str]] = None


class ChildcareSimilarityRequest(BaseModel):
    """
    POST /similarity/childcare のリクエストボディ。
    多軸類似度モデル（課題構造・支援供給・財政実現可能性）を使用する。
    """

    # 対象自治体コード
    target_cdArea: str

    # 返却する上位件数
    limit: int = 10

    # 寄与特徴量として返す上位件数
    top_n_features: int = 5

    # 使用する年度コード（デフォルト: 2020年度）
    year_code: str = "2020100000"

    # 政令市区を除外するか
    top_level_only: bool = True


# ---------------------------------------------------------------------------
# 共通パーツ
# ---------------------------------------------------------------------------


class AxisSimilarityDetail(BaseModel):
    """軸別コサイン類似度。general モードでは全て 0.0。"""
    need: float = 0.0
    support: float = 0.0
    feasibility: float = 0.0


class UnifiedNeighbor(BaseModel):
    """1 候補自治体の類似度情報（general / childcare 共通）。"""
    city: str
    city_name: str
    total_similarity: float
    axis_similarity: AxisSimilarityDetail   # general モードでは全て 0.0
    top_features: list[str]                  # general モードでは空リスト


# ---------------------------------------------------------------------------
# 統一レスポンス（POST /similarity・POST /similarity/childcare 共通）
# ---------------------------------------------------------------------------


class UnifiedSimilarityResponse(BaseModel):
    """
    両エンドポイント共通のレスポンスボディ。
    model_used で実際に使われたエンジンを示す。
    general モードでは cluster_id=0、scores の need/support/feasibility=0.0。
    """

    target_city: str
    model_used: Literal["general", "childcare"]

    # KMeans クラスタ ID（general モードでは 0）
    cluster_id: int = 0

    # 軸スコア（general モードでは need/support/feasibility=0.0、total のみ有効）
    scores: dict[str, float]

    # 類似自治体リスト（total_similarity 降順）
    neighbors: list[UnifiedNeighbor]

    # 実際に使用した指標名（general モードのみ、childcare では None）
    selected_indicators: Optional[list[str]] = None


# ---------------------------------------------------------------------------
# 後方互換（既存コードが参照している場合のために残す）
# ---------------------------------------------------------------------------

NeighborResult = UnifiedNeighbor
ChildcareSimilarityResponse = UnifiedSimilarityResponse
SimilarityResponse = UnifiedSimilarityResponse


class MunicipalityDataResponse(BaseModel):
    """
    GET /municipality/{cd_area} のレスポンス。
    取得済み指標のみを返す。
    """

    cd_area: str
    indicators: dict[str, float]
