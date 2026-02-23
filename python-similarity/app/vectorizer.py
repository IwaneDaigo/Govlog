from __future__ import annotations

import logging
from typing import NamedTuple

import numpy as np

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Z-score 正規化
# ---------------------------------------------------------------------------


def zscore_normalize(
    vectors: dict[str, list[float]],
) -> tuple[dict[str, np.ndarray], int]:
    """
    自治体ベクトルを dataset 内で Z-score 正規化する。

    正規化は「特徴量次元ごと・全自治体をまたいで」行う。
    つまり各特徴量列について mean=0, std=1 になるよう変換する。

    std=0 の定数特徴量（全自治体が同値の列）は std を 1.0 にして 0 埋めする。

    Returns:
        (正規化済みベクトルの dict, 特徴量次元数)
        次元数 == 0 は有効な特徴量がなかったことを意味する。
    """
    if not vectors:
        return {}, 0

    areas = list(vectors.keys())

    # (自治体数, 特徴量数) の行列を構築
    matrix = np.array([vectors[a] for a in areas], dtype=np.float64)

    # 自治体が 1 件だけのとき 1D になる場合があるので 2D に統一
    if matrix.ndim == 1:
        matrix = matrix.reshape(len(areas), -1)

    # 特徴量が 0 次元ならスキップ
    if matrix.shape[1] == 0:
        return {a: np.array([]) for a in areas}, 0

    dim = matrix.shape[1]

    # 特徴量列ごとの平均・標準偏差を計算（axis=0 → 自治体方向に集計）
    mean = matrix.mean(axis=0)
    std = matrix.std(axis=0)

    # std=0 の列（定数列）は 0 除算を避けるため 1.0 に置き換える
    std[std == 0] = 1.0

    normalised = (matrix - mean) / std

    return {area: normalised[i] for i, area in enumerate(areas)}, dim


# ---------------------------------------------------------------------------
# 統合ベクトル生成
# ---------------------------------------------------------------------------


class DatasetBundle(NamedTuple):
    """
    1 つの dataset に対応する正規化済みベクトル群と重みをまとめた入れ物。
    vectorizer 内でのみ使用する。
    """

    # 正規化済みベクトル（cdArea -> ndarray）
    normalised: dict[str, np.ndarray]

    # 統合時に掛ける重み
    weight: float

    # 特徴量次元数（ゼロパディング時に参照する）
    dim: int


def build_combined_vectors(
    all_areas: list[str],
    bundles: list[DatasetBundle],
) -> dict[str, np.ndarray]:
    """
    全 dataset の正規化済みベクトルを重み付きで連結し、統合ベクトルを生成する。

    V_total(area) = [w1·V1_norm(area)  |  w2·V2_norm(area)  | …]

    dataset が存在しない自治体はゼロベクトルで補完する。
    """
    if not bundles:
        # dataset が 1 件もない場合はダミーのゼロベクトルを返す
        return {area: np.zeros(1) for area in all_areas}

    # area -> [部分ベクトルのリスト] を初期化
    combined: dict[str, list[np.ndarray]] = {area: [] for area in all_areas}

    for bundle in bundles:
        # dataset にない自治体に使うゼロベクトル（次元を合わせる）
        zero = np.zeros(bundle.dim if bundle.dim > 0 else 1)

        for area in all_areas:
            vec = bundle.normalised.get(area, zero)

            # 重みを掛けて部分ベクトルとして追加
            combined[area].append(bundle.weight * vec)

    # 各自治体の部分ベクトルリストを 1 本に連結して返す
    return {
        area: np.concatenate(parts) if parts else np.zeros(1)
        for area, parts in combined.items()
    }


# ---------------------------------------------------------------------------
# コサイン類似度・ランキング
# ---------------------------------------------------------------------------


def cosine_similarity(v1: np.ndarray, v2: np.ndarray) -> float:
    """
    2 つのベクトル間のコサイン類似度を返す（範囲: -1.0 〜 1.0）。
    どちらかがゼロベクトルの場合は 0.0 を返す。
    """
    n1 = np.linalg.norm(v1)
    n2 = np.linalg.norm(v2)

    # ゼロベクトルとの類似度は定義できないので 0 とする
    if n1 == 0.0 or n2 == 0.0:
        return 0.0

    return float(np.dot(v1, v2) / (n1 * n2))


def rank_candidates(
    base_area: str,
    candidate_areas: list[str],
    combined: dict[str, np.ndarray],
) -> list[tuple[str, float]]:
    """
    基準自治体に対するコサイン類似度で候補自治体を降順にソートして返す。

    Returns:
        [(cdArea, score), ...] のリスト（score 降順）
    """
    base_vec = combined.get(base_area)

    if base_vec is None:
        # 基準自治体のベクトルが見つからない場合は全員スコア 0
        logger.warning("Base area %s not found in combined vectors", base_area)
        return [(a, 0.0) for a in candidate_areas]

    # 各候補とのコサイン類似度を計算
    scores = [
        (
            area,
            cosine_similarity(base_vec, combined.get(area, np.zeros_like(base_vec))),
        )
        for area in candidate_areas
    ]

    # 類似度降順でソート（最も類似した自治体が先頭）
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores
