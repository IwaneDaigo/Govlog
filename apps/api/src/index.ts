import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Municipality = {
  code: string;
  name: string;
};

type TwinCity = {
  municipalityCode: string;
  municipalityName: string;
  score: number;
};

type SimilarityRequest = {
  base_cdArea: string;
  candidate_cdAreas: string[];
  limit: number;
  keywords?: string[];
};

type SimilarityResponse = {
  items: string[];
  names?: Record<string, string>;
  scores?: Record<string, number>;
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

const dataDir = resolve(__dirname, "../../../data");
const policiesPdfDir = resolve(dataDir, "policies-pdf");
const similarityApiBaseUrl = process.env.SIMILARITY_API_BASE_URL?.trim();

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

const rawPolicies = readJsonWithFallback<RawPolicy[]>("policies.json", "policies.sample.json");
const policies: Policy[] = rawPolicies.map((item) => ({
  id: item.id,
  municipalityCode: item.municipalityCode,
  municipalityName: item.municipalityName,
  title: item.title,
  summary: item.summary ?? "",
  details: item.details ?? "",
  keywords: item.keywords ?? [],
  pdfPath: normalizePdfPath(item.pdfPath),
  pdfUrl: toPdfUrl(item.pdfPath)
}));

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

if (existsSync(policiesPdfDir)) {
  app.register(fastifyStatic, {
    root: policiesPdfDir,
    prefix: "/files/policies/",
    decorateReply: false,
    index: false
  });
}

const getSession = (request: { cookies: Record<string, string | undefined> }): Municipality | null => {
  const code = request.cookies.municipalityCode;
  if (!code) return null;
  const user = municipalities[code];
  if (!user) return null;
  return { code, name: user.name };
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

const buildTop5CitiesFromSimilarity = async (baseCode: string, keyword: string): Promise<TwinCity[] | null> => {
  if (!similarityApiBaseUrl) return null;

  const candidateCodes = Object.keys(municipalities).filter((code) => code !== baseCode);
  if (candidateCodes.length === 0) return null;

  const payload: SimilarityRequest = {
    base_cdArea: baseCode,
    candidate_cdAreas: candidateCodes,
    limit: 5,
    keywords: keyword ? [keyword] : []
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${similarityApiBaseUrl}/similarity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) return null;

    const result = (await response.json()) as SimilarityResponse;
    const topItems = (result.items ?? []).slice(0, 5);
    if (topItems.length === 0) return null;

    return topItems.map((code) => ({
      municipalityCode: code,
      municipalityName:
        result.names?.[code] ?? municipalities[code]?.name ?? municipalityMasterByCode[code]?.municipalityDisplayName ?? code,
      score: result.scores?.[code] ?? 0
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

app.post<{ Body: { municipalityCode: string } }>("/api/auth/login", async (request, reply) => {
  const { municipalityCode } = request.body;
  if (!municipalityCode) {
    return reply.code(400).send({ message: "municipalityCode is required" });
  }

  const user = municipalities[municipalityCode];
  if (!user) {
    return reply.code(401).send({ message: "Invalid municipality code" });
  }

  reply.setCookie("municipalityCode", municipalityCode, sessionCookieOptions);
  return { municipality: { code: municipalityCode, name: user.name } };
});

app.post("/api/auth/logout", async (_request, reply) => {
  reply.clearCookie("municipalityCode", { path: "/" });
  return { success: true };
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

  const keyword = (request.query.keyword ?? "").trim().toLowerCase();
  const top5FromSimilarity = await buildTop5CitiesFromSimilarity(municipality.code, keyword);
  const top5Cities = top5FromSimilarity ?? (twins[municipality.code] ?? []).slice(0, 5);
  const top5Set = new Set(top5Cities.map((city) => city.municipalityCode));

  const matched = policies.filter((policy) => {
    if (!keyword) return true;
    const haystack = `${policy.title} ${policy.summary} ${policy.details} ${policy.keywords.join(" ")}`.toLowerCase();
    return haystack.includes(keyword);
  });

  const prioritized = matched.sort((a, b) => {
    const aRank = top5Set.has(a.municipalityCode) ? 0 : 1;
    const bRank = top5Set.has(b.municipalityCode) ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.id.localeCompare(b.id);
  });

  return {
    top5Cities,
    policies: prioritized
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
