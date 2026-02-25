from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI

from app.childcare_similarity import run_similarity
from app.dataset_loader import available_indicators, dataset_to_vectors
from app.estat_client import fetch_all_data
from app.indicator_selector import select_indicators
from app.models import (
    AxisSimilarityDetail,
    ChildcareSimilarityRequest,
    MunicipalityDataResponse,
    SimilarityRequest,
    UnifiedNeighbor,
    UnifiedSimilarityResponse,
)
from app.municipality import all_cd_areas, load_municipality_map
from app.vectorizer import DatasetBundle, build_combined_vectors, rank_candidates, zscore_normalize

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

MUNICIPALITY_CSV = Path("municipalty.csv")

dataset: dict = {}
municipality_map: dict = {}
all_indicator_names: list[str] = []


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global dataset, municipality_map, all_indicator_names

    app_id = os.environ["ESTAT_APP_ID"]
    municipality_map = load_municipality_map(MUNICIPALITY_CSV)
    cd_areas = all_cd_areas(municipality_map)

    dataset = await fetch_all_data(app_id, cd_areas)
    all_indicator_names = available_indicators(dataset)
    yield


app = FastAPI(title="Gov-Sync Similarity Service", lifespan=lifespan)

_CHILDCARE_KEYWORDS: frozenset[str] = frozenset(
    [
        # 子育て・保育
        "子育て",
        "子ども",
        "こども",
        "保育",
        "育児",
        "待機児童",
        "幼児",
        "児童",
        "出産",
        "妊娠",
        "母子",
        "保護者",
        "小児",
        "家庭支援",
        "学童",
        "放課後",
        "幼稚園",
        "認定こども園",
        "ファミリーサポート",
        # 教育・学習
        "教育",
        "学校",
        "学習",
        "学力",
        "奨学金",
        "不登校",
        "いじめ",
        "特別支援",
        "就学",
        "小学校",
        "中学校",
        "高校",
        "高等学校",
        "義務教育",
        "生涯学習",
        "塾",
        "習い事",
        # 少子化・子どもの貧困
        "少子化",
        "出生率",
        "子どもの貧困",
        "ひとり親",
        "養育",
    ]
)


def _is_childcare_request(keywords: list[str]) -> bool:
    return any(kw in _CHILDCARE_KEYWORDS for kw in keywords)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "areas_loaded": len(dataset)}


@app.get("/indicators")
async def indicators() -> dict:
    return {"indicators": all_indicator_names}


@app.get("/municipality/{cd_area}", response_model=MunicipalityDataResponse)
async def municipality_data(cd_area: str) -> MunicipalityDataResponse:
    row = dataset.get(cd_area, {})
    indicators = {key: float(value) for key, value in row.items() if value is not None}
    return MunicipalityDataResponse(cd_area=cd_area, indicators=indicators)


@app.post("/similarity", response_model=UnifiedSimilarityResponse)
async def similarity(req: SimilarityRequest) -> UnifiedSimilarityResponse:
    if req.keywords and _is_childcare_request(req.keywords):
        result = run_similarity(target_cd_area=req.base_cdArea, limit=req.limit)
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

    all_areas = [req.base_cdArea] + req.candidate_cdAreas
    if req.indicators:
        keys = req.indicators
    elif req.keywords:
        keys = select_indicators(req.keywords, all_indicator_names)
    else:
        keys = None

    raw_vectors = dataset_to_vectors(dataset, all_areas, keys=keys)
    normalised, dim = zscore_normalize(raw_vectors)

    if dim == 0:
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
            selected_indicators=keys if keys is not None else None,
        )

    bundle = DatasetBundle(normalised=normalised, weight=1.0, dim=dim)
    combined = build_combined_vectors(all_areas, [bundle])
    ranked = rank_candidates(req.base_cdArea, req.candidate_cdAreas, combined)[: req.limit]
    avg_score = sum(score for _, score in ranked) / len(ranked) if ranked else 0.0

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

