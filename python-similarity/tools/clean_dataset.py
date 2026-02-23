#!/usr/bin/env python3
"""
dataSet.csv → dataSet_clean.csv への整形スクリプト。

【元CSVの問題点】
  - 1〜8行目: タイトル・凡例などのメタデータ（データ行ではない）
  - 9行目: 列ヘッダー（指標名 + "注釈" が交互に並ぶ）
  - 10行目以降: データ（指標値 + 注釈フラグが交互に並ぶ）
  - 数値にカンマ区切り（例: "1,973,395"）
  - 欠損フラグ: "X"（秘匿）, "-"（不明）, "***"（未調査）

【整形後の仕様】
  - ヘッダー: year_code, year, cd_area, area_name, A1101_総人口【人】, ...
  - 注釈列をすべて除去
  - 数値のカンマを除去（"1,973,395" → "1973395"）
  - 欠損フラグ（X / - / ***）は空文字列 "" に統一
  - 文字コード: UTF-8

使い方:
    python tools/clean_dataset.py
    python tools/clean_dataset.py --input dataSet.csv --output dataSet_clean.csv
"""

import argparse
import csv
from pathlib import Path

# デフォルトの入出力パス（プロジェクトルートからの相対）
DEFAULT_INPUT  = Path("dataSet.csv")
DEFAULT_OUTPUT = Path("dataSet_clean.csv")

# 欠損を表すフラグ値（これらは空文字列 "" に変換する）
MISSING_FLAGS = {"X", "-", "***"}

# 元CSVで固定カラムが何列あるか（調査年コード / 調査年 / 地域コード / 地域 / 区切り）
FIXED_COL_COUNT = 5  # col 0-4（col4 は "/項目" ラベルで不要）

# データカラムが始まる列インデックス
DATA_START_COL = 5


def clean_value(raw: str) -> str:
    """
    数値文字列を正規化する。

    - 欠損フラグ（X / - / ***）→ ""
    - カンマ区切り数値 → カンマ除去（"1,973,395" → "1973395"）
    - その他はそのまま
    """
    v = raw.strip()
    if v in MISSING_FLAGS or v == "":
        return ""
    return v.replace(",", "")


def extract_indicator_headers(name_row: list[str]) -> list[str]:
    """
    ヘッダー行から指標名だけを抽出する（注釈列 "注釈" をスキップ）。

    name_row 例:
        ["調査年 コード", "調査年", "地域 コード", "地域", "/項目",
         "A1101_総人口【人】", "注釈",
         "A7101_世帯数【世帯】", "注釈", ...]

    → ["A1101_総人口【人】", "A7101_世帯数【世帯】", ...]
    """
    indicators = []
    for i in range(DATA_START_COL, len(name_row), 2):
        label = name_row[i].strip()
        if label and label != "注釈":
            indicators.append(label)
    return indicators


def extract_indicator_values(data_row: list[str], n_indicators: int) -> list[str]:
    """
    データ行から指標値だけを抽出する（注釈列をスキップ）。

    data_row 例:
        ["2020100000", "2020年度", "01100", "北海道 札幌市", "",
         "1,973,395", "",   ← A1101 値 + 注釈
         "969,161",  "",   ← A7101 値 + 注釈
         ...]

    → ["1973395", "969161", ...]
    """
    values = []
    for i in range(DATA_START_COL, DATA_START_COL + n_indicators * 2, 2):
        raw = data_row[i] if i < len(data_row) else ""
        values.append(clean_value(raw))
    return values


def main(input_path: Path, output_path: Path) -> None:
    with open(input_path, encoding="utf-8", newline="") as fin:
        reader = csv.reader(fin)
        all_rows = list(reader)

    # -----------------------------------------------------------------
    # ヘッダー解析（元CSVの9行目 = index 8）
    # -----------------------------------------------------------------
    name_row = all_rows[8]  # 0-indexed で 8 が9行目
    indicator_headers = extract_indicator_headers(name_row)

    # 出力CSVの列: 固定4列 + 指標列
    out_headers = ["year_code", "year", "cd_area", "area_name"] + indicator_headers
    n_indicators = len(indicator_headers)

    # -----------------------------------------------------------------
    # データ行処理（10行目以降 = index 9以降）
    # -----------------------------------------------------------------
    out_rows: list[list[str]] = []

    for row in all_rows[9:]:
        # 空行・短すぎる行はスキップ
        if len(row) < DATA_START_COL:
            continue

        fixed = [
            row[0].strip(),  # year_code  例: "2020100000"
            row[1].strip(),  # year       例: "2020年度"
            row[2].strip(),  # cd_area    例: "01100"
            row[3].strip(),  # area_name  例: "北海道 札幌市"
        ]

        indicators = extract_indicator_values(row, n_indicators)
        out_rows.append(fixed + indicators)

    # -----------------------------------------------------------------
    # 出力
    # -----------------------------------------------------------------
    with open(output_path, "w", encoding="utf-8", newline="") as fout:
        writer = csv.writer(fout)
        writer.writerow(out_headers)
        writer.writerows(out_rows)

    # 実行結果サマリー
    print(f"入力 : {input_path}  ({len(all_rows)} 行)")
    print(f"出力 : {output_path}")
    print(f"データ行: {len(out_rows)} 行")
    print(f"列数    : {len(out_headers)}  (固定 4 + 指標 {n_indicators})")
    print()
    print("【指標一覧】")
    for i, h in enumerate(indicator_headers, 1):
        print(f"  {i:2d}. {h}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="dataSet.csv を整形する")
    parser.add_argument("--input",  default=str(DEFAULT_INPUT),  help="入力CSVパス")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="出力CSVパス")
    args = parser.parse_args()

    main(Path(args.input), Path(args.output))
