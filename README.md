# Gov-Sync MVP

Gov-Sync is a prototype dashboard for sharing municipal policies.
This repository is a monorepo with `apps/web` (Next.js) and `apps/api` (Fastify).

## Structure

```text
gov-sync/
  apps/
    api/
    web/
  data/
    municipalities.csv
    twins.sample.json
    policies.sample.json
```

## Setup

```bash
cd gov-sync
pnpm install
pnpm dev
```

- Web: `http://localhost:3000`
- API: `http://localhost:4000`

Python類似度APIも含めて一括起動する場合:

```bash
pnpm dev:all
```

## Demo Login

- Code: `131016`
- Code: `271004`
- Code: `011002`

## API Endpoints

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/municipalities?query=...&limit=...`
- `GET /api/search?keyword=...`
- `GET /api/policies/:policyId`

## Similarity Service Integration

`/api/search` can use the Python similarity service first, and fallback to `data/twins.json` if unavailable.

1. Start Python service:

```bash
cd python-similarity
pip install -r requirements.txt
cp .env.example .env
# set ESTAT_APP_ID in .env
uvicorn app.main:app --reload
```

2. Start Gov-Sync API with endpoint:

```bash
# PowerShell example
$env:SIMILARITY_API_BASE_URL="http://localhost:8000"
pnpm --filter @gov-sync/api dev
```

When `SIMILARITY_API_BASE_URL` is not set or the service fails, API falls back to twins JSON.

## Replace With Real Data

The API loads real files first and falls back to sample files.

- Policies: `data/policies.json` (fallback: `data/policies.sample.json`)
- Twins: `data/twins.json` (fallback: `data/twins.sample.json`)
- Municipality master: `data/municipalities.csv` (optional, used for login candidates and validation)

## PDF Split And View

This project can display policy PDFs without extracting their text.

1. Put a source sheet PDF anywhere in the repo (example: `data/source/R6hyouka.pdf`)
2. Create a split manifest JSON (example: `data/pdf-split.manifest.sample.json`)
3. Run:

```bash
pnpm --filter @gov-sync/api split:pdf -- \
  --input data/source/R6hyouka.pdf \
  --manifest data/pdf-split.manifest.sample.json \
  --outDir data/policies-pdf \
  --policiesOut data/policies.json
```

Generated files:
- Split PDFs: `data/policies-pdf/*.pdf`
- Metadata: `data/policies.json` (includes `pdfPath`)

The API serves PDFs at `/files/policies/...`, and the policy detail page shows an embedded PDF viewer.

Expected policy item format:

```json
{
  "id": "p-001",
  "municipalityCode": "131016",
  "municipalityName": "東京都千代田区",
  "title": "施策タイトル",
  "summary": "要約",
  "details": "詳細",
  "keywords": ["キーワード1", "キーワード2"]
}
```
