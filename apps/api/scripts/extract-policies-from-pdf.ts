import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";

type Segment = {
  no: string;
  startPage: number;
  endPage: number;
  title?: string;
};

type PageTextItem = {
  str: string;
  x: number;
  y: number;
};

type PolicyOutput = {
  id: string;
  municipalityCode: string;
  municipalityName: string;
  title: string;
  summary: string;
  details: string;
  keywords: string[];
  pdfPath: string;
};

const PERIOD_LABEL = "\u3010\u4e8b\u696d\u5b9f\u65bd\u671f\u9593\u3011"; // 【事業実施期間】
const MUNICIPALITY_NAME_DEFAULT = "\u4eac\u90fd\u5e9c\u4eac\u90fd\u5e02"; // 京都府京都市
const FALLBACK_TITLE_PREFIX = "\u4e8b\u696d"; // 事業
const JIMU_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u540d"; // 事務事業名
const SHEET_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u8a55\u4fa1\u30b7\u30fc\u30c8"; // 事務事業評価シート

const getArg = (name: string, fallback?: string): string => {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing argument --${name}`);
};

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const readMunicipalityNameFromCsv = (rootDir: string, municipalityCode: string): string | null => {
  const csvPath = resolve(rootDir, "data/municipalities.csv");
  if (!existsSync(csvPath)) return null;

  const lines = readFileSync(csvPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length <= 1) return null;

  const parse = (line: string): string[] => {
    const values: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        values.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    values.push(cur);
    return values;
  };

  const header = parse(lines[0]).map((v) => v.replace(/^\uFEFF/, ""));
  const codeIdx = header.indexOf("municipalityCode");
  const displayIdx = header.indexOf("municipalityDisplayName");
  const nameIdx = header.indexOf("municipalityName");
  if (codeIdx < 0) return null;

  for (const line of lines.slice(1)) {
    const cols = parse(line);
    if ((cols[codeIdx] ?? "") === municipalityCode) {
      return cols[displayIdx] ?? cols[nameIdx] ?? null;
    }
  }
  return null;
};

const extractNo = (text: string): string | null => {
  const m = text.match(/[NＮ][oｏ][.．]\s*([0-9]{1,4})/);
  return m?.[1] ?? null;
};

const extractNoFromItems = (items: PageTextItem[]): string | null => {
  const normalized = items.map((i) => ({ ...i, t: i.str.trim() })).filter((i) => i.t.length > 0);

  const noLabel = normalized.find((i) => /^NO[.．]?$/i.test(i.t) || /^[NＮ][oｏ][.．]?$/.test(i.t));
  if (noLabel) {
    const rightNum = normalized
      .filter((i) => i.x > noLabel.x && Math.abs(i.y - noLabel.y) <= 6 && /^[0-9]{1,4}$/.test(i.t))
      .sort((a, b) => a.x - b.x)[0];
    if (rightNum) return rightNum.t;
  }

  const topRightNum = normalized
    .filter((i) => i.x >= 500 && i.y >= 740 && /^[0-9]{1,4}$/.test(i.t))
    .sort((a, b) => b.y - a.y || a.x - b.x)[0];
  return topRightNum?.t ?? null;
};

const extractTitleFromItems = (items: PageTextItem[]): string | undefined => {
  const normalized = items.map((i) => ({ ...i, t: i.str.trim() })).filter((i) => i.t.length > 0);
  const label = normalized.find((i) => i.t === JIMU_LABEL);
  if (!label) return undefined;

  const candidates = normalized
    .filter((i) => i.x > label.x + 20 && Math.abs(i.y - label.y) <= 4)
    .map((i) => i.t)
    .filter((t) => !/^[:：]$/.test(t));

  if (candidates.length === 0) return undefined;
  const joined = normalizeText(candidates.join(" "));
  return joined || undefined;
};

const extractTitleFromText = (text: string): string | undefined => {
  const isHeaderLike = (value: string): boolean =>
    /事業概要|取組実績|経費（一財）|令和６年度\）\s*１/.test(value);

  const cleanTitle = (rawInput: string): string | undefined => {
    let raw = normalizeText(rawInput);
    if (raw.includes("\u5c40 ")) raw = raw.slice(raw.lastIndexOf("\u5c40 ") + 2).trim();

    const title = raw
      .replace(/^.*\u5c40\s+/, "") // drop remaining "...局 "
      .replace(/^.*\u4e8b\u696d\u540d\s*/, "") // drop "...事業名"
      .replace(/^\u4ee4\u548c[0-9\uff10-\uff19]+\u5e74\u5ea6.*?\u306b\u3064\u3044\u3066\s*/, ""); // drop long heading

    if (!title) return undefined;
    if (title.includes("\u4e8b\u696d\u540d")) return undefined; // 事業名
    if (title.length > 120) return undefined;
    if (isHeaderLike(title)) return undefined;
    return title;
  };

  const markerIndex = text.indexOf(PERIOD_LABEL);
  if (markerIndex >= 0) {
    const head = text.slice(0, markerIndex);
    const lastKyokuIndex = head.lastIndexOf("\u5c40 "); // 局 + space
    if (lastKyokuIndex >= 0) {
      const title = cleanTitle(head.slice(lastKyokuIndex + 2));
      if (title) return title;
    }
  }

  const fallbackPatterns = [
    /局\s+(.{2,120}?)\s+[5５]\s+事業目標/,
    /局\s+(.{2,120}?)\s+[6６]\s+役割分担評価/
  ];
  for (const pattern of fallbackPatterns) {
    const m = text.match(pattern);
    if (!m?.[1]) continue;
    const title = cleanTitle(m[1]);
    if (title) return title;
  }

  return undefined;
};

const run = async (): Promise<void> => {
  const rootDir = resolve(__dirname, "../../../");
  const inputPdfPath = resolve(rootDir, getArg("input"));
  const outDir = resolve(rootDir, getArg("outDir", "data/policies-pdf/kyoto"));
  const policiesOutPath = resolve(rootDir, getArg("policiesOut", "data/policies.kyoto.json"));
  const municipalityCode = getArg("municipalityCode", "26100");
  const municipalityName =
    getArg("municipalityName", readMunicipalityNameFromCsv(rootDir, municipalityCode) ?? MUNICIPALITY_NAME_DEFAULT);
  const idPrefix = getArg("idPrefix", "kyoto-r6");

  const sourceBytes = readFileSync(inputPdfPath);
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const pageCount = sourcePdf.getPageCount();

  const data = new Uint8Array(sourceBytes);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;

  const segments: Segment[] = [];
  let current: Segment | null = null;
  let autoNo = 0;
  const isHeaderLikeTitle = (value: string): boolean =>
    /事業概要|取組実績|経費（一財）|令和６年度\）\s*１/.test(value);

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageItems: PageTextItem[] = textContent.items.map((item: { str?: string; transform?: number[] }) => ({
      str: item.str ?? "",
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0
    }));
    const text = normalizeText(pageItems.map((item) => item.str).join(" "));
    const no = extractNoFromItems(pageItems) ?? extractNo(text);
    const title = extractTitleFromItems(pageItems) ?? extractTitleFromText(text);
    const isBasicPageLike =
      text.includes(SHEET_LABEL) &&
      text.includes(JIMU_LABEL) &&
      !text.includes("\u226a\u4e8b\u696d\u5b9f\u7e3e\u7b49\u226b") &&
      !text.includes("\u226a\u53d6\u7d44\u72b6\u6cc1\u226b");

    let startKey: string | null = null;
    if (no) {
      startKey = no;
    } else if (isBasicPageLike && title) {
      autoNo += 1;
      startKey = String(autoNo);
    }

    if (startKey && (!current || current.no !== startKey)) {
      if (current) segments.push(current);
      current = { no: startKey, startPage: pageNumber, endPage: pageNumber, title };
      continue;
    }

    if (current) {
      current.endPage = pageNumber;
      if (title) {
        if (!current.title) {
          current.title = title;
        } else if (isHeaderLikeTitle(current.title) && !isHeaderLikeTitle(title)) {
          current.title = title;
        }
      }
    }
  }

  if (current) segments.push(current);
  if (segments.length === 0) throw new Error("No business segments found. Check PDF format.");

  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(policiesOutPath), { recursive: true });

  const policies: PolicyOutput[] = [];

  for (const segment of segments) {
    const noPadded = segment.no.padStart(3, "0");
    const id = `${idPrefix}-${noPadded}`;
    const outputPath = resolve(outDir, `${id}.pdf`);

    const splitPdf = await PDFDocument.create();
    const pageIndexes = Array.from(
      { length: segment.endPage - segment.startPage + 1 },
      (_, i) => segment.startPage - 1 + i
    );
    const copied = await splitPdf.copyPages(sourcePdf, pageIndexes);
    copied.forEach((p) => splitPdf.addPage(p));
    writeFileSync(outputPath, await splitPdf.save());

    const relPath = relative(resolve(rootDir, "data"), outputPath).replace(/\\/g, "/");
    policies.push({
      id,
      municipalityCode,
      municipalityName,
      title: segment.title ?? `${FALLBACK_TITLE_PREFIX}${segment.no}`,
      summary: "",
      details: "",
      keywords: [],
      pdfPath: relPath
    });
  }

  writeFileSync(policiesOutPath, `${JSON.stringify(policies, null, 2)}\n`, "utf-8");
  console.log(`source pages: ${pageCount}`);
  console.log(`segments: ${segments.length}`);
  console.log(`pdf dir: ${outDir}`);
  console.log(`policies: ${policiesOutPath}`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
