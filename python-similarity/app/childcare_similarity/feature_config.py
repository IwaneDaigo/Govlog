"""
軸別特徴量の定義と重みづけ設定。

【設計思想】
  各 AXIS_FEATURES[軸名] に「理想的なカラム名」を列挙する。
  データに存在しないカラムはプリプロセッサが自動的にスキップするため、
  将来データが拡充されれば自動的に恩恵を受けられる。

  e-Stat API のカラム名は "{コード}_{日本語名}【{単位}】" の形式で返ってくる。
  正確な名前は refresh_dataset.py --show-columns で確認できる。
  API 取得後に名前が判明したカラムは AXIS_COL_PREFIXES にコードを登録し、
  expand_axis_features() で自動的に正確な名前に展開される。

【軸の意味】
  need        : 課題構造（子育て世代の困難度・需要の大きさ）
  support     : 支援供給状況（行政・民間の保育・医療供給量）
  feasibility : 財政実現可能性（施策を実行する余力）

【e-Stat コード → 指標の対応】
  コード   統計表       指標
  A1101    0000020201   総人口
  A1404    0000020201   0〜14歳人口（年少人口）
  A1406    0000020201   0〜5歳人口（乳幼児）
  A4101    0000020201   保育所数（社会・人口統計体系）
  D2201    0000020204   財政力指数
  D2202    0000020204   経常収支比率
  D2209    0000020204   一般財源
  I5101    0000020209   病院数
  J2503    0000020210   保育所数（社会福祉施設等調査）
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# e-Stat コードプレフィックス → 軸の対応
# ---------------------------------------------------------------------------
# e-Stat が返すカラム名 "{コード}_{名前}【{単位}】" のうち、
# コード部分のみで軸を特定する。
# expand_axis_features() が DataFrame の実際の列名と照合して解決する。
#
# 形式: {軸名: [コードプレフィックスのリスト]}
AXIS_COL_PREFIXES: dict[str, list[str]] = {
    "need": [
        "A1101",   # 総人口
        "A1404",   # 0〜14歳人口
        "A1406",   # 0〜5歳人口
        "A7101",   # 世帯数
    ],
    "support": [
        "A4101",   # 保育所数（社会・人口統計体系）
        "J2503",   # 保育所数（社会福祉施設等調査）
        "I5101",   # 病院数
        "C610120", # 医療・福祉産業売上
    ],
    "feasibility": [
        "D2201",   # 財政力指数
        "D2202",   # 経常収支比率
        "D2209",   # 一般財源
    ],
}

# ---------------------------------------------------------------------------
# 軸別特徴量カラム名リスト（確定名・派生列）
# ---------------------------------------------------------------------------
# ここには「確定したカラム名」または「前処理で派生するカラム名」を書く。
# e-Stat 由来の列は expand_axis_features() が自動追加するため、
# 既存の現行 CSV カラム名のみここに記載する。

# 課題構造軸
NEED_FEATURES: list[str] = [
    # 派生列（preprocessor.py が自動生成）
    "pop_0_14_ratio",           # 0-14歳人口構成比
    "pop_0_5_ratio",            # 0-5歳人口構成比
    "A7101_世帯数【世帯】_per_capita",  # 世帯数/人口
]

# 支援供給軸
SUPPORT_FEATURES: list[str] = [
    # 派生列（preprocessor.py が自動生成）
    "I5101_病院数【施設】_per_capita",   # 病院数/人口
]

# 財政実現可能性軸
FEASIBILITY_FEATURES: list[str] = [
    # 派生列（preprocessor.py が自動生成）
    "D2209_一般財源（市町村財政）【千円】_per_capita",  # 一般財源/人口
]

# ---------------------------------------------------------------------------
# 軸の重みづけ（合計 1.0）
# ---------------------------------------------------------------------------
AXIS_WEIGHTS: dict[str, float] = {
    "need":        0.4,
    "support":     0.3,
    "feasibility": 0.3,
}

# ---------------------------------------------------------------------------
# 財政フィルタ用カラム候補（優先順位順に探索）
# ---------------------------------------------------------------------------
FISCAL_STRENGTH_COL_CANDIDATES: list[str] = [
    "fiscal_strength_index",
    "D2201_財政力指数（市町村財政）【‐】",
]
FISCAL_STRENGTH_TOLERANCE: float = 0.1

# D2202 列が存在すれば経常収支比率フィルタも有効になる
ORDINARY_BALANCE_COL_CANDIDATES: list[str] = [
    "ordinary_balance_ratio",
    # D2202 の正確な名前は expand_axis_features() 経由で検索するため
    # ここには prefix で始まる列を動的に追加する（fiscal_filter.py 参照）
]
ORDINARY_BALANCE_COL_PREFIX: str = "D2202"  # 経常収支比率のコードプレフィックス
ORDINARY_BALANCE_TOLERANCE: float = 5.0     # ±パーセントポイント

# ---------------------------------------------------------------------------
# クラスタリング設定
# ---------------------------------------------------------------------------
N_CLUSTERS: int = 5
CLUSTER_RANDOM_STATE: int = 42


# ---------------------------------------------------------------------------
# コードプレフィックス展開
# ---------------------------------------------------------------------------

def expand_axis_features(
    df_columns: list[str],
    axis_col_prefixes: dict[str, list[str]] | None = None,
    base_axis_features: dict[str, list[str]] | None = None,
) -> dict[str, list[str]]:
    """
    AXIS_COL_PREFIXES のコードと DataFrame の実際の列名を照合し、
    NEED_FEATURES / SUPPORT_FEATURES / FEASIBILITY_FEATURES と合わせた
    最終的な「軸 → カラム名リスト」を返す。

    e-Stat が返す列名 "{コード}_{名前}【{単位}】" は API を叩くまで確定しないため、
    この関数でコードプレフィックスマッチングにより実際の列名を解決する。

    Args:
        df_columns         : DataFrame の全列名リスト
        axis_col_prefixes  : None なら AXIS_COL_PREFIXES を使用
        base_axis_features : None なら {NEED/SUPPORT/FEASIBILITY}_FEATURES を使用

    Returns:
        {"need": [...], "support": [...], "feasibility": [...]}
    """
    prefixes = axis_col_prefixes or AXIS_COL_PREFIXES
    base = base_axis_features or {
        "need":        NEED_FEATURES,
        "support":     SUPPORT_FEATURES,
        "feasibility": FEASIBILITY_FEATURES,
    }

    result: dict[str, list[str]] = {}

    for axis, codes in prefixes.items():
        matched: list[str] = []

        for code in codes:
            # DataFrame の列名のうち code で始まるものを全て収集
            hits = [col for col in df_columns if col.startswith(code)]
            if hits:
                matched.extend(hits)
                logger.debug("軸 '%s': コード %s → %s", axis, code, hits)
            else:
                logger.debug("軸 '%s': コード %s に一致する列なし", axis, code)

        # 派生列（base_axis_features）と合わせて重複除去
        base_cols = base.get(axis, [])
        combined = list(dict.fromkeys(matched + base_cols))  # 順序を保ちつつ重複除去
        result[axis] = combined

    logger.info(
        "特徴量展開完了: %s",
        {ax: len(cols) for ax, cols in result.items()},
    )
    return result


def resolve_ordinary_balance_col(df_columns: list[str]) -> str | None:
    """
    経常収支比率カラムの実際の列名を返す。
    ORDINARY_BALANCE_COL_CANDIDATES → D2202 プレフィックスの順で探す。
    """
    for col in ORDINARY_BALANCE_COL_CANDIDATES:
        if col in df_columns:
            return col
    # D2202 プレフィックスで探す
    for col in df_columns:
        if col.startswith(ORDINARY_BALANCE_COL_PREFIX):
            return col
    return None
