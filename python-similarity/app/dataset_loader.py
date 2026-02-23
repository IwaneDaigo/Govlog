from __future__ import annotations

import csv
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# dataSet_clean.csv のデフォルトパス
CLEAN_DATASET = Path("dataSet_clean.csv")

# 固定カラム（指標値ではない列）
_FIXED_COLS = {"year_code", "year", "cd_area", "area_name"}

# 欠損を表す値
_MISSING = {"", "X", "-", "***"}


def load_local_dataset(
    csv_path: Path = CLEAN_DATASET,
    year_code: str = "2020100000",
    top_level_only: bool = True,
) -> dict[str, dict[str, float | None]]:
    """
    dataSet_clean.csv を読み込み、{cd_area: {指標名: 値}} を返す。

    Args:
        csv_path:       dataSet_clean.csv のパス。
        year_code:      絞り込む調査年コード（デフォルト: 2020年度）。
        top_level_only: True のとき政令市の区レベル（6桁以上コード）を除外し、
                        市区町村レベルのみを返す。

    Returns:
        {
          "26100": {"A1101_総人口【人】": 1463723.0, ...},
          "27100": {...},
          ...
        }
        欠損値（X / - / ***）は None。
    """
    result: dict[str, dict[str, float | None]] = {}

    with open(csv_path, encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)

        for row in reader:
            # 調査年フィルタ
            if row.get("year_code") != year_code:
                continue

            cd_area = row["cd_area"]

            # 政令市の区レベル（6桁以上）を除外
            if top_level_only and len(cd_area) > 5:
                continue

            # 指標カラムを数値変換
            values: dict[str, float | None] = {}
            for col, raw in row.items():
                if col in _FIXED_COLS:
                    continue
                v = raw.strip()
                values[col] = float(v) if v not in _MISSING else None

            result[cd_area] = values

    logger.info(
        "Loaded %d areas from %s (year=%s, top_level_only=%s)",
        len(result),
        csv_path,
        year_code,
        top_level_only,
    )
    return result


def dataset_to_vectors(
    dataset: dict[str, dict[str, float | None]],
    cdAreas: list[str],
    keys: list[str] | None = None,
) -> dict[str, list[float]]:
    """
    load_local_dataset の出力を vectorizer が扱える
    {cdArea: list[float]} 形式に変換する。

    Args:
        dataset:  load_local_dataset の返り値。
        cdAreas:  ベクトルを生成する自治体コードのリスト。
        keys:     使用する指標名のリスト。
                  None のとき dataset に含まれる全指標を使用する。

    Notes:
        - 欠損値（None）は 0.0 で補完する。
        - 全エリアで同じ列順（sorted キー順）を保証する。
    """
    if not dataset:
        return {area: [0.0] for area in cdAreas}

    # keys 未指定なら全指標を使用（ソート済み）
    if keys is None:
        keys = sorted({key for row in dataset.values() for key in row})

    return {
        area: [
            float(dataset.get(area, {}).get(k) or 0.0)
            for k in keys
        ]
        for area in cdAreas
    }


def available_indicators(
    dataset: dict[str, dict[str, float | None]],
) -> list[str]:
    """
    データセットに含まれる指標名のリストを返す（ソート済み）。
    `/indicators` エンドポイントやデバッグ用。
    """
    keys: set[str] = set()
    for row in dataset.values():
        keys.update(row.keys())
    return sorted(keys)
