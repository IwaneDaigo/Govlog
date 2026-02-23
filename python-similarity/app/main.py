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
from app.models import SimilarityRequest, SimilarityResponse
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


@app.post("/similarity", response_model=SimilarityResponse)
async def similarity(req: SimilarityRequest) -> SimilarityResponse:
    """
    ローカルデータ（dataSet_clean.csv）を使って自治体類似度を計算し、
    類似度降順の cdArea リストを返す。

    【指標の選定優先順位】
      1. indicators が明示指定されていればそのまま使用
      2. keywords があれば指標名マッチ＋同義語辞書で自動選定
      3. どちらもなければ全指標を使用

    処理の流れ:
        1. 指標を選定
        2. 対象自治体の特徴量ベクトルを生成
        3. Z-score 正規化
        4. cosine 類似度でランキング
        5. items（cdArea の配列）を返す
    """
    all_areas = [req.base_cdArea] + req.candidate_cdAreas

    # ------------------------------------------------------------------
    # STEP 1: 使用する指標を決定
    # ------------------------------------------------------------------
    if req.indicators:
        # 明示指定を優先
        keys = req.indicators
        logger.info("Using explicitly specified indicators: %s", keys)

    elif req.keywords:
        # キーワードから自動選定（直接マッチ → 同義語辞書）
        keys = select_indicators(req.keywords, all_indicator_names)

    else:
        # 全指標を使用
        keys = None
        logger.info("No keywords specified; using all indicators")

    # ------------------------------------------------------------------
    # STEP 2: 特徴量ベクトルを生成
    # ------------------------------------------------------------------
    raw_vectors = dataset_to_vectors(dataset, all_areas, keys=keys)

    # ------------------------------------------------------------------
    # STEP 3: Z-score 正規化
    # ------------------------------------------------------------------
    normalised, dim = zscore_normalize(raw_vectors)

    if dim == 0:
        logger.warning("No valid features; returning candidates in original order")
        return SimilarityResponse(items=req.candidate_cdAreas[: req.limit])

    # ------------------------------------------------------------------
    # STEP 4: 統合ベクトル構築 → cosine 類似度でランキング
    # ------------------------------------------------------------------
    bundle   = DatasetBundle(normalised=normalised, weight=1.0, dim=dim)
    combined = build_combined_vectors(all_areas, [bundle])
    ranked   = rank_candidates(req.base_cdArea, req.candidate_cdAreas, combined)
    ranked   = ranked[: req.limit]

    items = [area for area, _ in ranked]

    # keys が None のとき（全指標）はレスポンスには含めない
    used_indicators = keys if keys is not None else None

    return SimilarityResponse(
        items=items,
        names={area: municipality_map.get(area, area) for area in items},
        scores={area: round(score, 6) for area, score in ranked},
        selected_indicators=used_indicators,
    )
