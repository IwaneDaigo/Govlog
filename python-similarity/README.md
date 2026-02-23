# Gov-Sync Similarity Service

Python FastAPI service that computes municipality (自治体) similarity scores
using e-Stat statistical data and returns candidates ranked by cosine similarity.

---

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set your e-Stat App ID
cp .env.example .env
# → edit .env and set ESTAT_APP_ID

# 3. Start server
uvicorn app.main:app --reload
```

---

## POST /similarity

### Request

```json
{
  "keywords": ["子育て支援", "保育", "少子化"],
  "base_cdArea": "26100",
  "candidate_cdAreas": ["27100", "28100", "14100"],
  "limit": 20,
  "core_datasets": [
    { "statsDataId": "CORE_A", "weight": 1.0, "filters": { "cdTime": "2020100000" } },
    { "statsDataId": "CORE_B", "weight": 1.0, "filters": { "cdTime": "2020100000" } }
  ],
  "auto_select": {
    "k": 2,
    "max_cost": 1.0,
    "whitelist_tags": ["子育て", "福祉", "人口"],
    "blacklist_tags": []
  }
}
```

### Response

```json
{
  "items": ["27100", "28100", "14100"],
  "scores": { "27100": 0.8421, "28100": 0.8014, "14100": 0.6122 },
  "selected": {
    "core": ["CORE_A", "CORE_B"],
    "auto": ["AUTO_X", "AUTO_Y"]
  }
}
```

`items` is **always** sorted by similarity (highest → lowest). This is the primary output.

---

## curl example

```bash
curl -X POST http://localhost:8000/similarity \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": ["子育て支援"],
    "base_cdArea": "26100",
    "candidate_cdAreas": ["27100", "28100"],
    "limit": 20,
    "core_datasets": [
      { "statsDataId": "0003410400", "weight": 1.0, "filters": { "cdTime": "2020100000" } }
    ],
    "auto_select": { "k": 1, "max_cost": 1.0, "whitelist_tags": ["子育て"] }
  }'
```

---

## Architecture

```
POST /similarity
      │
      ├─ DatasetSelector      ← catalog/datasets_catalog.json でauto選定
      │
      ├─ EstatClient          ← e-Stat APIからデータ取得（ページング・TTLキャッシュ）
      │
      ├─ GenericExtractor     ← VALUE[] → {cdArea: [float...]} に変換
      │
      ├─ zscore_normalize     ← dataset内で特徴量を正規化
      │
      ├─ build_combined_vectors ← weight掛けてconcat
      │
      └─ rank_candidates      ← cosine類似度で降順ソート → items[]
```

### Similarity algorithm

For each dataset *d*:

1. Extract vector **V_d(area)** for all areas
2. Z-score normalise within the dataset (per feature across areas)
3. Apply weight *w_d*

Then concatenate across datasets:

```
V_total(area) = [w1·V1_norm | w2·V2_norm | …]
score(area)   = cosine(V_total(base), V_total(area))
```

---

## Adding a custom extractor

Create `app/feature_extractors/my_extractor.py` implementing `BaseExtractor`:

```python
from app.feature_extractors.base import BaseExtractor

class MyExtractor(BaseExtractor):
    def extract(self, response_data: dict, cdAreas: list[str]) -> dict[str, list[float]]:
        ...
```

Register it in `main.py` and dispatch based on `statsDataId` or `feature_spec.mode`.

---

## Catalog format (`catalog/datasets_catalog.json`)

```json
[
  {
    "statsDataId": "0003410379",
    "title": "子育て・保育関連指標",
    "summary": "保育所入所率、出生数、児童数",
    "tags": ["子育て", "福祉", "人口"],
    "cost": 0.6,
    "filters_template": { "cdTime": "2020100000" },
    "feature_spec": { "mode": "cat01_tab" }
  }
]
```

- `cost`: auto選定でのコスト上限フィルタ (0–1.0)
- `filters_template`: e-Stat APIに渡すクエリパラメータ
- `tags`: キーワードマッチ・whitelist_tagsで使用
