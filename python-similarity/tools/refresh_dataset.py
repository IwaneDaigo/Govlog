"""
dataSet_clean.csv 再生成スクリプト

e-Stat API から全統計データを取得して dataSet_clean.csv を上書き生成する。
STATS_CONFIG（estat_client.py）に定義された全指標を対象とする。

使い方:
    cd python-similarity
    ESTAT_APP_ID=your_app_id python tools/refresh_dataset.py

    # 特定年度のみ取得
    ESTAT_APP_ID=xxx python tools/refresh_dataset.py --year 2020100000

    # 取得後に列名を確認したいとき
    ESTAT_APP_ID=xxx python tools/refresh_dataset.py --show-columns
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import logging
import os
import sys
from pathlib import Path

# python-similarity ディレクトリをモジュール検索パスに追加
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from app.estat_client import TARGET_YEAR, fetch_all_data
from app.municipality import load_municipality_map

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

# 出力先（デフォルト）
OUTPUT_CSV = ROOT / "dataSet_clean.csv"
MUNICIPALITY_CSV = ROOT / "municipalty.csv"

# CSV に出力しない列
_FIXED_COLS = ["year_code", "year", "cd_area", "area_name"]


def _load_area_map(csv_path: Path) -> dict[str, str]:
    """municipalty.csv から {cd_area: 自治体名} を返す。"""
    result: dict[str, str] = {}
    with open(csv_path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            code = row["標準地域コード"]
            pref = row.get("都道府県", "")
            # 市区町村名が空なら郡・支庁名を使う
            muni = row.get("市区町村", "") or row.get("政令市･郡･支庁･振興局等", "")
            result[code] = f"{pref} {muni}".strip()
    return result


async def _fetch(app_id: str, cd_areas: list[str]) -> dict[str, dict[str, float | None]]:
    """fetch_all_data のラッパー（ログ付き）。"""
    logger.info("e-Stat API からデータ取得開始: %d 自治体", len(cd_areas))
    data = await fetch_all_data(app_id, cd_areas)
    logger.info("取得完了: %d 自治体", len(data))
    return data


def _build_dataframe_rows(
    data: dict[str, dict[str, float | None]],
    area_map: dict[str, str],
    year_code: str,
) -> tuple[list[str], list[dict]]:
    """
    取得データを CSV 出力用の行リストに変換する。

    Returns:
        (全列名リスト, 行リスト)
    """
    # 全指標名を収集してソート（列順を固定）
    all_indicators: set[str] = set()
    for indicators in data.values():
        all_indicators.update(indicators.keys())
    sorted_indicators = sorted(all_indicators)

    headers = _FIXED_COLS + sorted_indicators

    rows: list[dict] = []
    for cd_area in sorted(data.keys()):
        indicators = data[cd_area]
        row: dict = {
            "year_code": year_code,
            "year":      year_code[:4] + "年度",
            "cd_area":   cd_area,
            "area_name": area_map.get(cd_area, cd_area),
        }
        for ind in sorted_indicators:
            val = indicators.get(ind)
            row[ind] = "" if val is None else val
        rows.append(row)

    return headers, rows


def _write_csv(output_path: Path, headers: list[str], rows: list[dict]) -> None:
    """行リストを CSV に書き出す。"""
    with open(output_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)
    logger.info("CSV 出力完了: %s (%d 行, %d 列)", output_path, len(rows), len(headers))


def _show_columns(headers: list[str]) -> None:
    """取得できた列名を軸別に分類して表示する。"""
    import sys
    sys.path.insert(0, str(ROOT))
    from app.childcare_similarity.feature_config import AXIS_FEATURES

    all_feature_cols = {c for cols in AXIS_FEATURES.values() for c in cols}

    print("\n=== 取得列一覧 ===")
    for h in headers:
        if h in _FIXED_COLS:
            continue
        marker = "★" if h in all_feature_cols else "  "
        print(f"  {marker} {h}")

    print("\n=== childcare_similarity で使用する列 ===")
    for axis, cols in AXIS_FEATURES.items():
        print(f"\n[{axis}]")
        for col in cols:
            status = "✅" if col in headers else "❌"
            print(f"  {status} {col}")


async def main(args: argparse.Namespace) -> None:
    app_id = os.environ.get("ESTAT_APP_ID", "")
    if not app_id:
        logger.error("環境変数 ESTAT_APP_ID が未設定です")
        sys.exit(1)

    # 自治体マップ読み込み
    area_map = _load_area_map(MUNICIPALITY_CSV)
    cd_areas = list(area_map.keys())
    logger.info("対象自治体数: %d", len(cd_areas))

    # API 取得
    data = await _fetch(app_id, cd_areas)

    # 行生成
    headers, rows = _build_dataframe_rows(data, area_map, year_code=args.year)

    # CSV 書き出し
    output = Path(args.output)
    _write_csv(output, headers, rows)

    # 列名表示（オプション）
    if args.show_columns:
        _show_columns(headers)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="dataSet_clean.csv を e-Stat API から再生成する")
    parser.add_argument(
        "--year", default=TARGET_YEAR,
        help=f"取得する年度コード（デフォルト: {TARGET_YEAR}）",
    )
    parser.add_argument(
        "--output", default=str(OUTPUT_CSV),
        help="出力先 CSV パス",
    )
    parser.add_argument(
        "--show-columns", action="store_true",
        help="取得後に列名を軸別に表示する",
    )
    args = parser.parse_args()

    asyncio.run(main(args))
