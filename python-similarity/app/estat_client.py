from __future__ import annotations

import asyncio
import logging
import ssl
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import certifi

logger = logging.getLogger(__name__)

ESTAT_API  = "https://api.e-stat.go.jp/rest/3.0/app/getStatsData"
TARGET_YEAR = "2020100000"
BATCH_SIZE  = 100   # 1回のAPIコールあたりの自治体数（e-Stat API の上限）
MAX_CONCURRENT = 10  # 同時リクエスト数の上限（レート制限対策）

# ---------------------------------------------------------------------------
# 取得する統計表と指標コードの設定
# ---------------------------------------------------------------------------

STATS_CONFIG: list[dict[str, object]] = [
    # 社会・人口統計体系 市区町村データ
    # A1101: 総人口, A7101: 世帯数
    # A1404: 0〜14歳人口（年少人口）, A1406: 0〜5歳人口
    # A4101: 保育所数（同統計表内の施設系指標）
    {
        "statsDataId": "0000020201",
        "cdCat01": ["A1101", "A7101", "A1404", "A1406", "A4101"],
    },
    # 経済センサス 産業別売上
    {
        "statsDataId": "0000020203",
        "cdCat01": [
            "C610101", "C610104", "C610105", "C610106", "C610107",
            "C610108", "C610109", "C610110", "C610111", "C610114",
            "C610115", "C610116", "C610117", "C610118", "C610119",
            "C610120", "C610121", "C610122",
        ],
    },
    # 地方財政状況調査
    # D2201: 財政力指数, D2202: 経常収支比率, D2209: 一般財源
    {
        "statsDataId": "0000020204",
        "cdCat01": ["D2201", "D2202", "D2209"],
    },
    # 医療施設調査: I5101: 病院数
    {
        "statsDataId": "0000020209",
        "cdCat01": ["I5101"],
    },
    # 社会福祉施設等調査: J2503: 保育所数
    {
        "statsDataId": "0000020210",
        "cdCat01": ["J2503"],
    },
]


# ---------------------------------------------------------------------------
# 内部: 同期 API コール + XML パース
# ---------------------------------------------------------------------------

def _fetch_one(
    app_id: str,
    stats_data_id: str,
    cd_cat01: list[str],
    cd_areas: list[str],
) -> dict[str, dict[str, float | None]]:
    """1回のAPIコールを実行し {cd_area: {指標名: 値}} を返す（同期）。"""
    params = urllib.parse.urlencode({
        "appId":            app_id,
        "lang":             "J",
        "statsDataId":      stats_data_id,
        "cdCat01":          ",".join(cd_cat01),
        "cdArea":           ",".join(cd_areas),
        "cdTime":           TARGET_YEAR,
        "metaGetFlg":       "Y",
        "cntGetFlg":        "N",
        "explanationGetFlg": "N",
        "annotationGetFlg": "N",
        "sectionHeaderFlg": "1",
        "replaceSpChars":   "0",
    })
    url = f"{ESTAT_API}?{params}"

    logger.debug("GET %s (areas=%d)", stats_data_id, len(cd_areas))

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(url, timeout=30, context=ssl_ctx) as resp:
        xml_bytes = resp.read()

    return _parse_xml(xml_bytes)


def _parse_xml(xml_bytes: bytes) -> dict[str, dict[str, float | None]]:
    """e-Stat XML レスポンスを {cd_area: {指標名: 値}} に変換する。"""
    root = ET.fromstring(xml_bytes)

    # エラーチェック
    status = root.findtext(".//STATUS")
    if status != "0":
        error_msg = root.findtext(".//ERROR_MSG", "Unknown error")
        raise RuntimeError(f"e-Stat API error (status={status}): {error_msg}")

    # 指標コード → 表示名（例: "A1101" → "A1101_総人口【人】"）
    indicator_names: dict[str, str] = {}
    for cls_obj in root.findall(".//CLASS_OBJ"):
        if cls_obj.get("id") != "cat01":
            continue
        for cls in cls_obj.findall("CLASS"):
            code = cls.get("code", "")
            name = cls.get("name", code)
            unit = cls.get("unit", "")
            indicator_names[code] = f"{name}【{unit}】" if unit else name

    # VALUE 要素を変換
    result: dict[str, dict[str, float | None]] = {}
    for val in root.findall(".//VALUE"):
        area  = val.get("area", "")
        cat01 = val.get("cat01", "")
        ind_name = indicator_names.get(cat01, cat01)

        text = (val.text or "").strip()
        try:
            value: float | None = float(text.replace(",", ""))
        except ValueError:
            value = None

        result.setdefault(area, {})[ind_name] = value

    return result


# ---------------------------------------------------------------------------
# 公開: 非同期一括取得
# ---------------------------------------------------------------------------

async def fetch_all_data(
    app_id: str,
    cd_areas: list[str],
) -> dict[str, dict[str, float | None]]:
    """
    e-Stat API から全統計データを非同期並列で取得する。

    Args:
        app_id:   e-Stat アプリケーション ID
        cd_areas: 取得する自治体コードのリスト

    Returns:
        {cd_area: {指標名: 値}} 形式の辞書（欠損は None）
    """
    # 自治体コードをバッチ分割
    batches = [cd_areas[i:i + BATCH_SIZE] for i in range(0, len(cd_areas), BATCH_SIZE)]
    total_calls = len(STATS_CONFIG) * len(batches)

    logger.info(
        "Fetching from e-Stat API: %d stats × %d batches = %d calls",
        len(STATS_CONFIG), len(batches), total_calls,
    )

    # 同時接続数を制限するセマフォ
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async def _guarded(cfg: dict, batch: list[str]) -> dict[str, dict[str, float | None]]:
        async with sem:
            return await asyncio.to_thread(
                _fetch_one,
                app_id,
                str(cfg["statsDataId"]),
                list(cfg["cdCat01"]),
                batch,
            )

    tasks = [
        _guarded(cfg, batch)
        for cfg in STATS_CONFIG
        for batch in batches
    ]

    results = await asyncio.gather(*tasks)

    # 全結果をマージ
    merged: dict[str, dict[str, float | None]] = {}
    for partial in results:
        for area, indicators in partial.items():
            merged.setdefault(area, {}).update(indicators)

    logger.info("Fetched data for %d areas from e-Stat API", len(merged))
    return merged
