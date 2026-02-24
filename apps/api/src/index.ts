import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SimilarityClient, type SimilarityRequest } from "./lib/similarity-client";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as fontkit from "@pdf-lib/fontkit";
import { importPoliciesFromPdf } from "./services/pdf-import";

type Municipality = {
  code: string;
  name: string;
};

type TwinCity = {
  municipalityCode: string;
  municipalityName: string;
  score: number;
  axisScore?: { need: number; support: number; feasibility: number };
};

type TwinsMap = Record<string, TwinCity[]>;

type RawPolicy = {
  id: string;
  municipalityCode: string;
  municipalityName: string;
  title: string;
  summary?: string;
  details?: string;
  keywords?: string[];
  pdfPath?: string;
};

type Policy = {
  id: string;
  municipalityCode: string;
  municipalityName: string;
  title: string;
  summary: string;
  details: string;
  keywords: string[];
  pdfPath?: string;
  pdfUrl?: string;
};

type ProposalSection = {
  label: string;
  value: string;
};

type ProposalPdfRequest = {
  title?: string;
  sections?: ProposalSection[];
};

type ProposalDraft = {
    title: string;
    purpose: string;
    target: string;
    content: string;
    kpi: string;
    budget: string;
    period: string;
    evidence: string;
};

type ProposalSimilarRequest = {
    proposalDraft: ProposalDraft;
    municipalityCode?: string;
    yearRange?: [number, number];
    topK?: number;
};

type ProposalSimilarItem = {
    id: string;
    score: number;
    municipality: string;
    year: number | null;
    title: string;
    summary: string;
    evidenceSnippets: string[];
};

type ProposalReviewItem = {
    id: string;
    evidenceText: string;
};

type ProposalReviewRequest = {
    proposalDraft: ProposalDraft;
    similarItems: ProposalReviewItem[];
    style?: "strict" | "gentle";
    length?: "short" | "medium" | "long";
};

type ProposalReviewResponse = {
    revised_proposal: ProposalDraft;
    diff: Array<{ field: keyof ProposalDraft; before: string; after: string }>;
    overall_review: string;
    fit_analysis: {
        good_points: string[];
        weak_points: string[];
        matching_points: string[];
        non_matching_points: string[];
    };
    improvement_actions: string[];
    advice?: {
        kpi_suggestions: string[];
        risks: string[];
        implementation_steps: string[];
        budget_notes: string[];
        evaluation_plan: string[];
    };
    citations: Array<{
        source_id: string;
        municipality: string;
        year: number | null;
        quote: string;
        used_for: string;
    }>;
};

type MunicipalityMap = Record<string, { name: string }>;
type MunicipalityMasterItem = {
  municipalityCode: string;
  prefecture: string;
  municipalityName: string;
  municipalityDisplayName: string;
};

const rootDir = resolve(__dirname, "../../../");
const dataDir = resolve(rootDir, "data");
const policiesPdfDir = resolve(dataDir, "policies-pdf");
const similarityApiBaseUrl = process.env.SIMILARITY_API_BASE_URL?.trim() || "http://127.0.0.1:8000";
const similarityClient = new SimilarityClient(similarityApiBaseUrl);
const uploadTempDir = resolve(rootDir, "data/uploads");

type PendingImport = {
  tempAbsPath: string;
  tempRelativePath: string;
  municipalityCode: string;
  municipalityName: string;
  idPrefix: string;
  outDir: string;
  policiesOutPath: string;
  mergeToPoliciesJson: boolean;
  createdAt: number;
};

const pendingImports = new Map<string, PendingImport>();

const readJsonWithFallback = <T>(primaryFileName: string, fallbackFileName: string): T => {
  const primaryPath = resolve(dataDir, primaryFileName);
  const fallbackPath = resolve(dataDir, fallbackFileName);
  const targetPath = existsSync(primaryPath) ? primaryPath : fallbackPath;
  return JSON.parse(readFileSync(targetPath, "utf-8")) as T;
};

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
};

const stripBom = (value: string): string => value.replace(/^\uFEFF/, "");

const readMunicipalityMasterCsv = (): MunicipalityMasterItem[] => {
  const primaryPath = resolve(dataDir, "municipalities.csv");
  if (!existsSync(primaryPath)) return [];

  const lines = readFileSync(primaryPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (lines.length <= 1) return [];

  const header = parseCsvLine(lines[0]).map((h) => stripBom(h));
  const codeIdx = header.indexOf("municipalityCode");
  const prefectureIdx = header.indexOf("prefecture");
  const nameIdx = header.indexOf("municipalityName");
  const displayIdx = header.indexOf("municipalityDisplayName");
  if (codeIdx === -1 || nameIdx === -1) return [];

  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    return {
      municipalityCode: cols[codeIdx] ?? "",
      prefecture: prefectureIdx >= 0 ? cols[prefectureIdx] ?? "" : "",
      municipalityName: cols[nameIdx] ?? "",
      municipalityDisplayName: displayIdx >= 0 ? cols[displayIdx] ?? cols[nameIdx] ?? "" : cols[nameIdx] ?? ""
    };
  });
};

const normalizePdfPath = (value?: string): string | undefined => {
  if (!value) return undefined;
  const replaced = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!replaced || replaced.includes("..")) return undefined;
  return replaced.replace(/^policies-pdf\//, "");
};

const toPdfUrl = (pdfPath?: string): string | undefined => {
  const normalized = normalizePdfPath(pdfPath);
  if (!normalized) return undefined;
  const encoded = normalized
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `/files/policies/${encoded}`;
};

const toPolicy = (item: RawPolicy): Policy => ({
  id: item.id,
  municipalityCode: item.municipalityCode,
  municipalityName: item.municipalityName,
  title: item.title,
  summary: item.summary ?? "",
  details: item.details ?? "",
  keywords: item.keywords ?? [],
  pdfPath: normalizePdfPath(item.pdfPath),
  pdfUrl: toPdfUrl(item.pdfPath)
});

const rawPolicies = readJsonWithFallback<RawPolicy[]>("policies.json", "policies.sample.json");
let policies: Policy[] = rawPolicies.map(toPolicy);

const twins = readJsonWithFallback<TwinsMap>("twins.json", "twins.sample.json");
const municipalityMaster = readMunicipalityMasterCsv();

const buildMunicipalities = (policyList: Policy[], twinsMap: TwinsMap, masterList: MunicipalityMasterItem[]): MunicipalityMap => {
  const fromMaster = masterList.reduce<MunicipalityMap>((acc, item) => {
    if (!item.municipalityCode) return acc;
    acc[item.municipalityCode] = { name: item.municipalityDisplayName || item.municipalityName };
    return acc;
  }, {});

  const fromPolicies = policyList.reduce<MunicipalityMap>((acc, policy) => {
    acc[policy.municipalityCode] = { name: policy.municipalityName };
    return acc;
  }, {});

  const fromTwins = Object.entries(twinsMap).reduce<MunicipalityMap>((acc, [baseCode, relatedCities]) => {
    if (!acc[baseCode]) {
      acc[baseCode] = { name: baseCode };
    }
    relatedCities.forEach((city) => {
      acc[city.municipalityCode] = { name: city.municipalityName };
    });
    return acc;
  }, {});

  return { ...fromTwins, ...fromPolicies, ...fromMaster };
};

const municipalities = buildMunicipalities(policies, twins, municipalityMaster);
const municipalityMasterByCode = municipalityMaster.reduce<Record<string, MunicipalityMasterItem>>((acc, item) => {
  acc[item.municipalityCode] = item;
  return acc;
}, {});

const app = Fastify({ logger: true });

app.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  credentials: true
});

app.register(cookie, {
  secret: "gov-sync-dev-secret"
});
app.register(multipart, {
  limits: {
    files: 1,
    fileSize: 100 * 1024 * 1024
  }
});

if (existsSync(policiesPdfDir)) {
  app.register(fastifyStatic, {
    root: policiesPdfDir,
    prefix: "/files/policies/",
    decorateReply: false,
    index: false
  });
}

const getSession = (request: { cookies: Record<string, string | undefined> }): Municipality | null => {
  const rawCode = request.cookies.municipalityCode;
  if (!rawCode) return null;
  const direct = municipalities[rawCode];
  if (direct) return { code: rawCode, name: direct.name };

  const normalized = normalizeToCdArea(rawCode);
  if (!normalized) return null;
  const normalizedUser = municipalities[normalized];
  if (!normalizedUser) return null;
  return { code: normalized, name: normalizedUser.name };
};

const sessionCookieOptions = {
  path: "/",
  httpOnly: true as const,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 8
};

const requireSession = (
  request: { cookies: Record<string, string | undefined> },
  reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }
) => {
  const municipality = getSession(request);
  if (!municipality) {
    reply.code(401).send({ message: "Unauthorized" });
    return null;
  }
  return municipality;
};

const cleanupOldPendingImports = () => {
  const expireMs = 30 * 60 * 1000;
  const now = Date.now();
  for (const [token, item] of pendingImports.entries()) {
    if (now - item.createdAt > expireMs) {
      try {
        if (existsSync(item.tempAbsPath)) unlinkSync(item.tempAbsPath);
      } catch {
        // no-op
      }
      pendingImports.delete(token);
    }
  }
};

const normalizeToCdArea = (code: string): string | null => {
  const trimmed = code.trim();
  if (/^\d{5}$/.test(trimmed)) return trimmed;
  // Some master/demo codes are 6-digit JIS style with check digit.
  if (/^\d{6}$/.test(trimmed)) return trimmed.slice(0, 5);
  return null;
};

const buildSimilarCitiesFromSimilarity = async (
  baseCode: string,
  keyword: string
): Promise<TwinCity[] | null> => {
  if (!similarityApiBaseUrl) return null;

  const normalizedBaseCode = normalizeToCdArea(baseCode);
  if (!normalizedBaseCode) return null;

  const candidateCodes = Array.from(
    new Set(
      Object.keys(municipalities)
        .map((code) => normalizeToCdArea(code))
        .filter((code): code is string => Boolean(code) && code !== normalizedBaseCode)
    )
  );
  if (candidateCodes.length === 0) return null;

  const payload: SimilarityRequest = {
    base_cdArea: normalizedBaseCode,
    candidate_cdAreas: candidateCodes,
    limit: candidateCodes.length,
    keywords: keyword ? [keyword] : []
  };

  try {
    if (!similarityClient) return null;
    const result = await similarityClient.similarity(payload);
    const neighbors = result.neighbors ?? [];
    if (neighbors.length === 0) return null;

    return neighbors.map((neighbor) => {
      const code = neighbor.city;
      const masterName = municipalityMasterByCode[code]?.municipalityDisplayName ?? municipalityMasterByCode[code]?.municipalityName;
      const localName =
        municipalities[code]?.name ??
        Object.entries(municipalities).find(([rawCode]) => normalizeToCdArea(rawCode) === code)?.[1].name;

      return {
        municipalityCode: code,
        municipalityName: neighbor.city_name || masterName || localName || code,
        score: neighbor.total_similarity,
        axisScore: neighbor.axis_similarity
      };
    });
  } catch (error) {
    app.log.warn(
      {
        err: error,
        baseCode: normalizedBaseCode,
        candidateCount: candidateCodes.length
      },
      "Similarity API call failed. Falling back to local ranking."
    );
    return null;
  }
};

const buildFallbackSimilarCities = (
  baseCode: string,
  keyword: string,
  limit = 20
): TwinCity[] => {
  const normalizedBase = normalizeToCdArea(baseCode) ?? baseCode;
  const twinsFallback = twins[baseCode] ?? twins[normalizedBase] ?? [];
  if (twinsFallback.length > 0) {
    return twinsFallback.slice(0, limit);
  }

  const keywordLc = keyword.trim().toLowerCase();
  const policyCountByCode = new Map<string, number>();
  for (const policy of policies) {
    const code = normalizeToCdArea(policy.municipalityCode) ?? policy.municipalityCode;
    if (code === normalizedBase) continue;
    if (keywordLc) {
      const haystack = `${policy.title} ${policy.summary} ${policy.details} ${policy.keywords.join(" ")}`.toLowerCase();
      if (!haystack.includes(keywordLc)) continue;
    }
    policyCountByCode.set(code, (policyCountByCode.get(code) ?? 0) + 1);
  }

  const candidates = Array.from(
    new Set(
      Object.keys(municipalities)
        .map((code) => normalizeToCdArea(code) ?? code)
        .filter((code) => code !== normalizedBase)
    )
  );

  candidates.sort((a, b) => {
    const aCount = policyCountByCode.get(a) ?? 0;
    const bCount = policyCountByCode.get(b) ?? 0;
    if (aCount !== bCount) return bCount - aCount;
    return a.localeCompare(b);
  });

  return candidates.slice(0, limit).map((code) => {
    const masterName = municipalityMasterByCode[code]?.municipalityDisplayName ?? municipalityMasterByCode[code]?.municipalityName;
    const localName =
      municipalities[code]?.name ??
      Object.entries(municipalities).find(([rawCode]) => (normalizeToCdArea(rawCode) ?? rawCode) === code)?.[1].name;
    return {
      municipalityCode: code,
      municipalityName: masterName ?? localName ?? code,
      score: 0
    };
  });
};

const normalizeProposalDraft = (draft: ProposalDraft): ProposalDraft => ({
    title: draft.title.trim(),
    purpose: draft.purpose.trim(),
    target: draft.target.trim(),
    content: draft.content.trim(),
    kpi: draft.kpi.trim(),
    budget: draft.budget.trim(),
    period: draft.period.trim(),
    evidence: draft.evidence.trim()
});

const proposalDraftToText = (draft: ProposalDraft): string =>
    [
        draft.title,
        draft.purpose,
        draft.target,
        draft.content,
        draft.kpi,
        draft.budget,
        draft.period,
        draft.evidence
    ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .join(" ");

const extractEvidenceSnippet = (policy: Policy, keyword: string): string => {
    const haystack = `${policy.title} ${policy.summary} ${policy.details} ${(policy.keywords ?? []).join(" ")}`.trim();
    if (!keyword) return haystack.slice(0, 180);
    const idx = haystack.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx < 0) return haystack.slice(0, 180);
    const start = Math.max(0, idx - 40);
    const end = Math.min(haystack.length, idx + 120);
    return haystack.slice(start, end);
};
const tokenizeForSimilarity = (text: string): string[] =>
    text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 2);

const calcTextSimilarity = (left: string, right: string): number => {
    const leftSet = new Set(tokenizeForSimilarity(left));
    const rightSet = new Set(tokenizeForSimilarity(right));
    if (leftSet.size === 0 || rightSet.size === 0) return 0;

    let intersection = 0;
    for (const token of leftSet) {
        if (rightSet.has(token)) intersection += 1;
    }
    const union = leftSet.size + rightSet.size - intersection;
    return union > 0 ? intersection / union : 0;
};

const normalizeCitySimilarity = (score: number): number => {
    // Keep 0..1 as-is; only remap -1..1 style negatives.
    const normalized = score < 0 ? (score + 1) / 2 : score;
    return Math.max(0, Math.min(1, normalized));
};

const validateProposalDraft = (value: unknown): value is ProposalDraft => {
    if (!value || typeof value !== "object") return false;
    const draft = value as Record<string, unknown>;
    const fields = ["title", "purpose", "target", "content", "kpi", "budget", "period", "evidence"];
    return fields.every((field) => typeof draft[field] === "string" && String(draft[field]).trim().length > 0);
};

const validateReviewItems = (value: unknown): value is ProposalReviewItem[] => {
    if (!Array.isArray(value)) return false;
    return value.every((item) => {
        if (!item || typeof item !== "object") return false;
        const obj = item as Record<string, unknown>;
        return typeof obj.id === "string"
            && obj.id.length > 0
            && typeof obj.evidenceText === "string"
            && obj.evidenceText.trim().length > 0;
    });
};

const buildReviewPrompt = (
    proposalDraft: ProposalDraft,
    similarItems: ProposalReviewItem[],
    style: "strict" | "gentle",
    length: "short" | "medium" | "long"
): string => {
    const evidence = similarItems
        .map((item, idx) => `# Evidence ${idx + 1} (id=${item.id})\n${item.evidenceText}`)
        .join("\n\n");

    return [
        "\u3042\u306a\u305f\u306f\u81ea\u6cbb\u4f53\u653f\u7b56\u306e\u4f01\u753b\u66f8\u6dfb\u524a\u5b98\u3067\u3059\u3002",
        `\u53b3\u3057\u3055: ${style}`,
        `\u9577\u3055: ${length}`,
        "",
        "## \u4f01\u753b\u66f8\u30c9\u30e9\u30d5\u30c8",
        JSON.stringify(proposalDraft, null, 2),
        "",
        "## \u53c2\u8003\u8cc7\u6599\uff08\u6839\u62e0\uff09",
        evidence,
        "",
        "## \u51fa\u529bJSON\u30b9\u30ad\u30fc\u30de",
        "{",
        '  "revised_proposal": { "title": "", "purpose": "", "target": "", "content": "", "kpi": "", "budget": "", "period": "", "evidence": "" },',
        '  "diff": [ { "field": "kpi", "before": "", "after": "" } ],',
        '  "overall_review": "",',
        '  "fit_analysis": {',
        '    "good_points": [],',
        '    "weak_points": [],',
        '    "matching_points": [],',
        '    "non_matching_points": []',
        '  },',
        '  "improvement_actions": [],',
        '  "citations": [ { "source_id": "", "municipality": "", "year": null, "quote": "", "used_for": "" } ]',
        "}",
        "",
        "\u5fc5\u305aJSON\u306e\u307f\u8fd4\u3059\u3002\u6839\u62e0\u306b\u306a\u3044\u65ad\u5b9a\u306f\u3057\u306a\u3044\u3002\u6570\u5024\u306f\u6839\u62e0\u304c\u306a\u3044\u5834\u5408\u300c\u4f8b\u300d\u3068\u660e\u8a18\u3002",
        "citations \u306f\u6839\u62e0\u30c6\u30ad\u30b9\u30c8\u306e\u77ed\u3044\u629c\u7c8b\u306e\u307f\u3002\u9577\u6587\u5f15\u7528\u306f\u7981\u6b62\u3002",
        "\u7dcf\u8a55\u306f1\u3064\u306e\u6bb5\u843d\u3067\u3001\u985e\u4f3c\u65bd\u7b56\u3068\u306e\u6574\u5408/\u4e0d\u6574\u5408\u3092\u542b\u3081\u3066\u8a18\u8f09\u3059\u308b\u3002",
        "\u50be\u5411\u7684\u306a\u6ce8\u610f\u3088\u308a\u3001\u5177\u4f53\u7684\u306a\u6539\u5584\u884c\u52d5\u3092 improvement_actions \u306b\u5217\u6319\u3059\u308b\u3002",
        "fit_analysis.good_points / weak_points \u306f\u4f01\u753b\u66f8\u81ea\u8eab\u306e\u5206\u6790\u3001matching_points / non_matching_points \u306f\u985e\u4f3c\u65bd\u7b56\u3068\u306e\u6bd4\u8f03\u7d50\u679c\u3092\u66f8\u304f\u3002",
        "\u5fc5\u305a citations.used_for \u306b\u3001\u3069\u306e\u8a55\u4fa1\u306e\u6839\u62e0\u306b\u4f7f\u3063\u305f\u304b\u3092\u8a18\u8f09\u3059\u308b\u3002",
        "\u51fa\u529b\u8cea\u8981\u4ef6:",
        "- overall_review \u306f 300\u6587\u5b57\u4ee5\u4e0a\u3067\u3001\u73fe\u72b6\u8a55\u4fa1\u2192\u8ab2\u984c\u2192\u6210\u529f\u6761\u4ef6\u3092\u542b\u3081\u308b\u3002",
        "- fit_analysis \u5404\u9805\u76ee\u306f\u5c11\u306a\u304f\u3068\u3082 3 \u9805\u76ee\u3002\u62bd\u8c61\u8a9e\u3060\u3051\u3067\u306f\u306a\u304f\u3001\u3069\u306e\u8a18\u8f09\u3068\u7d10\u3065\u304f\u304b\u3092\u66f8\u304f\u3002",
        "- improvement_actions \u306f\u5c11\u306a\u304f\u3068\u3082 5 \u9805\u76ee\u3002\u5404\u9805\u76ee\u306b\u300c\u884c\u52d5\u300d\u300c\u671f\u9650\u300d\u300c\u6210\u679c\u7269\u300d\u3092\u542b\u3081\u308b\u3002",
        "- \u6570\u5024\u3092\u793a\u3059\u3068\u304d\u306f\u6839\u62e0\u304c\u306a\u3051\u308c\u3070\u300c\u4f8b\u300d\u3068\u660e\u8a18\u3059\u308b\u3002",
        "- \u4f01\u753b\u66f8\u306b\u300c\u672a\u5b9a\u300d\u304c\u591a\u3044\u5834\u5408\u306f\u3001\u57cb\u3081\u308b\u3079\u304d\u7a7a\u6b04\u3068\u5fc5\u8981\u306a\u30a8\u30d3\u30c7\u30f3\u30b9\u3092\u4f18\u5148\u5ea6\u9806\u3067\u793a\u3059\u3002",
        "- \u6587\u4f53\u306f\u8aad\u307f\u3084\u3059\u3044\u300c\u3067\u3059\u30fb\u307e\u3059\u8abf\u300d\u306b\u3057\u30011\u6587\u309250\u6587\u5b57\u524d\u5f8c\u306e\u77ed\u6587\u4e2d\u5fc3\u3067\u66f8\u304f\u3002",
        "- overall_review \u306f 3\u301c5 \u6587\u3067\u6bb5\u843d\u69cb\u6210\u306b\u3059\u308b\u3002"
    ].join("\n");
};

const callGemini = async (prompt: string): Promise<string> => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY_MISSING");
    }

    const baseUrl = (process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? "3072");
    const configuredModels = (process.env.GEMINI_MODELS ?? "gemini-2.0-flash,gemini-1.5-flash,gemini-1.5-pro")
        .split(",")
        .map((model) => model.trim())
        .filter((model) => model.length > 0);
    const apiVersions = ["v1beta", "v1"];

    const discoveredModels = new Set<string>();
    for (const version of apiVersions) {
        const listUrl = `${baseUrl}/${version}/models?key=${encodeURIComponent(apiKey)}`;
        try {
            const listRes = await fetch(listUrl);
            if (!listRes.ok) {
                continue;
            }
            const listPayload = (await listRes.json()) as {
                models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
            };
            for (const model of listPayload.models ?? []) {
                const methods = model.supportedGenerationMethods ?? [];
                if (!methods.includes("generateContent")) {
                    continue;
                }
                const rawName = model.name ?? "";
                const shortName = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
                if (shortName) {
                    discoveredModels.add(shortName);
                }
            }
        } catch {
            // ignore and keep fallback list
        }
    }

    const modelList = [
        ...configuredModels.filter((model) => discoveredModels.size === 0 || discoveredModels.has(model)),
        ...Array.from(discoveredModels).filter((model) => !configuredModels.includes(model))
    ];

    let lastErrorCode = "";
    let lastAttemptUrl = "";
    for (const model of modelList) {
        for (const version of apiVersions) {
            const url = `${baseUrl}/${version}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const safeUrl = `${baseUrl}/${version}/models/${model}:generateContent`;
            lastAttemptUrl = safeUrl;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: Number.isFinite(maxOutputTokens) ? Math.max(1024, Math.min(maxOutputTokens, 8192)) : 3072
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                let apiErrorMessage = "";
                try {
                    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
                    apiErrorMessage = parsed.error?.message?.trim() ?? "";
                } catch {
                    // Keep raw text path when JSON parse fails.
                }
                if (response.status === 429) {
                    const retryAfter = response.headers.get("retry-after");
                    lastErrorCode = `GEMINI_RATE_LIMIT:429:${retryAfter ?? ""}`;
                } else {
                    const messageSuffix = apiErrorMessage ? `:${apiErrorMessage.slice(0, 300)}` : "";
                    lastErrorCode = `GEMINI_API_FAILED:${response.status}:${response.statusText}${messageSuffix}`;
                }
                app.log.warn(
                    {
                        url: safeUrl,
                        status: response.status,
                        statusText: response.statusText,
                        body: errorText.slice(0, 1200)
                    },
                    "Gemini API attempt failed."
                );
                // Retry when endpoint/model is likely missing or this model is rate limited.
                if (response.status === 404 || response.status === 429) {
                    continue;
                }
                throw new Error(lastErrorCode);
            }

            const payload = (await response.json()) as {
                candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
                throw new Error("GEMINI_EMPTY_RESPONSE");
            }
            return text;
        }
    }

    throw new Error(lastErrorCode || `GEMINI_API_FAILED:404:Not Found:${lastAttemptUrl}`);
};

const parseReviewJson = (raw: string): ProposalReviewResponse => {
    const trimmed = raw.trim();
    const normalized = trimmed
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");

    const tryParse = (text: string): ProposalReviewResponse | null => {
        try {
            return JSON.parse(text) as ProposalReviewResponse;
        } catch {
            return null;
        }
    };

    const direct = tryParse(normalized);
    if (direct) return direct;

    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
        const sliced = normalized.slice(start, end + 1);
        const recovered = tryParse(sliced);
        if (recovered) return recovered;
    }

    throw new Error("GEMINI_INVALID_JSON");
};

const normalizeReviewResponse = (
    value: unknown,
    proposalDraft: ProposalDraft,
    similarItems: ProposalReviewItem[]
): ProposalReviewResponse => {
    const parsed = (value ?? {}) as Partial<ProposalReviewResponse> & {
        advice?: {
            kpi_suggestions?: string[];
            risks?: string[];
            implementation_steps?: string[];
            budget_notes?: string[];
            evaluation_plan?: string[];
        };
    };
    const safeList = (items: unknown, fallback: string[] = []): string[] =>
        Array.isArray(items) ? items.map((item) => String(item)).filter((item) => item.trim().length > 0) : fallback;
    const safeText = (text: unknown, fallback = ""): string => (typeof text === "string" ? text : fallback);

    const revised = parsed.revised_proposal ?? proposalDraft;
    const overallReview =
        safeText(parsed.overall_review) ||
        safeList(parsed.advice?.kpi_suggestions).join(" ") ||
        "類似施策の根拠を踏まえ、企画の目的・対象・実施手順をさらに具体化すると実行可能性が向上します。";

    const response: ProposalReviewResponse = {
        revised_proposal: {
            title: safeText(revised.title, proposalDraft.title),
            purpose: safeText(revised.purpose, proposalDraft.purpose),
            target: safeText(revised.target, proposalDraft.target),
            content: safeText(revised.content, proposalDraft.content),
            kpi: safeText(revised.kpi, proposalDraft.kpi),
            budget: safeText(revised.budget, proposalDraft.budget),
            period: safeText(revised.period, proposalDraft.period),
            evidence: safeText(revised.evidence, proposalDraft.evidence)
        },
        diff: Array.isArray(parsed.diff)
            ? parsed.diff.filter((item): item is { field: keyof ProposalDraft; before: string; after: string } => {
                if (!item || typeof item !== "object") return false;
                const field = (item as { field?: unknown }).field;
                const before = (item as { before?: unknown }).before;
                const after = (item as { after?: unknown }).after;
                return (
                    typeof field === "string" &&
                    ["title", "purpose", "target", "content", "kpi", "budget", "period", "evidence"].includes(field) &&
                    typeof before === "string" &&
                    typeof after === "string"
                );
            })
            : [],
        overall_review: overallReview,
        fit_analysis: {
            good_points: safeList(parsed.fit_analysis?.good_points, safeList(parsed.advice?.kpi_suggestions).slice(0, 3)),
            weak_points: safeList(parsed.fit_analysis?.weak_points, safeList(parsed.advice?.risks).slice(0, 3)),
            matching_points: safeList(
                parsed.fit_analysis?.matching_points,
                safeList(parsed.advice?.implementation_steps).slice(0, 3)
            ),
            non_matching_points: safeList(
                parsed.fit_analysis?.non_matching_points,
                safeList(parsed.advice?.budget_notes).slice(0, 3)
            )
        },
        improvement_actions: safeList(
            parsed.improvement_actions,
            safeList(parsed.advice?.evaluation_plan, ["実行スケジュールと評価基準を明記し、段階的に検証してください。"])
        ),
        citations: Array.isArray(parsed.citations)
            ? parsed.citations.map((item) => ({
                source_id: safeText(item.source_id, ""),
                municipality: safeText(item.municipality, "不明"),
                year: typeof item.year === "number" ? item.year : null,
                quote: safeText(item.quote, ""),
                used_for: safeText(item.used_for, "参考根拠")
            }))
            : similarItems.slice(0, 3).map((item) => ({
                source_id: item.id,
                municipality: "不明",
                year: null,
                quote: item.evidenceText.slice(0, 120),
                used_for: "参考根拠"
            }))
    };
    response.advice = {
        kpi_suggestions: response.fit_analysis.good_points,
        risks: response.fit_analysis.weak_points,
        implementation_steps: response.fit_analysis.matching_points,
        budget_notes: response.fit_analysis.non_matching_points,
        evaluation_plan: response.improvement_actions
    };
    return response;
};

const buildFallbackReviewResponse = (
    proposalDraft: ProposalDraft,
    similarItems: ProposalReviewItem[],
    raw: string
): ProposalReviewResponse => {
    const normalize = (text: string): string =>
        text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
    const tokenize = (text: string): string[] => {
        const stopwords = new Set([
            "する", "した", "して", "ある", "いる", "ため", "こと", "もの", "これ", "それ", "また",
            "及び", "など", "です", "ます", "から", "まで", "よう", "with", "from", "this", "that"
        ]);
        return normalize(text)
            .split(/\s+/)
            .filter((token) => token.length >= 2 && !stopwords.has(token))
            .slice(0, 120);
    };
    const unique = (list: string[]): string[] => Array.from(new Set(list.filter((item) => item.trim().length > 0)));

    const normalizedLines = raw
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .map((line) => line.replace(/^[-*]\s*/, ""))
        .map((line) => line.replace(/^#+\s*/, ""))
        .filter((line) => line.length > 0);
    const isTruncated = raw.trim().endsWith("##") || raw.trim().endsWith("#");

    const proposalText = [
        proposalDraft.title,
        proposalDraft.purpose,
        proposalDraft.target,
        proposalDraft.content,
        proposalDraft.kpi,
        proposalDraft.budget,
        proposalDraft.period,
        proposalDraft.evidence
    ].join(" ");
    const proposalTokens = unique(tokenize(proposalText)).slice(0, 40);

    const evidenceByItem = similarItems.map((item) => {
        const tokens = unique(tokenize(item.evidenceText));
        const overlap = tokens.filter((token) => proposalTokens.includes(token));
        return {
            id: item.id,
            text: item.evidenceText,
            tokens,
            overlap,
            overlapScore: overlap.length
        };
    });
    evidenceByItem.sort((a, b) => b.overlapScore - a.overlapScore);
    const strongMatches = evidenceByItem.slice(0, 3);
    const weakMatches = evidenceByItem.slice(-3).reverse();

    const fieldCandidates: Array<{ key: keyof ProposalDraft; label: string }> = [
        { key: "purpose", label: "目的" },
        { key: "target", label: "対象" },
        { key: "content", label: "施策内容" },
        { key: "kpi", label: "KPI" },
        { key: "budget", label: "予算" },
        { key: "period", label: "期間" },
        { key: "evidence", label: "根拠" }
    ];

    const missingFields = fieldCandidates.filter((field) => {
        const value = proposalDraft[field.key].trim();
        return value.length < 6 || value.includes("未定");
    });

    const matchingPoints = unique(
        strongMatches
            .filter((item) => item.overlapScore > 0)
            .map((item) => {
                const keys = item.overlap.slice(0, 4).join("・");
                return `根拠施策(${item.id})と「${keys || "主要テーマ"}」が一致しています。`;
            })
    );
    const nonMatchingPoints = unique([
        ...weakMatches.map((item) => `根拠施策(${item.id})は文脈一致が弱く、直接比較には追加根拠が必要です。`),
        ...missingFields.slice(0, 2).map((item) => `${item.label}が未定または不足のため、類似施策との厳密比較ができていません。`)
    ]);
    const goodPoints = unique([
        proposalDraft.title.trim().length > 3 ? "企画タイトルがテーマを明示しており、方針の軸が見えます。" : "",
        proposalTokens.length >= 8 ? "企画書内のキーワード量が一定あり、比較分析の入力として成立しています。" : "",
        strongMatches.length > 0 ? `類似施策上位${strongMatches.length}件で重複キーワードが検出され、方向性の整合が確認できます。` : ""
    ]);
    const weakPoints = unique([
        ...missingFields.map((item) => `${item.label}の具体性が不足しています。`),
        proposalDraft.evidence.includes("未定") ? "根拠が未確定のため、採択時の説明責任が弱くなります。" : ""
    ]);

    const improvementActions = unique([
        "1週間以内: 目的・対象・実施範囲を1ページで定義し、関係部署レビューを完了する（成果物: 企画要件定義書）。",
        "2週間以内: 上位類似施策3件からKPI候補を抽出し、測定式と基準値を設定する（成果物: KPI設計表）。",
        "3週間以内: 予算を初期費用/運用費に分割して積算し、財源案を2パターン作成する（成果物: 予算試算表）。",
        "4週間以内: 実施工程を準備・試行・本実施・評価の4段階で作成し、責任者を割り当てる（成果物: 実行計画表）。",
        "月次: 進捗・成果・リスクを定例評価し、改善アクションを更新する（成果物: 月次モニタリング報告）。"
    ]);

    const summaryHead = normalizedLines.slice(0, 3).join(" ");
    const overallReview = [
        summaryHead ? `AI出力要約: ${summaryHead}` : "",
        `本企画は「${proposalDraft.title}」として方向性は妥当ですが、${missingFields.length > 0 ? missingFields.map((item) => item.label).join("・") : "根拠の具体化"}の補強が採択可否を左右します。`,
        `類似施策との照合では、上位一致要素として${matchingPoints.slice(0, 2).join(" / ") || "テーマ整合"}が確認できる一方、${nonMatchingPoints.slice(0, 2).join(" / ") || "比較粒度不足"}が課題です。`,
        "次段階では、KPI・予算・実施工程を数値と期限付きで確定し、根拠資料との対応表を用意することで提案の説得力を高められます。"
    ].filter((line) => line.length > 0).join(" ");

    const firstEvidence = similarItems[0]?.evidenceText?.trim() ?? "";
    const evidenceSummary = firstEvidence ? firstEvidence.slice(0, 180) : "類似施策の根拠テキストを参照してください。";
    const aiMemo =
        `${overallReview}\n\n[根拠サマリ]\n${evidenceSummary}` +
        (isTruncated ? "\n\n[注意]\nAIの出力が途中で終了した可能性があります。" : "");
    const revisedEvidence = `${proposalDraft.evidence}\n\n[AI補助メモ]\n${aiMemo}`;

    return {
        revised_proposal: {
            ...proposalDraft,
            evidence: revisedEvidence
        },
        diff: [
            {
                field: "evidence",
                before: proposalDraft.evidence,
                after: revisedEvidence
            }
        ],
        overall_review: overallReview,
        fit_analysis: {
            good_points: goodPoints.length > 0 ? goodPoints : ["企画の方向性自体は政策テーマとして妥当です。"],
            weak_points: weakPoints.length > 0 ? weakPoints : ["比較根拠の補強が必要です。"],
            matching_points: matchingPoints.length > 0 ? matchingPoints : ["上位類似施策との方向性は概ね一致しています。"],
            non_matching_points: nonMatchingPoints.length > 0 ? nonMatchingPoints : ["比較対象と目的の粒度差を追加確認してください。"]
        },
        improvement_actions: improvementActions,
        citations: similarItems.slice(0, 3).map((item) => ({
            source_id: item.id,
            municipality: "不明",
            year: null,
            quote: item.evidenceText.slice(0, 120),
            used_for: "参考根拠"
        }))
    };
};

app.post<{ Body: { municipalityCode: string } }>("/api/auth/login", async (request, reply) => {
  const { municipalityCode } = request.body;
  if (!municipalityCode) {
    return reply.code(400).send({ message: "municipalityCode is required" });
  }

  const trimmedCode = municipalityCode.trim();
  const normalizedCode = normalizeToCdArea(trimmedCode);
  const resolvedCode =
    municipalities[trimmedCode] ? trimmedCode : normalizedCode && municipalities[normalizedCode] ? normalizedCode : null;
  if (!resolvedCode) {
    return reply.code(401).send({ message: "Invalid municipality code" });
  }
  const user = resolvedCode ? municipalities[resolvedCode] : null;
  if (!user) {
    return reply.code(401).send({ message: "Invalid municipality code" });
  }
  const loginCode: string = resolvedCode;

  reply.setCookie("municipalityCode", loginCode, sessionCookieOptions);
  return { municipality: { code: loginCode, name: user.name } };
});

app.post("/api/auth/logout", async (_request, reply) => {
  reply.clearCookie("municipalityCode", { path: "/" });
  return { success: true };
});

app.post<{ Body: ProposalSimilarRequest }>("/api/proposals/similar", async (request, reply) => {
    const municipality = requireSession(request, reply);
    if (!municipality) return;

    const body = request.body as ProposalSimilarRequest | undefined;
    if (!body || !validateProposalDraft(body.proposalDraft)) {
        return reply.code(400).send({
            error: {
                code: "INVALID_INPUT",
                message: "企画書の入力が不正です。",
            },
        });
    }

    const topK = Math.min(Math.max(Number(body.topK ?? 5), 1), 50);
    const normalizedDraft = normalizeProposalDraft(body.proposalDraft);
    const draftText = proposalDraftToText(normalizedDraft);
    const baseCode = body.municipalityCode?.trim() || municipality.code;

    const similarCitiesFromSimilarity = await buildSimilarCitiesFromSimilarity(baseCode, draftText);
    const similarCities = similarCitiesFromSimilarity ?? buildFallbackSimilarCities(baseCode, draftText, Object.keys(municipalities).length);
    const cityCandidateCount = Math.min(similarCities.length, Math.max(topK * 5, 20));
    const topCities = similarCities.slice(0, cityCandidateCount);
    const topCityCodes = new Set(topCities.map((city) => normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode));
    const filteredPolicies = policies.filter((policy) => {
        const code = normalizeToCdArea(policy.municipalityCode) ?? policy.municipalityCode;
        return topCityCodes.has(code);
    });
    if (topCities.length === 0 || filteredPolicies.length === 0) {
        app.log.warn(
            {
                baseCode,
                topCities: topCities.length,
                policiesTotal: policies.length,
                filteredPolicies: filteredPolicies.length
            },
            "No matching policies for similar cities."
        );
    }
    const policiesForSimilar = filteredPolicies.length > 0 ? filteredPolicies : policies;
    const notice =
        filteredPolicies.length > 0
            ? null
            : "類似自治体の施策が見つからないため、全自治体から候補を抽出しました。";

    const cityScoreByCode = new Map(
        similarCities.map((city) => [normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode, city.score])
    );
    const CITY_WEIGHT = 0.6;
    const TEXT_WEIGHT = 0.4;

    const similarItems: ProposalSimilarItem[] = policiesForSimilar
        .map((policy) => {
            const policyCode = normalizeToCdArea(policy.municipalityCode) ?? policy.municipalityCode;
            const cityScore = normalizeCitySimilarity(cityScoreByCode.get(policyCode) ?? 0);
            const policyText = `${policy.title} ${policy.summary} ${policy.details} ${(policy.keywords ?? []).join(" ")}`.trim();
            const textScore = calcTextSimilarity(draftText, policyText);
            const combinedScore = cityScore * CITY_WEIGHT + textScore * TEXT_WEIGHT;
            return {
                id: policy.id,
                score: combinedScore,
                municipality: policy.municipalityName,
                year: null,
                title: policy.title,
                summary: policy.summary,
                evidenceSnippets: [extractEvidenceSnippet(policy, draftText)]
            };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, topK);

    return { similarItems, notice };
});

app.post<{ Body: ProposalReviewRequest }>("/api/proposals/review", async (request, reply) => {
    const municipality = requireSession(request, reply);
    if (!municipality) return;

    const body = request.body as ProposalReviewRequest | undefined;
    if (!body || !validateProposalDraft(body.proposalDraft) || !validateReviewItems(body.similarItems)) {
        return reply.code(400).send({
            error: {
                code: "INVALID_INPUT",
                message: "企画書または根拠の入力が不正です。",
            },
        });
    }

    const style = body.style ?? "gentle";
    const length = body.length ?? "medium";
    const prompt = buildReviewPrompt(body.proposalDraft, body.similarItems, style, length);

    try {
        const raw = await callGemini(prompt);
        try {
            const parsed = parseReviewJson(raw);
            return normalizeReviewResponse(parsed, body.proposalDraft, body.similarItems);
        } catch (parseError) {
            app.log.warn(
                {
                    err: parseError,
                    rawPreview: raw.slice(0, 1200)
                },
                "Gemini response was not valid JSON. Fallback response generated."
            );
            const fallback = buildFallbackReviewResponse(body.proposalDraft, body.similarItems, raw);
            return normalizeReviewResponse(fallback, body.proposalDraft, body.similarItems);
        }
    } catch (error) {
        app.log.error({ err: error }, "Gemini review failed.");
        const message = error instanceof Error ? error.message : "REVIEW_FAILED";
        const code =
            message === "GEMINI_API_KEY_MISSING"
                ? "MISSING_API_KEY"
                : message === "GEMINI_INVALID_JSON"
                    ? "INVALID_JSON"
                    : message.startsWith("GEMINI_RATE_LIMIT")
                        ? "RATE_LIMIT"
                    : message.startsWith("GEMINI_API_FAILED")
                        ? "GEMINI_API_FAILED"
                        : "REVIEW_FAILED";
        const userMessage =
            code === "MISSING_API_KEY"
                ? "Gemini APIキーが設定されていません。"
                : code === "INVALID_JSON"
                    ? "Geminiの応答が不正な形式でした。"
                    : code === "RATE_LIMIT"
                        ? "Gemini APIの利用上限に達しました。時間をおいて再実行するか、プラン/課金設定を確認してください。"
                    : code === "GEMINI_API_FAILED"
                        ? `Gemini APIの呼び出しに失敗しました。${message}`
                        : "添削/アドバイスの生成に失敗しました。";
        return reply.code(500).send({ error: { code, message: userMessage } });
    }
});

app.post<{ Body: ProposalPdfRequest }>("/api/proposals/pdf", async (request, reply) => {
  const municipality = requireSession(request, reply);
  if (!municipality) return;

  const title = (request.body?.title ?? "").trim() || "企画書";
  const sections = Array.isArray(request.body?.sections) ? request.body.sections : [];

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const pageSize: [number, number] = [595.28, 841.89]; // A4
  let page = pdfDoc.addPage(pageSize);
  const [pageWidth, pageHeight] = pageSize;

  const fontPathFromEnv = process.env.PROPOSAL_PDF_FONT_PATH?.trim();
  const fontPathCandidates = [
    fontPathFromEnv,
    resolve(rootDir, "data/fonts/NotoSansJP-Regular.ttf"),
    resolve(rootDir, "data/fonts/NotoSansJP-Regular.otf"),
    resolve(rootDir, "data/fonts/Meiryo.ttc")
  ].filter((value): value is string => Boolean(value));
  const fontPath = fontPathCandidates.find((candidate) => existsSync(candidate));
  if (!fontPath) {
    return reply.code(500).send({
      message:
        "日本語フォントの読み込みに失敗しました。data/fonts/NotoSansJP-Regular.ttf を配置してください。",
    });
  }
  if (fontPath.toLowerCase().endsWith(".ttc")) {
    return reply.code(500).send({
      message:
        "TTC形式のフォントは利用できません。TTF/OTFの日本語フォントを指定してください。",
    });
  }

  let fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  let fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  try {
    const fontBytes = readFileSync(fontPath);
    fontRegular = await pdfDoc.embedFont(fontBytes);
    fontBold = await pdfDoc.embedFont(fontBytes);
  } catch (error) {
    app.log.error({ err: error, fontPath }, "Failed to load custom font.");
    return reply.code(500).send({
      message:
        "日本語フォントの読み込みに失敗しました。フォントファイルを確認してください。",
    });
  }

  const margin = 48;
  let cursorY = pageHeight - margin;

  const ensureSpace = (lineHeight: number) => {
    if (cursorY - lineHeight < margin) {
      page = pdfDoc.addPage(pageSize);
      cursorY = pageHeight - margin;
    }
  };

  const drawLine = (text: string, fontSize: number, font = fontRegular, color = rgb(0, 0, 0)) => {
    ensureSpace(fontSize * 1.4);
    page.drawText(text, {
      x: margin,
      y: cursorY,
      size: fontSize,
      font,
      color
    });
    cursorY -= fontSize * 1.4;
  };

  const wrapText = (text: string, fontSize: number, maxWidth: number, font = fontRegular) => {
    const lines: string[] = [];
    const paragraphs = text.split(/\r?\n/);
    for (const para of paragraphs) {
      if (!para.trim()) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const char of Array.from(para)) {
        const testLine = line + char;
        if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth && line) {
          lines.push(line);
          line = char;
        } else {
          line = testLine;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  };

  drawLine(title, 20, fontBold);
  drawLine(`菴懈・閾ｪ豐ｻ菴・ ${municipality.name} (${municipality.code})`, 10, fontRegular, rgb(0.35, 0.35, 0.35));
  drawLine(`作成日: ${new Date().toISOString().slice(0, 10)}`, 10, fontRegular, rgb(0.35, 0.35, 0.35));
  cursorY -= 6;

  const contentWidth = pageWidth - margin * 2;
  for (const section of sections) {
    const label = (section.label ?? "").trim();
    const value = (section.value ?? "").trim();
    if (!label || !value) continue;
    drawLine(label, 13, fontBold);
    const lines = wrapText(value, 11, contentWidth, fontRegular);
    for (const line of lines) {
      drawLine(line, 11, fontRegular);
    }
    cursorY -= 4;
  }

  const pdfBytes = await pdfDoc.save();
  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", "attachment; filename=\"proposal.pdf\"");
  return reply.send(Buffer.from(pdfBytes));
});

app.post<{
  Body: {
    inputPdfPath: string;
    outDir?: string;
    policiesOutPath?: string;
    municipalityCode?: string;
    municipalityName?: string;
    idPrefix: string;
    mergeToPoliciesJson?: boolean;
  };
}>("/api/admin/import-pdf", async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) return;

  const {
    inputPdfPath,
    outDir,
    policiesOutPath,
    municipalityCode,
    municipalityName,
    idPrefix,
    mergeToPoliciesJson
  } = request.body;

  if (!inputPdfPath || !idPrefix) {
    return reply.code(400).send({ message: "inputPdfPath and idPrefix are required" });
  }

  const targetCode = municipalityCode ?? session.code;
  const targetName =
    municipalityName ??
    municipalityMasterByCode[targetCode]?.municipalityDisplayName ??
    municipalities[targetCode]?.name ??
    session.name;

  const safeDirCode = targetCode.replace(/[^\dA-Za-z_-]/g, "");
  const defaultOutDir = `data/policies-pdf/${safeDirCode || "imported"}`;
  const defaultPoliciesOutPath = `data/policies.${safeDirCode || "imported"}.json`;

  try {
    const result = await importPoliciesFromPdf({
      rootDir,
      inputPdfPath,
      outDir: outDir ?? defaultOutDir,
      policiesOutPath: policiesOutPath ?? defaultPoliciesOutPath,
      municipalityCode: targetCode,
      municipalityName: targetName,
      idPrefix,
      mergeToPoliciesJson
    });
    return { success: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return reply.code(400).send({ message });
  }
});

app.post("/api/admin/import-pdf/upload/preview", async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) return;

  cleanupOldPendingImports();

  let uploadedBuffer: Buffer | null = null;
  let uploadedFileName = "uploaded.pdf";
  const fields: Record<string, string> = {};

  for await (const part of request.parts()) {
    if (part.type === "file") {
      uploadedFileName = part.filename || uploadedFileName;
      uploadedBuffer = await part.toBuffer();
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }

  if (!uploadedBuffer) {
    return reply.code(400).send({ message: "PDF file is required" });
  }

  const idPrefix = (fields.idPrefix ?? "").trim();
  if (!idPrefix) {
    return reply.code(400).send({ message: "idPrefix is required" });
  }

  const targetCode = (fields.municipalityCode ?? "").trim() || session.code;
  const targetName =
    (fields.municipalityName ?? "").trim() ||
    municipalityMasterByCode[targetCode]?.municipalityDisplayName ||
    municipalities[targetCode]?.name ||
    session.name;

  const safeDirCode = targetCode.replace(/[^\dA-Za-z_-]/g, "");
  const outDir = (fields.outDir ?? "").trim() || `data/policies-pdf/${safeDirCode || "imported"}`;
  const policiesOutPath = (fields.policiesOutPath ?? "").trim() || `data/policies.${safeDirCode || "imported"}.json`;
  const mergeToPoliciesJson = (fields.mergeToPoliciesJson ?? "true").toLowerCase() !== "false";

  mkdirSync(uploadTempDir, { recursive: true });
  const safeBase = uploadedFileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const tempFileName = `${Date.now()}-${safeBase}`;
  const tempAbsPath = resolve(uploadTempDir, tempFileName);
  const tempRelativePath = `data/uploads/${tempFileName}`;
  writeFileSync(tempAbsPath, uploadedBuffer);

  try {
    const preview = await importPoliciesFromPdf({
      rootDir,
      inputPdfPath: tempRelativePath,
      outDir,
      policiesOutPath,
      municipalityCode: targetCode,
      municipalityName: targetName,
      idPrefix,
      mergeToPoliciesJson,
      dryRun: true
    });

    const token = randomUUID();
    pendingImports.set(token, {
      tempAbsPath,
      tempRelativePath,
      municipalityCode: targetCode,
      municipalityName: targetName,
      idPrefix,
      outDir,
      policiesOutPath,
      mergeToPoliciesJson,
      createdAt: Date.now()
    });

    return {
      success: true,
      token,
      preview
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    try {
      if (existsSync(tempAbsPath)) unlinkSync(tempAbsPath);
    } catch {
      // no-op
    }
    return reply.code(400).send({ message });
  }
});

app.post<{ Body: { token: string; selectedIds?: string[] } }>("/api/admin/import-pdf/upload/confirm", async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) return;

  cleanupOldPendingImports();
  const token = (request.body.token ?? "").trim();
  const selectedIds = Array.isArray(request.body.selectedIds)
    ? request.body.selectedIds.map((v) => String(v)).filter((v) => v.length > 0)
    : undefined;
  if (!token) {
    return reply.code(400).send({ message: "token is required" });
  }

  const pending = pendingImports.get(token);
  if (!pending) {
    return reply.code(404).send({ message: "Preview token not found or expired" });
  }

  try {
    const result = await importPoliciesFromPdf({
      rootDir,
      inputPdfPath: pending.tempRelativePath,
      outDir: pending.outDir,
      policiesOutPath: pending.policiesOutPath,
      municipalityCode: pending.municipalityCode,
      municipalityName: pending.municipalityName,
      idPrefix: pending.idPrefix,
      mergeToPoliciesJson: pending.mergeToPoliciesJson,
      selectedIds
    });
    const latestRaw = readJsonWithFallback<RawPolicy[]>("policies.json", "policies.sample.json");
    policies = latestRaw.map(toPolicy);
    return { success: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return reply.code(400).send({ message });
  } finally {
    pendingImports.delete(token);
    try {
      if (existsSync(pending.tempAbsPath)) unlinkSync(pending.tempAbsPath);
    } catch {
      // no-op
    }
  }
});

app.post<{ Body: { policyIds: string[] } }>("/api/admin/policies/delete", async (request, reply) => {
  const session = requireSession(request, reply);
  if (!session) return;

  const ids = Array.isArray(request.body.policyIds)
    ? request.body.policyIds.map((v) => String(v)).filter((v) => v.length > 0)
    : [];
  if (ids.length === 0) {
    return reply.code(400).send({ message: "policyIds is required" });
  }

  const policiesPath = resolve(dataDir, "policies.json");
  const currentRaw = readJsonWithFallback<RawPolicy[]>("policies.json", "policies.sample.json");
  const idSet = new Set(ids);
  const toDelete = currentRaw.filter((p) => idSet.has(p.id));
  const kept = currentRaw.filter((p) => !idSet.has(p.id));

  toDelete.forEach((item) => {
    const normalized = normalizePdfPath(item.pdfPath);
    if (!normalized) return;
    const abs = resolve(policiesPdfDir, normalized);
    if (existsSync(abs)) {
      try {
        unlinkSync(abs);
      } catch {
        // no-op
      }
    }
  });

  writeFileSync(policiesPath, `${JSON.stringify(kept, null, 2)}\n`, "utf-8");
  policies = kept.map(toPolicy);
  return { success: true, deletedCount: toDelete.length };
});

app.get("/api/me", async (request, reply) => {
  const municipality = requireSession(request, reply);
  if (!municipality) return;
  return { municipality };
});

app.get<{ Querystring: { query?: string; limit?: string } }>("/api/municipalities", async (request) => {
  const query = (request.query.query ?? "").trim().toLowerCase();
  const limitRaw = Number(request.query.limit ?? "20");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 20;

  const rows = Object.entries(municipalities)
    .map(([code, value]) => {
      const master = municipalityMasterByCode[code];
      return {
        code,
        name: value.name,
        prefecture: master?.prefecture ?? "",
        displayName: master?.municipalityDisplayName ?? value.name
      };
    })
    .filter((item) => {
      if (!query) return true;
      return (
        item.code.toLowerCase().includes(query) ||
        item.name.toLowerCase().includes(query) ||
        item.displayName.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => a.code.localeCompare(b.code))
    .slice(0, limit);

  return { municipalities: rows };
});

app.get<{ Querystring: { keyword?: string } }>("/api/search", async (request, reply) => {
  const municipality = requireSession(request, reply);
  if (!municipality) return;

  const rawKeyword = (request.query.keyword ?? "").trim();
  const keyword = rawKeyword.toLowerCase();
  const similarCitiesFromSimilarity = await buildSimilarCitiesFromSimilarity(municipality.code, rawKeyword);
  const similarCities = similarCitiesFromSimilarity ?? buildFallbackSimilarCities(municipality.code, rawKeyword, Object.keys(municipalities).length);
  const top5Cities = similarCities.slice(0, 5);
  const worstCities = similarCities.length > 20 ? [...similarCities].slice(-20).reverse() : [...similarCities].reverse();
  const similarityScoreByCode = new Map(
    similarCities.map((city) => [normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode, city.score])
  );

  const keywordMatched = policies.filter((policy) => {
    if (!keyword) return true;
    const haystack = `${policy.title} ${policy.summary} ${policy.details} ${policy.keywords.join(" ")}`.toLowerCase();
    return haystack.includes(keyword);
  });

  // Return all municipalities' policies (or all keyword matches), then sort by similarity score.
  const policiesToReturn = keywordMatched;

  // Sort policies by similarity score (desc), then municipality code, then id.
  const sortedPolicies = [...policiesToReturn].sort((a, b) => {
    const aCode = normalizeToCdArea(a.municipalityCode) ?? a.municipalityCode;
    const bCode = normalizeToCdArea(b.municipalityCode) ?? b.municipalityCode;
    const aScore = similarityScoreByCode.get(aCode) ?? -1;
    const bScore = similarityScoreByCode.get(bCode) ?? -1;
    if (aScore !== bScore) return bScore - aScore;
    if (aCode !== bCode) return aCode.localeCompare(bCode);
    return a.id.localeCompare(b.id);
  });

  return {
    top5Cities,
    similarCities: similarCities.slice(0, 20),
    worstCities,
    policies: sortedPolicies
  };
});

app.get<{ Params: { policyId: string } }>("/api/policies/:policyId", async (request, reply) => {
  const municipality = requireSession(request, reply);
  if (!municipality) return;

  const policy = policies.find((item) => item.id === request.params.policyId);
  if (!policy) {
    return reply.code(404).send({ message: "Policy not found" });
  }

  return { policy };
});

app.get("/api/health", async () => ({ status: "ok" }));

const start = async () => {
  try {
    await app.listen({ port: 4000, host: "0.0.0.0" });
    app.log.info({ similarityApiBaseUrl }, "Similarity API base URL");
    if (!existsSync(policiesPdfDir)) {
      app.log.warn({ path: policiesPdfDir }, "PDF directory not found. Create data/policies-pdf to serve split PDFs.");
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();

