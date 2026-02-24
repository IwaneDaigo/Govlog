"""
類似自治体抽出エンジン（オーケストレーション層）

全処理ステップを統合して最終出力 JSON を生成する。

【処理フロー】
  Step 0: CSV からデータ読み込み → DataFrame 化
  Step 1: 前処理パイプライン（per-capita / ratio / log1p / StandardScaler）
  Step 2: KMeans クラスタリング
  Step 3: 財政制約フィルタ（フィルタは生データで実施）
  Step 4: 軸別コサイン類似度 + 総合類似度
  Step 5: 寄与度算出
  Step 6: JSON 出力

【注意】
  財政フィルタは標準化前の生データで行う必要があるため、
  生データと標準化済みデータの両方を保持しながら処理する。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pandas as pd

from .axis_similarity import compute_axis_scores, compute_similarities
from .clusterer import assign_clusters, get_cluster_id
from .feature_config import AXIS_WEIGHTS, expand_axis_features
from .fiscal_filter import apply_fiscal_filter
from .preprocessor import build_feature_matrix

logger = logging.getLogger(__name__)

# dataSet_clean.csv のデフォルトパス（python-similarity ディレクトリ基準）
_DEFAULT_CSV = Path(__file__).parent.parent.parent / "dataSet_clean.csv"

# CSV の ID 列・名称列
_ID_COL   = "cd_area"
_NAME_COL = "area_name"

# データのフィルタ条件（load 時に使う年度）
_DEFAULT_YEAR_CODE = "2020100000"


# ---------------------------------------------------------------------------
# データロード
# ---------------------------------------------------------------------------


def _load_dataframe(
    csv_path: Path,
    year_code: str,
    top_level_only: bool,
) -> pd.DataFrame:
    """
    CSV を読み込み、年度・階層でフィルタした DataFrame を返す。

    欠損値文字（"X", "-", "***"）は NaN に変換する。
    """
    # 欠損値文字列を NaN 扱いにする
    na_values = ["X", "-", "***", ""]

    df = pd.read_csv(csv_path, dtype=str, na_values=na_values, keep_default_na=True)

    # 年度フィルタ
    df = df[df["year_code"] == year_code].copy()

    # 政令市区（6桁以上コード）を除外
    if top_level_only:
        df = df[df[_ID_COL].str.len() <= 5].copy()

    # 数値カラムを float に変換（cd_area / year / area_name 以外）
    non_numeric = {"year_code", "year", _ID_COL, _NAME_COL}
    for col in df.columns:
        if col not in non_numeric:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.reset_index(drop=True)
    logger.info("CSV 読み込み完了: %d 行, %d 列", len(df), len(df.columns))
    return df


# ---------------------------------------------------------------------------
# メインエントリポイント
# ---------------------------------------------------------------------------


def run_similarity(
    target_cd_area: str,
    csv_path: Path | str = _DEFAULT_CSV,
    year_code: str = _DEFAULT_YEAR_CODE,
    top_level_only: bool = True,
    limit: int = 10,
    top_n_features: int = 5,
    axis_features: dict[str, list[str]] | None = None,
    axis_weights: dict[str, float] | None = None,
) -> dict:
    """
    指定した自治体の類似自治体を多軸モデルで抽出し、JSON シリアライズ可能な dict を返す。

    Args:
        target_cd_area  : 対象自治体コード（例: "01100"）
        csv_path        : dataSet_clean.csv のパス
        year_code       : 使用する年度コード
        top_level_only  : 政令市区を除外するか
        limit           : 返す類似自治体の上限数
        top_n_features  : 各隣接自治体の寄与特徴量数
        axis_features   : 軸別特徴量カラム辞書（None = feature_config のデフォルト使用）
        axis_weights    : 軸重み辞書（None = feature_config のデフォルト使用）

    Returns:
        {
          "target_city": "xxxx",
          "cluster_id": 3,
          "scores": {"need": ..., "support": ..., "feasibility": ..., "total": ...},
          "neighbors": [
            {
              "city": "xxxx",
              "total_similarity": 0.86,
              "axis_similarity": {"need": ..., "support": ..., "feasibility": ...},
              "top_features": [...]
            }, ...
          ]
        }
    """
    csv_path = Path(csv_path)
    _axis_weights  = axis_weights  or AXIS_WEIGHTS

    # --- Step 0: データ読み込み ---
    logger.info("=== Step 0: データ読み込み (%s) ===", csv_path)
    df_raw = _load_dataframe(csv_path, year_code, top_level_only)

    if target_cd_area not in df_raw[_ID_COL].values:
        raise ValueError(f"対象自治体コード '{target_cd_area}' がデータに見つかりません")

    # --- Step 1: 前処理（生データのまま財政フィルタ用に保存 → その後標準化）---
    logger.info("=== Step 1: 前処理パイプライン ===")

    # DataFrame の実際の列名から軸別カラムを解決（コードプレフィックスマッチング）
    # axis_features が明示指定されていれば優先、なければ自動展開する
    _axis_features = axis_features or expand_axis_features(list(df_raw.columns))

    # 財政フィルタ用に生データを保持（標準化前）
    df_raw_for_filter = df_raw.copy()

    df_scaled, valid_cols, _scalers = build_feature_matrix(df_raw, _axis_features)

    # cd_area / area_name をスケール済み DataFrame に引き継ぐ
    df_scaled[_ID_COL]   = df_raw_for_filter[_ID_COL].values
    df_scaled[_NAME_COL] = df_raw_for_filter[_NAME_COL].values

    # --- Step 2: クラスタリング ---
    logger.info("=== Step 2: KMeans クラスタリング ===")
    df_scaled, _kmeans = assign_clusters(df_scaled, valid_cols, id_col=_ID_COL)
    target_cluster_id  = get_cluster_id(df_scaled, target_cd_area, id_col=_ID_COL)

    # --- Step 3: 財政制約フィルタ（生データで実施）---
    logger.info("=== Step 3: 財政制約フィルタ ===")
    df_candidates_raw = apply_fiscal_filter(
        df_raw_for_filter, target_cd_area, id_col=_ID_COL
    )

    # フィルタ後の cd_area リストで標準化済みデータを絞り込む
    valid_areas = set(df_candidates_raw[_ID_COL].values)
    df_candidates_scaled = df_scaled[
        df_scaled[_ID_COL].isin(valid_areas)
    ].copy().reset_index(drop=True)

    logger.info("フィルタ後候補数: %d 件", len(df_candidates_scaled))

    # --- Step 4 & 5: 軸別コサイン類似度 + 寄与特徴量 ---
    logger.info("=== Step 4-5: 類似度計算 + 寄与度算出 ===")
    neighbor_scores = compute_similarities(
        target_cd_area  = target_cd_area,
        df_all          = df_scaled,
        df_candidates   = df_candidates_scaled,
        valid_cols      = valid_cols,
        axis_weights    = _axis_weights,
        top_n_features  = top_n_features,
        id_col          = _ID_COL,
        name_col        = _NAME_COL,
    )

    # 上位 limit 件に絞る
    neighbor_scores = neighbor_scores[:limit]

    # 対象自治体の軸スコア（上位 neighbors の平均）
    target_scores = compute_axis_scores(neighbor_scores)

    # --- Step 6: JSON 形式に変換 ---
    logger.info("=== Step 6: 出力生成 ===")
    result = {
        "target_city": target_cd_area,
        "cluster_id": target_cluster_id,
        "scores": target_scores,
        "neighbors": [
            {
                "city": nb.cd_area,
                "city_name": nb.area_name,
                "total_similarity": nb.total_similarity,
                "axis_similarity": {
                    "need":        nb.axis_similarity.need,
                    "support":     nb.axis_similarity.support,
                    "feasibility": nb.axis_similarity.feasibility,
                },
                "top_features": nb.top_features,
            }
            for nb in neighbor_scores
        ],
    }

    logger.info("類似自治体抽出完了: %d 件", len(result["neighbors"]))
    return result


def run_similarity_json(target_cd_area: str, **kwargs) -> str:
    """run_similarity の結果を整形済み JSON 文字列として返す。CLI・デバッグ用。"""
    result = run_similarity(target_cd_area, **kwargs)
    return json.dumps(result, ensure_ascii=False, indent=2)
