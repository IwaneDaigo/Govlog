from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI

from app.dataset_loader import (
    available_indicators,
    dataset_to_vectors,
)
from app.estat_client import fetch_all_data
from app.indicator_selector import select_indicators
from app.childcare_similarity import run_similarity
from app.models import (
    AxisSimilarityDetail,
    ChildcareSimilarityRequest,
    SimilarityRequest,
    UnifiedNeighbor,
    UnifiedSimilarityResponse,
)
from app.municipality import all_cd_areas, load_municipality_map
from app.vectorizer import (
    DatasetBundle,
    build_combined_vectors,
    rank_candidates,
    zscore_normalize,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

MUNICIPALITY_CSV = Path("municipalty.csv")


# ---------------------------------------------------------------------------
# 起動時にデータをメモリへ展開
# ---------------------------------------------------------------------------

dataset: dict        = {}  # {cd_area: {指標名: float | None}}
municipality_map: dict = {}  # {cd_area: 自治体名}
all_indicator_names: list[str] = []  # 全指標名（ソート済み）


@asynccontextmanager
async def lifespan(app: FastAPI):
    """起動時: e-Stat API からデータを取得してメモリに展開する。終了時: 特に処理なし。"""
    global dataset, municipality_map, all_indicator_names

    app_id           = os.environ["ESTAT_APP_ID"]
    municipality_map = load_municipality_map(MUNICIPALITY_CSV)
    cd_areas         = all_cd_areas(municipality_map)

    dataset             = await fetch_all_data(app_id, cd_areas)
    all_indicator_names = available_indicators(dataset)

    yield


app = FastAPI(title="Gov-Sync Similarity Service", lifespan=lifespan)


# ---------------------------------------------------------------------------
# 子育てキーワード判定
# ---------------------------------------------------------------------------

_CHILDCARE_KEYWORDS: frozenset[str] = frozenset([
    "子育て", "こども", "子ども", "子供",
    "保育", "保育所", "保育園",
    "育児", "育休", "産休",
    "幼稚園", "幼児", "乳幼児",
    "児童", "出生", "少子化", "待機児童",
])


def _is_childcare_request(keywords: list[str]) -> bool:
    """キーワードリストに子育て関連ワードが 1 つでも含まれれば True。"""
    return any(kw in _CHILDCARE_KEYWORDS for kw in keywords)


# ---------------------------------------------------------------------------
# エンドポイント
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    """死活確認。ロード済み自治体数も返す。"""
    return {"status": "ok", "areas_loaded": len(dataset)}


@app.get("/indicators")
async def indicators() -> dict:
    """利用可能な指標名の一覧を返す。"""
    return {"indicators": all_indicator_names}


@app.post("/similarity", response_model=UnifiedSimilarityResponse)
async def similarity(req: SimilarityRequest) -> UnifiedSimilarityResponse:
    """
    自治体類似度を計算して UnifiedSimilarityResponse を返す。

    【モード自動切替】
      keywords に子育て関連ワードが含まれる場合 → childcare エンジン（多軸モデル）
      それ以外 → general エンジン（コサイン類似度）

    【general モードの指標選定優先順位】
      1. indicators が明示指定されていればそのまま使用
      2. keywords があれば指標名マッチ＋同義語辞書で自動選定
      3. どちらもなければ全指標を使用
    """
    # ------------------------------------------------------------------
    # 子育てキーワード → childcare エンジンへルーティング
    # ------------------------------------------------------------------
    if req.keywords and _is_childcare_request(req.keywords):
        logger.info("childcare keywords detected: %s → routing to childcare engine", req.keywords)
        result = run_similarity(
            target_cd_area=req.base_cdArea,
            limit=req.limit,
        )
        return UnifiedSimilarityResponse(
            target_city=result["target_city"],
            model_used="childcare",
            cluster_id=result["cluster_id"],
            scores=result["scores"],
            neighbors=[
                UnifiedNeighbor(
                    city=nb["city"],
                    city_name=nb["city_name"],
                    total_similarity=nb["total_similarity"],
                    axis_similarity=AxisSimilarityDetail(**nb["axis_similarity"]),
                    top_features=nb["top_features"],
                )
                for nb in result["neighbors"]
            ],
            selected_indicators=None,
        )

    # ------------------------------------------------------------------
    # general エンジン
    # ------------------------------------------------------------------
    all_areas = [req.base_cdArea] + req.candidate_cdAreas

    # STEP 1: 使用する指標を決定
    if req.indicators:
        keys = req.indicators
        logger.info("Using explicitly specified indicators: %s", keys)
    elif req.keywords:
        keys = select_indicators(req.keywords, all_indicator_names)
    else:
        keys = None
        logger.info("No keywords specified; using all indicators")

    # STEP 2: 特徴量ベクトルを生成
    raw_vectors = dataset_to_vectors(dataset, all_areas, keys=keys)

    # STEP 3: Z-score 正規化
    normalised, dim = zscore_normalize(raw_vectors)

    if dim == 0:
        logger.warning("No valid features; returning candidates in original order")
        return UnifiedSimilarityResponse(
            target_city=req.base_cdArea,
            model_used="general",
            scores={"need": 0.0, "support": 0.0, "feasibility": 0.0, "total": 0.0},
            neighbors=[
                UnifiedNeighbor(
                    city=area,
                    city_name=municipality_map.get(area, area),
                    total_similarity=0.0,
                    axis_similarity=AxisSimilarityDetail(),
                    top_features=[],
                )
                for area in req.candidate_cdAreas[: req.limit]
            ],
        )

    # STEP 4: 統合ベクトル構築 → cosine 類似度でランキング
    bundle   = DatasetBundle(normalised=normalised, weight=1.0, dim=dim)
    combined = build_combined_vectors(all_areas, [bundle])
    ranked   = rank_candidates(req.base_cdArea, req.candidate_cdAreas, combined)
    ranked   = ranked[: req.limit]

    avg_score = sum(s for _, s in ranked) / len(ranked) if ranked else 0.0

    return UnifiedSimilarityResponse(
        target_city=req.base_cdArea,
        model_used="general",
        scores={"need": 0.0, "support": 0.0, "feasibility": 0.0, "total": round(avg_score, 6)},
        neighbors=[
            UnifiedNeighbor(
                city=area,
                city_name=municipality_map.get(area, area),
                total_similarity=round(score, 6),
                axis_similarity=AxisSimilarityDetail(),
                top_features=[],
            )
            for area, score in ranked
        ],
        selected_indicators=keys if keys is not None else None,
    )


@app.post("/similarity/childcare", response_model=UnifiedSimilarityResponse)
async def similarity_childcare(req: ChildcareSimilarityRequest) -> UnifiedSimilarityResponse:
    """
    子育て施策に特化した多軸類似度モデルで類似自治体を抽出する。

    【モデルの特徴】
      - 課題構造・支援供給・財政実現可能性の 3 軸でコサイン類似度を計算
      - 財政力指数 ±0.1 / 経常収支比率 ±5% の財政制約フィルタ
      - KMeans クラスタリングによる同類型分類
      - 寄与度（特徴量差分）による説明可能な出力
    """
    logger.info("childcare similarity request: target=%s", req.target_cdArea)

    result = run_similarity(
        target_cd_area=req.target_cdArea,
        year_code=req.year_code,
        top_level_only=req.top_level_only,
        limit=req.limit,
        top_n_features=req.top_n_features,
    )

    return UnifiedSimilarityResponse(
        target_city=result["target_city"],
        model_used="childcare",
        cluster_id=result["cluster_id"],
        scores=result["scores"],
        neighbors=[
            UnifiedNeighbor(
                city=nb["city"],
                city_name=nb["city_name"],
                total_similarity=nb["total_similarity"],
                axis_similarity=AxisSimilarityDetail(**nb["axis_similarity"]),
                top_features=nb["top_features"],
            )
            for nb in result["neighbors"]
        ],
        selected_indicators=None,
    )
