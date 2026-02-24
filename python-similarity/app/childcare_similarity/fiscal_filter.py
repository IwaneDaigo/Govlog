"""
財政制約フィルタ

対象自治体と財政状況が「近い」自治体のみを候補として残す。
施策の参考先は財政規模が極端に異なると現実的でないため、
以下の条件を満たす自治体のみを類似度計算の対象とする:

  条件1: 財政力指数  が対象自治体 ± FISCAL_STRENGTH_TOLERANCE の範囲内
  条件2: 経常収支比率が対象自治体 ± ORDINARY_BALANCE_TOLERANCE の範囲内
          （カラムが存在する場合のみ適用）

どちらの条件も、対応するカラムがデータに存在しない場合はフィルタをスキップして
全候補をそのまま返す（エラーにしない）。
"""

from __future__ import annotations

import logging

import pandas as pd

from .feature_config import (
    FISCAL_STRENGTH_COL_CANDIDATES,
    FISCAL_STRENGTH_TOLERANCE,
    ORDINARY_BALANCE_TOLERANCE,
    resolve_ordinary_balance_col,
)

logger = logging.getLogger(__name__)


def _find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """候補カラムリストから DataFrame に存在する最初のものを返す。"""
    for col in candidates:
        if col in df.columns:
            return col
    return None


def apply_fiscal_filter(
    df: pd.DataFrame,
    target_cd_area: str,
    id_col: str = "cd_area",
) -> pd.DataFrame:
    """
    財政指標が対象自治体に近い自治体だけを残す。

    Args:
        df             : 前処理済み DataFrame（cd_area 列と財政指標列を含む）
        target_cd_area : 対象自治体コード
        id_col         : 自治体コードの列名（デフォルト: "cd_area"）

    Returns:
        フィルタ後の DataFrame。対象自治体自身は候補に含まない。

    Notes:
        - 標準化後のデータを受け取るため、tolerance はスケール後の値を参照する。
          ただし feature_config の tolerance 値は StandardScaler 後の Z スコア基準。
          実用上は生データでフィルタするほうが直感的なため、
          このフィルタは前処理「前」の生データを受け取ることを想定している。
    """
    # 対象自治体の行を取得
    target_mask = df[id_col] == target_cd_area
    if not target_mask.any():
        logger.warning("対象自治体 %s がデータに見つかりません。フィルタをスキップします", target_cd_area)
        return df[df[id_col] != target_cd_area].copy()

    target_row = df[target_mask].iloc[0]

    # 候補自治体（対象自治体自身を除く）
    candidates = df[df[id_col] != target_cd_area].copy()
    original_count = len(candidates)

    # --- 条件1: 財政力指数フィルタ ---
    fsi_col = _find_col(df, FISCAL_STRENGTH_COL_CANDIDATES)
    if fsi_col is not None:
        target_fsi = target_row[fsi_col]
        if pd.notna(target_fsi):
            low  = target_fsi - FISCAL_STRENGTH_TOLERANCE
            high = target_fsi + FISCAL_STRENGTH_TOLERANCE
            before = len(candidates)
            candidates = candidates[
                candidates[fsi_col].between(low, high, inclusive="both")
                | candidates[fsi_col].isna()  # 欠損の自治体は除外しない
            ]
            logger.info(
                "財政力指数フィルタ [%.2f ± %.2f]: %d → %d 件",
                target_fsi, FISCAL_STRENGTH_TOLERANCE, before, len(candidates),
            )
        else:
            logger.info("対象自治体の財政力指数が欠損のため財政力指数フィルタをスキップ")
    else:
        logger.info("財政力指数カラムが見つからないため財政力指数フィルタをスキップ")

    # --- 条件2: 経常収支比率フィルタ ---
    # D2202 プレフィックスで動的に列名を解決する
    obr_col = resolve_ordinary_balance_col(list(df.columns))
    if obr_col is not None:
        target_obr = target_row[obr_col]
        if pd.notna(target_obr):
            low  = target_obr - ORDINARY_BALANCE_TOLERANCE
            high = target_obr + ORDINARY_BALANCE_TOLERANCE
            before = len(candidates)
            candidates = candidates[
                candidates[obr_col].between(low, high, inclusive="both")
                | candidates[obr_col].isna()
            ]
            logger.info(
                "経常収支比率フィルタ [%.1f ± %.1f]: %d → %d 件",
                target_obr, ORDINARY_BALANCE_TOLERANCE, before, len(candidates),
            )
    else:
        logger.debug("経常収支比率カラムが見つからないためスキップ")

    logger.info(
        "財政フィルタ合計: %d → %d 件（除外 %d 件）",
        original_count, len(candidates), original_count - len(candidates),
    )

    return candidates.reset_index(drop=True)
