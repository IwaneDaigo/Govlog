"""
特徴量変換パイプライン（前処理）

変換ステップ:
  1. per-capita 変換  : 絶対量 → 人口 1 人あたりの値
  2. 構成比計算       : 部分量 ÷ 総量
  3. log1p 変換       : 右裾が重い分布の歪みを軽減
  4. 欠損値補完       : 列ごとの中央値で補完
  5. StandardScaler   : 軸ごとに平均 0・分散 1 に正規化

入力: pandas DataFrame（cd_area 列などのメタ列を含む生データ）
出力: 前処理済み DataFrame + 軸別有効カラムリスト + 軸別 StandardScaler
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# per-capita 変換の対象カラム（コードプレフィックスで指定）
# ---------------------------------------------------------------------------
# これらのプレフィックスで始まるカラムが存在する場合、
# 総人口で割り "{col}_per_capita" を追加する。
# 正確なカラム名は API 取得後まで確定しないためプレフィックス方式を採用。
_PER_CAPITA_PREFIXES: list[str] = [
    "A4101",   # 保育所数（社会・人口統計体系）
    "J2503",   # 保育所数（社会福祉施設等調査）
    "I5101",   # 病院数
    "C610120", # 医療・福祉産業売上
    "D2209",   # 一般財源
    "A7101",   # 世帯数
]

# 後方互換: 確定名を直接指定したい場合はここにも追加できる
_PER_CAPITA_COLS: list[str] = [
    "nursery_capacity",
    "nursery_waiting_children",
    "pediatric_clinic_count",
    "expenditure_per_capita",
]

# 総人口カラムの候補（先に見つかったものを使用）
_POPULATION_COL_CANDIDATES: list[str] = [
    "total_population",
    "A1101_総人口【人】",
]

# ---------------------------------------------------------------------------
# 構成比（ratio）の計算グループ
# ---------------------------------------------------------------------------
# (分子カラムコードプレフィックスリスト, 分母カラムコードプレフィックス, 生成する新カラム名)
# 実際のカラム名は実行時に解決する
_RATIO_GROUPS_PREFIXES: list[tuple[list[str], str, str]] = [
    (["A1404"], "A1101", "pop_0_14_ratio"),   # 0〜14歳人口 / 総人口
    (["A1406"], "A1101", "pop_0_5_ratio"),    # 0〜5歳人口 / 総人口
]

# 後方互換: 確定名を使う ratio グループ
_RATIO_GROUPS: list[tuple[list[str], str, str]] = [
    (["pop_0_14"],     "total_population", "pop_0_14_ratio"),
    (["pop_0_5"],      "total_population", "pop_0_5_ratio"),
    (["female_20_39"], "total_population", "female_20_39_ratio"),
]

# ---------------------------------------------------------------------------
# log1p 変換の対象カラム（コードプレフィックスで指定）
# ---------------------------------------------------------------------------
_LOG1P_PREFIXES: list[str] = [
    "A4101",   # 保育所数
    "J2503",   # 保育所数
    "I5101",   # 病院数
    "C610120", # 医療・福祉売上
    "D2209",   # 一般財源
    "A7101",   # 世帯数
]

# 後方互換: 確定名
_LOG1P_COLS: list[str] = [
    "nursery_capacity",
    "nursery_capacity_per_capita",
    "nursery_waiting_children",
    "nursery_waiting_children_per_capita",
    "pediatric_clinic_count",
    "pediatric_clinic_count_per_capita",
]


# ---------------------------------------------------------------------------
# ヘルパー関数
# ---------------------------------------------------------------------------


def _find_population_col(df: pd.DataFrame) -> str | None:
    """総人口カラムを候補リストから探す。見つからなければ None を返す。"""
    for col in _POPULATION_COL_CANDIDATES:
        if col in df.columns:
            return col
    return None


def _cols_by_prefix(df: pd.DataFrame, prefixes: list[str]) -> list[str]:
    """DataFrame の列名のうち、いずれかのプレフィックスで始まるものを返す。"""
    return [col for col in df.columns for pfx in prefixes if col.startswith(pfx)]


def add_per_capita_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    per-capita 変換対象のカラムを総人口で割り "{col}_per_capita" 列を追加する。

    対象: _PER_CAPITA_PREFIXES で始まる列 + _PER_CAPITA_COLS の確定名列
    総人口カラムが見つからない場合はスキップ（警告のみ）。
    """
    pop_col = _find_population_col(df)
    if pop_col is None:
        logger.warning("総人口カラムが見つからないため per-capita 変換をスキップ")
        return df

    df = df.copy()
    pop = df[pop_col].replace(0, np.nan)  # ゼロ除算回避

    # プレフィックスで一致する列 + 確定名列をまとめて処理
    target_cols = list(dict.fromkeys(
        _cols_by_prefix(df, _PER_CAPITA_PREFIXES) +
        [c for c in _PER_CAPITA_COLS if c in df.columns]
    ))

    for col in target_cols:
        new_col = f"{col}_per_capita"
        if new_col not in df.columns:  # 既に派生列がある場合はスキップ
            df[new_col] = df[col] / pop
            logger.debug("per-capita 変換: %s → %s", col, new_col)

    return df


def add_ratio_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    構成比カラムを追加する。

    - _RATIO_GROUPS_PREFIXES: コードプレフィックスで分子・分母を解決
    - _RATIO_GROUPS: 確定カラム名で解決（後方互換）
    既に同名の列が存在する場合はスキップ（上書きしない）。
    """
    df = df.copy()

    # プレフィックスベースの ratio 計算
    for num_prefixes, den_prefix, new_col in _RATIO_GROUPS_PREFIXES:
        if new_col in df.columns:
            continue  # 既に計算済み

        # 分母: プレフィックス一致の最初の列
        den_candidates = _cols_by_prefix(df, [den_prefix])
        if not den_candidates:
            continue
        denominator = df[den_candidates[0]].replace(0, np.nan)

        # 分子: プレフィックス一致の列の合計
        num_cols = _cols_by_prefix(df, num_prefixes)
        if not num_cols:
            continue
        numerator = df[num_cols].sum(axis=1)

        df[new_col] = numerator / denominator
        logger.debug("構成比計算(prefix): %s / %s → %s", num_cols, den_candidates[0], new_col)

    # 確定名ベースの ratio 計算（後方互換）
    for numerator_cols, denominator_col, new_col in _RATIO_GROUPS:
        if new_col in df.columns:
            continue
        if denominator_col not in df.columns:
            continue
        available_nums = [c for c in numerator_cols if c in df.columns]
        if not available_nums:
            continue

        numerator = df[available_nums].sum(axis=1)
        denominator = df[denominator_col].replace(0, np.nan)
        df[new_col] = numerator / denominator
        logger.debug("構成比計算(name): %s / %s → %s", available_nums, denominator_col, new_col)

    return df


def apply_log1p(df: pd.DataFrame) -> pd.DataFrame:
    """
    log1p 変換対象のカラムに適用する。
    対象: _LOG1P_PREFIXES で始まる列 + _LOG1P_COLS の確定名列 + "_per_capita" 派生列
    負値は 0 でクリップしてから変換。
    """
    df = df.copy()

    target_cols = list(dict.fromkeys(
        _cols_by_prefix(df, _LOG1P_PREFIXES) +
        [c for c in _LOG1P_COLS if c in df.columns]
    ))
    # per_capita 派生列も対象に含める
    target_cols += [
        f"{col}_per_capita"
        for col in target_cols
        if f"{col}_per_capita" in df.columns
    ]

    for col in set(target_cols):
        if col in df.columns:
            df[col] = np.log1p(df[col].clip(lower=0))

    return df


# ---------------------------------------------------------------------------
# メインパイプライン
# ---------------------------------------------------------------------------


def build_feature_matrix(
    df: pd.DataFrame,
    axis_features: dict[str, list[str]],
) -> tuple[pd.DataFrame, dict[str, list[str]], dict[str, StandardScaler]]:
    """
    前処理パイプライン全体を実行し、軸別の標準化済み特徴量を持つ DataFrame を返す。

    Pipeline:
      1. per-capita 変換
      2. 構成比計算
      3. log1p 変換
      4. 欠損値補完（列ごとの中央値）
      5. 軸ごとに StandardScaler で標準化

    Args:
        df           : 生データ DataFrame（cd_area 等のメタ列含む）
        axis_features: 軸名 → 特徴量カラム名リスト の辞書

    Returns:
        前処理済み DataFrame
        有効カラム辞書  : 軸名 → 実際に存在して使用されたカラム名リスト
        スケーラー辞書  : 軸名 → 学習済み StandardScaler
    """
    # --- Step 1-3: 特徴量変換 ---
    df = add_per_capita_features(df)
    df = add_ratio_features(df)
    df = apply_log1p(df)

    # --- Step 4: 欠損値補完（中央値）---
    # 数値列のみが対象。文字列列（cd_area など）は変更しない。
    numeric_cols = df.select_dtypes(include="number").columns
    df[numeric_cols] = df[numeric_cols].fillna(df[numeric_cols].median())

    # --- Step 5: 軸ごとに StandardScaler を fit して標準化 ---
    valid_cols: dict[str, list[str]] = {}
    scalers: dict[str, StandardScaler] = {}

    for axis, cols in axis_features.items():
        # データに実際に存在するカラムだけ使う
        existing = [c for c in cols if c in df.columns]

        if not existing:
            logger.warning("軸 '%s' の有効なカラムが見つかりません（全スキップ）", axis)
            valid_cols[axis] = []
            scalers[axis] = StandardScaler()
            continue

        scaler = StandardScaler()
        df[existing] = scaler.fit_transform(df[existing])

        valid_cols[axis] = existing
        scalers[axis] = scaler
        logger.info("軸 '%s': %d 特徴量で標準化完了", axis, len(existing))

    return df, valid_cols, scalers
