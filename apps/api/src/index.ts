import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SimilarityClient, type SimilarityRequest } from "./lib/similarity-client";
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

type ProposalCsvConceptKey =
  | "proposal_id"
  | "municipality_code"
  | "title"
  | "issue"
  | "target"
  | "solution"
  | "kpi"
  | "budget"
  | "period"
  | "premise";

type ProposalCsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

type ProposalCsvReviewRow = {
  proposalId: string;
  municipalityCode: string;
  section: string;
  importance: "高" | "中" | "低";
  issue: string;
  suggestion: string;
  evidence: string;
  classification: "強み" | "弱み";
  alternative: string;
  overall: string;
};

type ProposalCsvGeminiFinding = {
  section: string;
  importance: "高" | "中" | "低";
  issue: string;
  suggestion: string;
  classification: "強み" | "弱み";
  alternative: string;
};

type ProposalCsvGeminiResponse = {
  overall: string;
  findings: ProposalCsvGeminiFinding[];
};

type ProposalCsvGeminiBatchItem = {
  proposal_id: string;
  overall?: string;
  findings?: ProposalCsvGeminiFinding[];
};

type ProposalCsvGeminiBatchResponse = {
  results: ProposalCsvGeminiBatchItem[];
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

const listPolicyJsonFiles = (): string[] => {
  const allNames = readdirSync(dataDir)
    .filter((name) => /^policies(?:\.[^.]+)*\.json$/i.test(name));
  const primary = allNames
    .filter((name) => name !== "policies.sample.json")
    .sort((a, b) => {
      if (a === "policies.json") return -1;
      if (b === "policies.json") return 1;
      return a.localeCompare(b);
    });
  if (primary.length > 0) {
    return primary;
  }
  return allNames.includes("policies.sample.json") ? ["policies.sample.json"] : [];
};

const readAllPolicies = (): RawPolicy[] => {
  const files = listPolicyJsonFiles();
  const byId = new Map<string, RawPolicy>();
  const hasExistingPdf = (pdfPath?: string): boolean => {
    if (!pdfPath) return false;
    const normalized = String(pdfPath)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^data\//, "")
      .replace(/^policies-pdf\//, "");
    return existsSync(resolve(policiesPdfDir, normalized));
  };
  for (const fileName of files) {
    const abs = resolve(dataDir, fileName);
    try {
      const parsed = JSON.parse(readFileSync(abs, "utf-8")) as RawPolicy[];
      for (const item of parsed) {
        if (!item?.id) continue;
        const current = byId.get(item.id);
        if (!current) {
          byId.set(item.id, item);
          continue;
        }
        const currentHasPdf = hasExistingPdf(current.pdfPath);
        const nextHasPdf = hasExistingPdf(item.pdfPath);
        // Prefer the record whose pdfPath points to an existing file.
        if (!currentHasPdf && nextHasPdf) {
          byId.set(item.id, item);
        }
      }
    } catch (error) {
      // Keep the service available even if one JSON is malformed/encoded unexpectedly.
      console.warn(`[policies] failed to load ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Array.from(byId.values());
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

const normalizeHeader = (value: string): string =>
  stripBom(value).toLowerCase().replace(/[\s_\-　]/g, "");

const PROPOSAL_CSV_HEADER_HINTS: Record<ProposalCsvConceptKey, string[]> = {
  proposal_id: ["proposalid", "企画id", "企画識別子", "id"],
  municipality_code: ["municipalitycode", "自治体コード", "自治体cd", "cd_area", "cdarea"],
  title: ["title", "タイトル", "事業名", "施策名"],
  issue: ["issue", "課題", "現状課題", "背景"],
  target: ["target", "対象", "対象者", "対象範囲", "scope"],
  solution: ["solution", "解決策", "施策内容", "内容", "approach"],
  kpi: ["kpi", "指標", "成果指標", "効果"],
  budget: ["budget", "予算", "費用"],
  period: ["period", "期間", "スケジュール", "実施期間"],
  premise: ["premise", "前提", "根拠", "前提条件", "notes"]
};

const parseCsvText = (csvText: string): { headers: string[]; rows: ProposalCsvRow[] } => {
  const lines = csvText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]).map((h) => stripBom(h).trim());
  const rows: ProposalCsvRow[] = lines.slice(1).map((line, idx) => {
    const cols = parseCsvLine(line);
    const values: Record<string, string> = {};
    headers.forEach((header, colIdx) => {
      values[header] = (cols[colIdx] ?? "").trim();
    });
    return { rowNumber: idx + 2, values };
  });

  return { headers, rows };
};

const inferProposalCsvMapping = (headers: string[]): Partial<Record<ProposalCsvConceptKey, string>> => {
  const normalizedHeaders = headers.map((h) => ({ raw: h, normalized: normalizeHeader(h) }));
  const result: Partial<Record<ProposalCsvConceptKey, string>> = {};

  (Object.keys(PROPOSAL_CSV_HEADER_HINTS) as ProposalCsvConceptKey[]).forEach((key) => {
    const hints = PROPOSAL_CSV_HEADER_HINTS[key];
    const matched = normalizedHeaders.find((header) =>
      hints.some((hint) => header.normalized.includes(normalizeHeader(hint)))
    );
    if (matched) {
      result[key] = matched.raw;
    }
  });

  return result;
};

const csvEscape = (value: string): string => {
  const escaped = value.replace(/"/g, "\"\"");
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

const buildCsvOutput = (
  headers: string[],
  rows: Array<Record<string, string>>
): string => {
  const lines = [headers.map(csvEscape).join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => csvEscape(row[header] ?? "")).join(","));
  });
  return `${lines.join("\r\n")}\r\n`;
};

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
  return replaced
    .replace(/^data\//, "")
    .replace(/^policies-pdf\//, "");
};

const resolveExistingPdfPath = (pdfPath?: string): string | undefined => {
  const normalized = normalizePdfPath(pdfPath);
  if (!normalized) return undefined;
  const absPath = resolve(policiesPdfDir, normalized);
  if (!existsSync(absPath)) {
    return undefined;
  }
  return normalized;
};

const toPdfUrl = (pdfPath?: string): string | undefined => {
  const normalized = resolveExistingPdfPath(pdfPath);
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
  pdfPath: resolveExistingPdfPath(item.pdfPath),
  pdfUrl: toPdfUrl(item.pdfPath)
});

const rawPolicies = readAllPolicies();
let policies: Policy[] = rawPolicies.map(toPolicy);

const refreshPoliciesCache = (): void => {
  const latestRaw = readAllPolicies();
  policies = latestRaw.map(toPolicy);
};

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

const buildDraftFromCsvRow = (
  row: ProposalCsvRow,
  mapping: Partial<Record<ProposalCsvConceptKey, string>>
): ProposalDraft => ({
  title: (mapping.title ? row.values[mapping.title] : "").trim(),
  purpose: (mapping.issue ? row.values[mapping.issue] : "").trim(),
  target: (mapping.target ? row.values[mapping.target] : "").trim(),
  content: (mapping.solution ? row.values[mapping.solution] : "").trim(),
  kpi: (mapping.kpi ? row.values[mapping.kpi] : "").trim(),
  budget: (mapping.budget ? row.values[mapping.budget] : "").trim(),
  period: (mapping.period ? row.values[mapping.period] : "").trim(),
  evidence: (mapping.premise ? row.values[mapping.premise] : "").trim()
});

const getRowValue = (
  row: ProposalCsvRow,
  mapping: Partial<Record<ProposalCsvConceptKey, string>>,
  key: ProposalCsvConceptKey
): string => {
  const header = mapping[key];
  return header ? (row.values[header] ?? "").trim() : "";
};

const listMissingConcepts = (
  draft: ProposalDraft,
  mapping: Partial<Record<ProposalCsvConceptKey, string>>
): ProposalCsvConceptKey[] => {
  const missing: ProposalCsvConceptKey[] = [];
  if (!mapping.proposal_id) missing.push("proposal_id");
  if (!mapping.municipality_code) missing.push("municipality_code");
  if (!draft.title) missing.push("title");
  if (!draft.purpose) missing.push("issue");
  if (!draft.target) missing.push("target");
  if (!draft.content) missing.push("solution");
  if (!draft.kpi) missing.push("kpi");
  if (!draft.budget) missing.push("budget");
  if (!draft.period) missing.push("period");
  if (!draft.evidence) missing.push("premise");
  return missing;
};

const conceptLabel: Record<ProposalCsvConceptKey, string> = {
  proposal_id: "企画識別子",
  municipality_code: "自治体コード",
  title: "タイトル",
  issue: "課題",
  target: "対象",
  solution: "解決策",
  kpi: "KPI",
  budget: "予算",
  period: "期間",
  premise: "前提"
};

const parseLooseJson = (raw: string): unknown => {
  const trimmed = raw.trim();
  const normalized = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(normalized.slice(start, end + 1));
    }
    throw new Error("GEMINI_INVALID_JSON");
  }
};

const normalizeCsvGeminiResponse = (
  value: unknown,
  fallbackOverall: string
): ProposalCsvGeminiResponse => {
  const parsed = (value ?? {}) as Partial<ProposalCsvGeminiResponse>;
  const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: ProposalCsvGeminiFinding[] = findingsRaw
    .filter((item): item is ProposalCsvGeminiFinding => Boolean(item && typeof item === "object"))
    .map((item) => {
      const importance = item.importance === "高" || item.importance === "中" || item.importance === "低" ? item.importance : "中";
      const classification = item.classification === "強み" || item.classification === "弱み" ? item.classification : "弱み";
      return {
        section: String(item.section ?? "総評"),
        importance,
        issue: String(item.issue ?? ""),
        suggestion: String(item.suggestion ?? ""),
        classification,
        alternative: String(item.alternative ?? "")
      };
    })
    .filter((item) => item.issue.trim().length > 0 || item.suggestion.trim().length > 0);

  const overall = typeof parsed.overall === "string" && parsed.overall.trim().length > 0 ? parsed.overall : fallbackOverall;
  return { overall, findings };
};

const normalizeCsvGeminiBatchResponse = (
  value: unknown,
  fallbackByProposalId: Map<string, string>
): Map<string, ProposalCsvGeminiResponse> => {
  const parsed = (value ?? {}) as Partial<ProposalCsvGeminiBatchResponse>;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const adviceByProposalId = new Map<string, ProposalCsvGeminiResponse>();
  for (const item of results) {
    const proposalId = typeof item?.proposal_id === "string" ? item.proposal_id.trim() : "";
    if (!proposalId) continue;
    const fallbackOverall = fallbackByProposalId.get(proposalId) ?? "総評: 類似政策を根拠に改善可能です。";
    const normalized = normalizeCsvGeminiResponse(
      { overall: item.overall, findings: item.findings },
      fallbackOverall
    );
    adviceByProposalId.set(proposalId, normalized);
  }
  return adviceByProposalId;
};

const truncateText = (value: string, limit: number): string => {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

const isGeminiRateLimitError = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    return error.message.startsWith("GEMINI_RATE_LIMIT:429:");
};

const formatGeminiDisabledReason = (error: unknown): string => {
    if (!(error instanceof Error)) return "Geminiが利用できないため、ルールベースで添削しました。";
    if (error.message.startsWith("GEMINI_RATE_LIMIT:429:")) {
        const retryAfter = error.message.replace("GEMINI_RATE_LIMIT:429:", "").trim();
        if (retryAfter.length > 0) {
            return `Gemini利用上限のため、ルールベースで添削しました（再試行目安: ${retryAfter} 秒後）。`;
        }
        return "Gemini利用上限のため、ルールベースで添削しました。";
    }
    if (error.message === "GEMINI_API_KEY_MISSING") {
        return "Gemini APIキー未設定のため、ルールベースで添削しました。";
    }
    return "Geminiが利用できないため、ルールベースで添削しました。";
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
                // Retry only when endpoint/model is likely missing.
                // For 429, stop immediately to avoid per-row retry storms.
                if (response.status === 429) {
                    throw new Error(lastErrorCode);
                }
                if (response.status === 404) {
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

app.post("/api/proposals/review-csv", async (request, reply) => {
  refreshPoliciesCache();
  const municipality = requireSession(request, reply);
  if (!municipality) return;

  const file = await request.file();
  if (!file) {
    return reply.code(400).send({
      error: { code: "INVALID_INPUT", message: "CSVファイルを添付してください。" }
    });
  }

  const filename = (file.filename ?? "").toLowerCase();
  if (filename && !filename.endsWith(".csv")) {
    return reply.code(400).send({
      error: { code: "INVALID_INPUT", message: "CSVファイルのみアップロード可能です。" }
    });
  }

  const csvText = (await file.toBuffer()).toString("utf-8");
  const { headers, rows } = parseCsvText(csvText);
  if (headers.length === 0 || rows.length === 0) {
    return reply.code(400).send({
      error: { code: "INVALID_INPUT", message: "CSVのヘッダーまたはデータ行が見つかりません。" }
    });
  }

  const mapping = inferProposalCsvMapping(headers);
  const outputRows: ProposalCsvReviewRow[] = [];
  let geminiDisabledForRequest = false;
  let geminiDisabledReason = "";
  const rowContexts: Array<{
    proposalId: string;
    municipalityCode: string;
    draft: ProposalDraft;
    missing: ProposalCsvConceptKey[];
    scoredPolicies: Array<{ policy: Policy; combinedScore: number; textScore: number; cityScore: number }>;
    combinedEvidence: string;
    fallbackOverallBase: string;
    metricEvidence: string;
    policyEvidence: string;
  }> = [];

  for (const row of rows) {
    const draft = buildDraftFromCsvRow(row, mapping);
    const draftText = proposalDraftToText(draft);
    const proposalId = getRowValue(row, mapping, "proposal_id") || `row-${row.rowNumber - 1}`;
    const sourceCode = getRowValue(row, mapping, "municipality_code") || municipality.code;
    const municipalityCode = normalizeToCdArea(sourceCode) ?? municipality.code;

    const similarCitiesFromSimilarity = await buildSimilarCitiesFromSimilarity(municipalityCode, draftText);
    const similarCities = similarCitiesFromSimilarity ?? buildFallbackSimilarCities(municipalityCode, draftText, 50);
    const topCityCodes = new Set(
      similarCities
        .slice(0, 20)
        .map((city) => normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode)
    );
    const filteredPolicies = policies.filter((policy) => {
      const code = normalizeToCdArea(policy.municipalityCode) ?? policy.municipalityCode;
      return topCityCodes.has(code);
    });
    const candidatePolicies = filteredPolicies.length > 0 ? filteredPolicies : policies;
    const cityScoreByCode = new Map(
      similarCities.map((city) => [normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode, city.score])
    );

    const scoredPolicies = candidatePolicies
      .map((policy) => {
        const policyCode = normalizeToCdArea(policy.municipalityCode) ?? policy.municipalityCode;
        const cityScore = normalizeCitySimilarity(cityScoreByCode.get(policyCode) ?? 0);
        const policyText = `${policy.title} ${policy.summary} ${policy.details} ${(policy.keywords ?? []).join(" ")}`.trim();
        const textScore = calcTextSimilarity(draftText, policyText);
        const combinedScore = cityScore * 0.6 + textScore * 0.4;
        return { policy, combinedScore, textScore, cityScore };
      })
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, 3);

    let metricEvidence = "";
    try {
      const municipalData = await similarityClient.municipalityData(municipalityCode);
      const metricPairs = Object.entries(municipalData.indicators)
        .filter(([, value]) => Number.isFinite(value))
        .slice(0, 5)
        .map(([key, value]) => `${key}=${value}`);
      metricEvidence = metricPairs.join("; ");
    } catch {
      metricEvidence = "";
    }

    const policyEvidence = scoredPolicies.length
      ? scoredPolicies
          .map(
            (item) =>
              `${item.policy.id}:${item.policy.title}(score=${item.combinedScore.toFixed(3)}, text=${item.textScore.toFixed(3)}, city=${item.cityScore.toFixed(3)})`
          )
          .join(" | ")
      : "";
    const combinedEvidence = [metricEvidence ? `自治体指標:${metricEvidence}` : "", policyEvidence ? `類似政策:${policyEvidence}` : ""]
      .filter((v) => v.length > 0)
      .join(" / ");

    const missing = listMissingConcepts(draft, mapping);
    const fallbackOverallBase = `総評: 不足項目${missing.length}件。類似政策上位${scoredPolicies.length}件を根拠に改善可能です。`;
    rowContexts.push({
      proposalId,
      municipalityCode,
      draft,
      missing,
      scoredPolicies,
      combinedEvidence,
      fallbackOverallBase,
      metricEvidence,
      policyEvidence
    });
  }

  const fallbackByProposalId = new Map(rowContexts.map((ctx) => [ctx.proposalId, ctx.fallbackOverallBase]));
  const geminiAdviceByProposalId = new Map<string, ProposalCsvGeminiResponse>();

  if (!geminiDisabledForRequest) {
    const geminiRows = rowContexts.map((ctx) => ({
      proposal_id: ctx.proposalId,
      municipality_code: ctx.municipalityCode,
      draft: {
        title: truncateText(ctx.draft.title, 140),
        issue: truncateText(ctx.draft.purpose, 220),
        target: truncateText(ctx.draft.target, 140),
        solution: truncateText(ctx.draft.content, 260),
        kpi: truncateText(ctx.draft.kpi, 140),
        budget: truncateText(ctx.draft.budget, 120),
        period: truncateText(ctx.draft.period, 120),
        premise: truncateText(ctx.draft.evidence, 180)
      },
      missing_fields: ctx.missing.map((key) => conceptLabel[key]),
      top_policies: ctx.scoredPolicies.slice(0, 3).map((item) => ({
        id: item.policy.id,
        title: truncateText(item.policy.title, 120),
        score: Number(item.combinedScore.toFixed(3)),
        summary: truncateText(item.policy.summary, 180)
      })),
      indicators: truncateText(ctx.metricEvidence, 300)
    }));

    try {
      const geminiPrompt = [
        "あなたは自治体政策の添削官です。入力企画・類似政策・自治体指標のみを根拠に助言してください。",
        "入力は複数件です。各proposal_idごとに評価結果を返してください。",
        "類似自治体が過去に行った企画事業に似た事例をWebで検索し参考にせよ。",
        "根拠にない断定は禁止。JSONのみを返してください。",
        "",
        "## 入力データ(JSON)",
        JSON.stringify(geminiRows, null, 2),
        "",
        "## 出力JSON schema",
        '{ "results": [ { "proposal_id": "string", "overall": "string", "findings": [ { "section": "string", "importance": "高|中|低", "issue": "string", "suggestion": "string", "classification": "強み|弱み", "alternative": "string" } ] } ] }'
      ].join("\n");

      const raw = await callGemini(geminiPrompt);
      const parsed = normalizeCsvGeminiBatchResponse(parseLooseJson(raw), fallbackByProposalId);
      parsed.forEach((value, key) => {
        geminiAdviceByProposalId.set(key, value);
      });
    } catch (err) {
      if (isGeminiRateLimitError(err) || (err instanceof Error && err.message === "GEMINI_API_KEY_MISSING")) {
        geminiDisabledForRequest = true;
        geminiDisabledReason = formatGeminiDisabledReason(err);
      }
      app.log.warn({ err, geminiDisabledForRequest }, "Gemini CSV batch advice failed. Fallback rules will be used.");
    }
  }

  for (const ctx of rowContexts) {
    const fallbackReasonSuffix = geminiDisabledForRequest && geminiDisabledReason ? ` ${geminiDisabledReason}` : "";
    const fallbackOverall = `${ctx.fallbackOverallBase}${fallbackReasonSuffix}`;
    const geminiAdvice = geminiAdviceByProposalId.get(ctx.proposalId) ?? { overall: fallbackOverall, findings: [] };

    if (geminiAdvice.findings.length > 0) {
      geminiAdvice.findings.forEach((finding) => {
        outputRows.push({
          proposalId: ctx.proposalId,
          municipalityCode: ctx.municipalityCode,
          section: finding.section,
          importance: finding.importance,
          issue: finding.issue,
          suggestion: finding.suggestion,
          evidence: ctx.combinedEvidence || "根拠データ取得なし",
          classification: finding.classification,
          alternative: finding.alternative,
          overall: ""
        });
      });
    } else {
      ctx.missing.forEach((missingKey) => {
        outputRows.push({
          proposalId: ctx.proposalId,
          municipalityCode: ctx.municipalityCode,
          section: conceptLabel[missingKey],
          importance: "高",
          issue: `${conceptLabel[missingKey]}が不足しています。`,
          suggestion: `${conceptLabel[missingKey]}を具体値・根拠付きで追記してください。`,
          evidence: ctx.combinedEvidence || "根拠データ取得なし",
          classification: "弱み",
          alternative: ctx.scoredPolicies[1]?.policy.title ?? "",
          overall: ""
        });
      });
      if (ctx.scoredPolicies[0]) {
        outputRows.push({
          proposalId: ctx.proposalId,
          municipalityCode: ctx.municipalityCode,
          section: "施策整合",
          importance: "中",
          issue: "類似政策との整合が確認できます。",
          suggestion: `上位類似政策「${ctx.scoredPolicies[0].policy.title}」との差分を明確化してください。`,
          evidence: ctx.combinedEvidence || "根拠データ取得なし",
          classification: "強み",
          alternative: ctx.scoredPolicies[1]?.policy.title ?? "",
          overall: ""
        });
      }
    }

    outputRows.push({
      proposalId: ctx.proposalId,
      municipalityCode: ctx.municipalityCode,
      section: "総評",
      importance: ctx.missing.length > 0 ? "高" : "中",
      issue: ctx.missing.length > 0 ? "入力不足により評価精度が低下しています。" : "主要項目は入力済みです。",
      suggestion:
        ctx.missing.length > 0
          ? "不足項目を補完後、再度CSV添削を実行してください。"
          : "強みを維持しつつ、類似政策との差分を実行計画に反映してください。",
      evidence: ctx.combinedEvidence || "根拠データ取得なし",
      classification: ctx.missing.length > 0 ? "弱み" : "強み",
      alternative: ctx.scoredPolicies[2]?.policy.title ?? ctx.scoredPolicies[1]?.policy.title ?? "",
      overall: geminiAdvice.overall
    });
  }

  const outHeaders = [
    "対象企画ID",
    "自治体コード",
    "指摘対象セクション",
    "重要度",
    "問題点",
    "修正提案",
    "根拠",
    "強み弱み分類",
    "代替案",
    "総評"
  ];
  const outBody = outputRows.map((row) => ({
    "対象企画ID": row.proposalId,
    "自治体コード": row.municipalityCode,
    "指摘対象セクション": row.section,
    "重要度": row.importance,
    "問題点": row.issue,
    "修正提案": row.suggestion,
    "根拠": row.evidence,
    "強み弱み分類": row.classification,
    "代替案": row.alternative,
    "総評": row.overall
  }));
  const outputCsv = buildCsvOutput(outHeaders, outBody);
  return {
    filename: "proposal-review.csv",
    csvContent: outputCsv,
    rows: outputRows
  };
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
    const latestRaw = readAllPolicies();
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
  policies = readAllPolicies().map(toPolicy);
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
  refreshPoliciesCache();
  const municipality = requireSession(request, reply);
  if (!municipality) return;

  const rawKeyword = (request.query.keyword ?? "").trim();
  const keywordTokens = rawKeyword
    .split(/[\s\u3000,，、]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const similarCitiesFromSimilarity = await buildSimilarCitiesFromSimilarity(municipality.code, rawKeyword);
  const similarCities = similarCitiesFromSimilarity ?? buildFallbackSimilarCities(municipality.code, rawKeyword, Object.keys(municipalities).length);
  const top5Cities = similarCities.slice(0, 5);
  const worstCities = similarCities.length > 20 ? [...similarCities].slice(-20).reverse() : [...similarCities].reverse();
  const similarityScoreByCode = new Map(
    similarCities.map((city) => [normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode, city.score])
  );

  const keywordMatched = policies.filter((policy) => {
    // Exclude policies with missing PDF linkage from search results only.
    if (!policy.pdfUrl) return false;
    if (keywordTokens.length === 0) return true;
    const haystack = `${policy.title} ${policy.summary} ${policy.details} ${policy.keywords.join(" ")}`.toLowerCase();
    return keywordTokens.some((token) => haystack.includes(token));
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
  refreshPoliciesCache();
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



