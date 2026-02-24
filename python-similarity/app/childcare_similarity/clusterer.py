"""
KMeans クラスタリング

前処理済みの特徴量全体（全軸）を使って自治体をクラスタリングし、
類似自治体の絞り込みと cluster_id の付与に使用する。

クラスタリングは「同じ状況の自治体タイプ」を大まかに分類するために行い、
詳細な類似度は axis_similarity.py のコサイン類似度で計算する。
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

from .feature_config import CLUSTER_RANDOM_STATE, N_CLUSTERS

logger = logging.getLogger(__name__)


def assign_clusters(
    df: pd.DataFrame,
    valid_cols: dict[str, list[str]],
    id_col: str = "cd_area",
    n_clusters: int = N_CLUSTERS,
) -> tuple[pd.DataFrame, KMeans]:
    """
    全軸の有効特徴量を結合してKMeansクラスタリングを実施し、
    DataFrame に "cluster_id" 列を追加して返す。

    Args:
        df         : 前処理済み（標準化済み）DataFrame
        valid_cols : 軸名 → 有効カラム名リスト（preprocessor から受け取る）
        id_col     : 自治体コードの列名
        n_clusters : クラスタ数（feature_config.N_CLUSTERS がデフォルト）

    Returns:
        cluster_id 列が追加された DataFrame, 学習済み KMeans モデル

    Notes:
        - 全軸の特徴量を結合して 1 つの feature matrix を作る
        - 有効特徴量が 0 の場合はクラスタリング不可として全て cluster_id=0 にする
        - n_clusters がデータ行数を超える場合は自動的に行数に調整する
    """
    df = df.copy()

    # 全軸の有効カラムをフラットに結合（重複除去）
    all_feature_cols = list({
        col
        for cols in valid_cols.values()
        for col in cols
        if col in df.columns
    })

    if not all_feature_cols:
        logger.warning("クラスタリング可能な特徴量がありません。全自治体を cluster_id=0 に設定します")
        df["cluster_id"] = 0
        return df, KMeans(n_clusters=1, random_state=CLUSTER_RANDOM_STATE)

    # 特徴量行列を構築（残存する欠損は 0 で補完）
    X = df[all_feature_cols].fillna(0).to_numpy()

    # データ数がクラスタ数を下回る場合は調整
    actual_n = min(n_clusters, len(X))
    if actual_n < n_clusters:
        logger.warning(
            "データ行数 (%d) < n_clusters (%d)。クラスタ数を %d に調整します",
            len(X), n_clusters, actual_n,
        )

    kmeans = KMeans(
        n_clusters=actual_n,
        random_state=CLUSTER_RANDOM_STATE,
        n_init="auto",   # sklearn >= 1.2 で警告を抑制
    )
    labels = kmeans.fit_predict(X)
    df["cluster_id"] = labels

    # クラスタ分布をログ出力
    counts = pd.Series(labels).value_counts().sort_index()
    logger.info(
        "クラスタリング完了 (n_clusters=%d): %s",
        actual_n,
        {int(k): int(v) for k, v in counts.items()},
    )

    return df, kmeans


def get_cluster_id(df: pd.DataFrame, cd_area: str, id_col: str = "cd_area") -> int:
    """
    指定した自治体コードの cluster_id を返す。
    見つからない場合は -1 を返す。
    """
    row = df[df[id_col] == cd_area]
    if row.empty:
        logger.warning("cd_area=%s の cluster_id が見つかりません", cd_area)
        return -1
    return int(row.iloc[0]["cluster_id"])
