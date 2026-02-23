from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# リクエスト
# ---------------------------------------------------------------------------


class SimilarityRequest(BaseModel):
    """
    POST /similarity のリクエストボディ。
    TypeScript（Node バック）から送信される。
    """

    # 比較元の自治体コード
    base_cdArea: str

    # 類似度を計算したい自治体コードのリスト
    candidate_cdAreas: list[str]

    # 返却する上位件数
    limit: int = 20

    # 施策キーワード（売上系指標の自動選定に使用）
    # 省略時 or 空リスト → 全売上指標を使用
    keywords: list[str] = Field(default_factory=list)

    # 使用する指標名を明示指定（指定時は keywords より優先）
    # 例: ["A1101_総人口【人】", "C610107_売上金額（民営）（製造業）【百万円】"]
    indicators: Optional[list[str]] = None


# ---------------------------------------------------------------------------
# レスポンス
# ---------------------------------------------------------------------------


class SimilarityResponse(BaseModel):
    """
    POST /similarity のレスポンスボディ。
    items の順序（類似度降順）が最重要。
    """

    # 類似度が高い順の cdArea リスト（ランキング）
    items: list[str]

    # cdArea → 自治体名（municipalty.csv から引いた値）
    names: Optional[dict[str, str]] = None

    # 各 cdArea の類似度スコア（デバッグ・説明用）
    scores: Optional[dict[str, float]] = None

    # 実際に使用した指標名のリスト（デバッグ・説明用）
    selected_indicators: Optional[list[str]] = None
