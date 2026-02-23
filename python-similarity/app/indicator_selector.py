from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 指標の分類
# ---------------------------------------------------------------------------

# C610xxx 以外の固定指標（人口・財政など）は常に含める
_FIXED_PREFIX = ("A", "D", "I")

# ---------------------------------------------------------------------------
# 同義語辞書
# 指標名に直接マッチしないキーワードを、指標名に含まれる語に展開する
# ---------------------------------------------------------------------------
SYNONYM_MAP: dict[str, list[str]] = {
    # 産業系
    "観光":     ["宿泊", "娯楽"],
    "旅行":     ["宿泊", "娯楽"],
    "農業":     ["農林"],
    "漁業":     ["農林"],
    "林業":     ["農林"],
    "IT":       ["情報通信"],
    "テック":   ["情報通信"],
    "デジタル": ["情報通信"],
    "物流":     ["運輸", "郵便"],
    "流通":     ["卸売", "小売"],
    "コンビニ": ["卸売", "小売"],
    "エネルギー": ["電気", "ガス"],
    "介護":     ["医療", "福祉"],
    "高齢者":   ["医療", "福祉"],
    # 子育て・教育系
    "子育て":   ["教育", "学習支援"],
    "少子化":   ["教育", "学習支援", "医療"],
    "保育":     ["教育", "学習支援"],
    # その他
    "スタートアップ": ["学術研究", "情報通信"],
    "不動産":   ["不動産", "物品賃貸"],
}


# ---------------------------------------------------------------------------
# 選定ロジック
# ---------------------------------------------------------------------------

def select_indicators(
    keywords: list[str],
    all_indicators: list[str],
) -> list[str]:
    """
    キーワードから使用する指標を選定して返す。

    【選定ルール】
    1. 固定指標（A/D/I プレフィックス）は常に含める
    2. 売上系指標（C610xxx）をキーワードで絞り込む
       Step B: キーワードを指標名に直接マッチ
       Step A: マッチしなければ同義語辞書で展開して再マッチ
    3. 売上系が 1 件もマッチしなければ全売上指標をフォールバックとして使用

    Args:
        keywords:       施策キーワードのリスト（例: ["観光", "IT"]）
        all_indicators: データセットに含まれる全指標名のリスト

    Returns:
        使用する指標名のリスト（元の順序を維持）
    """
    # 固定系と売上系に分離
    fixed_inds = [i for i in all_indicators if i[0] in _FIXED_PREFIX]
    sales_inds = [i for i in all_indicators if i[0] not in _FIXED_PREFIX]

    matched_sales: set[str] = set()

    for kw in keywords:
        # Step B: 指標名にキーワードが直接含まれるか
        direct = {ind for ind in sales_inds if kw in ind}

        if direct:
            matched_sales |= direct
            logger.debug("Keyword '%s' → direct match: %s", kw, [i.split("_")[0] for i in direct])
        else:
            # Step A: 同義語辞書で展開して再マッチ
            synonyms = SYNONYM_MAP.get(kw, [])
            expanded: set[str] = set()
            for syn in synonyms:
                expanded |= {ind for ind in sales_inds if syn in ind}

            if expanded:
                matched_sales |= expanded
                logger.debug(
                    "Keyword '%s' → synonym %s → match: %s",
                    kw, synonyms, [i.split("_")[0] for i in expanded],
                )
            else:
                logger.debug("Keyword '%s' → no match (ignored)", kw)

    # 1 件もマッチしなければ合計値指標にフォールバック
    # C610101: 農林漁業、C610104: 非農林漁業（公務を除く）の合計2列を使用
    if not matched_sales:
        total_inds = {ind for ind in sales_inds if "C610101" in ind or "C610104" in ind}
        matched_sales = total_inds if total_inds else set(sales_inds)
        logger.info("No sales indicators matched; falling back to total indicators: %s", [i.split("_")[0] for i in matched_sales])

    # 元の順序を維持して返す
    selected = [i for i in all_indicators if i in set(fixed_inds) | matched_sales]

    logger.info(
        "Selected %d indicators (%d fixed + %d sales) for keywords=%s",
        len(selected),
        len(fixed_inds),
        len(matched_sales),
        keywords,
    )
    return selected
