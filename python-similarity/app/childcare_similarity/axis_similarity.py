"""
軸別コサイン類似度と寄与度算出

【計算フロー】
  1. 各軸（need / support / feasibility）のコサイン類似度を個別計算
  2. axis_weights による加重平均で total_similarity を算出
  3. 対象自治体と候補自治体の特徴量差分から「上位寄与特徴量」を抽出
  4. 結果を NeighborScore のリストとして返す

【コサイン類似度の選択理由】
  絶対値のスケールではなく「構造の向き（方向）の一致度」を測るため、
  人口規模が異なる自治体でも課題構造の類似性を検出できる。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .feature_config import AXIS_WEIGHTS

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# データクラス
# ---------------------------------------------------------------------------


@dataclass
class AxisScore:
    """1 自治体ペアの軸別類似度スコア。"""
    need: float
    support: float
    feasibility: float


@dataclass
class NeighborScore:
    """1 候補自治体の類似度スコアと寄与特徴量。"""
    cd_area: str
    area_name: str
    total_similarity: float
    axis_similarity: AxisScore
    top_features: list[str]   # 類似度に最も寄与した特徴量名（上位 N 件）


# ---------------------------------------------------------------------------
# コサイン類似度
# ---------------------------------------------------------------------------


def _cosine_similarity(v1: np.ndarray, v2: np.ndarray) -> float:
    """
    2 ベクトル間のコサイン類似度を返す（範囲: -1.0 〜 1.0）。
    どちらかがゼロベクトルの場合は 0.0 を返す。
    """
    n1 = np.linalg.norm(v1)
    n2 = np.linalg.norm(v2)
    if n1 == 0.0 or n2 == 0.0:
        return 0.0
    return float(np.dot(v1, v2) / (n1 * n2))


def _axis_vector(row: pd.Series, cols: list[str]) -> np.ndarray:
    """
    指定カラムの値を 1 次元 numpy 配列として取り出す。
    カラムが空の場合は長さ 1 のゼロベクトルを返す。
    """
    if not cols:
        return np.zeros(1)
    return row[cols].fillna(0).to_numpy(dtype=np.float64)


# ---------------------------------------------------------------------------
# 寄与度算出
# ---------------------------------------------------------------------------


def _top_contributing_features(
    target_row: pd.Series,
    candidate_row: pd.Series,
    all_feature_cols: list[str],
    top_n: int = 5,
) -> list[str]:
    """
    対象自治体と候補自治体の間で「最も差が小さい特徴量」を寄与度上位として返す。

    差が小さい = 両者の値が近い = その特徴量が類似度に大きく貢献している。

    Args:
        target_row       : 対象自治体の行（標準化済み）
        candidate_row    : 候補自治体の行（標準化済み）
        all_feature_cols : 比較に使う全特徴量カラム名
        top_n            : 返す特徴量数（デフォルト: 5）

    Returns:
        差が小さい順の特徴量名リスト（長さ ≤ top_n）
    """
    if not all_feature_cols:
        return []

    diffs = {
        col: abs(
            float(target_row.get(col, 0) or 0)
            - float(candidate_row.get(col, 0) or 0)
        )
        for col in all_feature_cols
        if col in target_row.index and col in candidate_row.index
    }

    # 差が小さい順（類似している特徴量）を上位に
    sorted_features = sorted(diffs, key=lambda c: diffs[c])
    return sorted_features[:top_n]


# ---------------------------------------------------------------------------
# メイン関数
# ---------------------------------------------------------------------------


def compute_similarities(
    target_cd_area: str,
    df_all: pd.DataFrame,
    df_candidates: pd.DataFrame,
    valid_cols: dict[str, list[str]],
    axis_weights: dict[str, float] | None = None,
    top_n_features: int = 5,
    id_col: str = "cd_area",
    name_col: str = "area_name",
) -> list[NeighborScore]:
    """
    対象自治体と各候補自治体の軸別コサイン類似度・総合類似度・寄与特徴量を算出する。

    Args:
        target_cd_area  : 対象自治体コード
        df_all          : 全自治体の前処理済み DataFrame（対象含む）
        df_candidates   : 候補自治体の前処理済み DataFrame（財政フィルタ済み）
        valid_cols      : 軸名 → 有効カラムリスト（preprocessor から受け取る）
        axis_weights    : 軸重み辞書（None の場合 feature_config.AXIS_WEIGHTS を使用）
        top_n_features  : 寄与特徴量数
        id_col          : 自治体コード列名
        name_col        : 自治体名列名

    Returns:
        NeighborScore のリスト（total_similarity 降順でソート済み）
    """
    weights = axis_weights or AXIS_WEIGHTS

    # 対象自治体の行を取得
    target_rows = df_all[df_all[id_col] == target_cd_area]
    if target_rows.empty:
        logger.error("対象自治体 %s がデータに見つかりません", target_cd_area)
        return []
    target_row = target_rows.iloc[0]

    # 全軸の有効カラムを結合（寄与度算出用）
    all_feature_cols = list({
        col for cols in valid_cols.values() for col in cols
    })

    results: list[NeighborScore] = []

    for _, cand_row in df_candidates.iterrows():
        cand_cd_area = str(cand_row[id_col])
        cand_name    = str(cand_row.get(name_col, cand_cd_area))

        # --- 軸別コサイン類似度 ---
        axis_scores: dict[str, float] = {}
        for axis in ("need", "support", "feasibility"):
            cols = valid_cols.get(axis, [])
            t_vec = _axis_vector(target_row, cols)
            c_vec = _axis_vector(cand_row, cols)
            axis_scores[axis] = _cosine_similarity(t_vec, c_vec)

        # --- 総合類似度（加重平均）---
        total = sum(
            weights.get(axis, 0.0) * score
            for axis, score in axis_scores.items()
        )

        # --- 寄与特徴量 ---
        top_feats = _top_contributing_features(
            target_row, cand_row, all_feature_cols, top_n=top_n_features
        )

        results.append(
            NeighborScore(
                cd_area=cand_cd_area,
                area_name=cand_name,
                total_similarity=round(total, 6),
                axis_similarity=AxisScore(
                    need=round(axis_scores.get("need", 0.0), 6),
                    support=round(axis_scores.get("support", 0.0), 6),
                    feasibility=round(axis_scores.get("feasibility", 0.0), 6),
                ),
                top_features=top_feats,
            )
        )

    # total_similarity 降順でソート
    results.sort(key=lambda x: x.total_similarity, reverse=True)
    return results


def compute_axis_scores(neighbors: list[NeighborScore]) -> dict[str, float]:
    """
    上位 neighbors の軸別スコアの平均を「対象自治体のスコア」として返す。

    対象自治体自身のスコアは定義が難しいため、
    「どの軸でよく似た自治体が見つかるか」を代理指標とする。

    Returns:
        {"need": ..., "support": ..., "feasibility": ..., "total": ...}
    """
    if not neighbors:
        return {"need": 0.0, "support": 0.0, "feasibility": 0.0, "total": 0.0}

    n = len(neighbors)
    return {
        "need":        round(sum(nb.axis_similarity.need        for nb in neighbors) / n, 6),
        "support":     round(sum(nb.axis_similarity.support     for nb in neighbors) / n, 6),
        "feasibility": round(sum(nb.axis_similarity.feasibility for nb in neighbors) / n, 6),
        "total":       round(sum(nb.total_similarity             for nb in neighbors) / n, 6),
    }
