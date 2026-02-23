import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
const similarityApiBaseUrl = process.env.SIMILARITY_API_BASE_URL?.trim();
const similarityClient = similarityApiBaseUrl ? new SimilarityClient(similarityApiBaseUrl) : null;
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
    const items = result.items ?? [];
    if (items.length === 0) return null;

    return items.map((code) => {
      const masterName = municipalityMasterByCode[code]?.municipalityDisplayName ?? municipalityMasterByCode[code]?.municipalityName;
      const localName =
        municipalities[code]?.name ??
        Object.entries(municipalities).find(([rawCode]) => normalizeToCdArea(rawCode) === code)?.[1].name;

      return {
        municipalityCode: code,
        municipalityName: result.names?.[code] ?? masterName ?? localName ?? code,
        score: result.scores?.[code] ?? 0
      };
    });
  } catch {
    return null;
  }
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
  const similarCities = similarCitiesFromSimilarity ?? (twins[municipality.code] ?? []).slice(0, 5);
  const top5Cities = similarCities.slice(0, 5);
  const worstCities = similarCities.length > 20 ? [...similarCities].slice(-20).reverse() : [...similarCities].reverse();
  const top5Set = new Set(top5Cities.map((city) => normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode));
  const top5Rank = new Map(top5Cities.map((city, idx) => [normalizeToCdArea(city.municipalityCode) ?? city.municipalityCode, idx]));

  const keywordMatched = policies.filter((policy) => {
    if (!keyword) return true;
    const haystack = `${policy.title} ${policy.summary} ${policy.details} ${policy.keywords.join(" ")}`.toLowerCase();
    return haystack.includes(keyword);
  });

  // Pick policies that are both keyword-matched and implemented by similar municipalities.
  const fromTop5Cities = keywordMatched
    .filter((policy) => {
      const policyCode = normalizeToCdArea(policy.municipalityCode) ?? policy.municipalityCode;
      return top5Set.has(policyCode);
    })
    .sort((a, b) => {
      const aCode = normalizeToCdArea(a.municipalityCode) ?? a.municipalityCode;
      const bCode = normalizeToCdArea(b.municipalityCode) ?? b.municipalityCode;
      const aRank = top5Rank.get(aCode) ?? Number.MAX_SAFE_INTEGER;
      const bRank = top5Rank.get(bCode) ?? Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return a.id.localeCompare(b.id);
    });

  // Fallback: if no top5 policy matches, keep previous behavior and return keyword-matched list.
  const policiesToReturn = fromTop5Cities.length > 0 ? fromTop5Cities : keywordMatched;

  return {
    top5Cities,
    similarCities: similarCities.slice(0, 20),
    worstCities,
    policies: policiesToReturn
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
    if (!existsSync(policiesPdfDir)) {
      app.log.warn({ path: policiesPdfDir }, "PDF directory not found. Create data/policies-pdf to serve split PDFs.");
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
