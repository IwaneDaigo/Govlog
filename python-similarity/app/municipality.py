from __future__ import annotations

import csv
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# CSV のデフォルトパス（プロジェクトルートからの相対）
MUNICIPALITY_CSV = Path("municipalty.csv")


def load_municipality_map(
    csv_path: Path = MUNICIPALITY_CSV,
) -> dict[str, str]:
    """
    municipalty.csv を読み込み、{cdArea: 自治体名} のマッピングを返す。

    【自治体名の決定ルール】
    - 市区町村列（col4）が空でない → 都道府県 + 市区町村
        例: "01202" → "北海道函館市"
    - 市区町村列が空（政令市・支庁等）→ 都道府県 + 政令市名（col2）
        例: "01100" → "北海道札幌市"

    CSVカラム順:
        0: 標準地域コード
        1: 都道府県
        2: 政令市･郡･支庁･振興局等
        4: 市区町村
    """
    mapping: dict[str, str] = {}

    with open(csv_path, encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        next(reader)  # ヘッダー行をスキップ

        for row in reader:
            # 列数が足りない行は読み飛ばす
            if len(row) < 5:
                continue

            cd_area    = row[0].strip()
            prefecture = row[1].strip()
            designated = row[2].strip()  # 政令市･支庁等（政令市の場合ここに名前が入る）
            city       = row[4].strip()  # 市区町村（一般市区町村はここに名前が入る）

            # 市区町村列が空なら政令市列を使う
            local_name = city if city else designated

            # 都道府県 + 自治体名を結合して完全名にする
            full_name = f"{prefecture}{local_name}" if local_name else prefecture

            mapping[cd_area] = full_name

    logger.info("Loaded %d municipalities from %s", len(mapping), csv_path)
    return mapping


def all_cd_areas(mapping: dict[str, str]) -> list[str]:
    """
    マッピングに含まれる全 cdArea のリストを返す。
    全市区町村を対象にする場合（candidate_cdAreas=null）に使用する。
    """
    return list(mapping.keys())
