import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { predictStartPages } from "./pdf-start-ml";

type PageTextItem = {
  str: string;
  x: number;
  y: number;
};

type Segment = {
  no: string;
  startPage: number;
  endPage: number;
  title?: string;
};

export type PolicyOutput = {
  id: string;
  municipalityCode: string;
  municipalityName: string;
  title: string;
  summary: string;
  details: string;
  keywords: string[];
  pdfPath: string;
};

export type ImportPdfOptions = {
  rootDir: string;
  inputPdfPath: string;
  outDir: string;
  policiesOutPath: string;
  municipalityCode: string;
  municipalityName: string;
  idPrefix: string;
  mergeToPoliciesJson?: boolean;
  dryRun?: boolean;
  selectedIds?: string[];
};

export type ImportPdfPreviewItem = {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  pageCount: number;
};

export type ImportPdfResult = {
  pageCount: number;
  segmentCount: number;
  outDir: string;
  policiesOutPath: string;
  mergedPoliciesPath?: string;
  mergedAdded?: number;
  previewItems: ImportPdfPreviewItem[];
  mlPredictionUsed: boolean;
};

const SHEET_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u8a55\u4fa1\u30b7\u30fc\u30c8";
const JIMU_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u540d";
const SIMPLE_BUSINESS_LABEL = "\u4e8b\u696d\u540d";
const DETAIL_SECTION_LABEL = "\u226a\u4e8b\u696d\u5b9f\u7e3e\u7b49\u226b";
const STATUS_SECTION_LABEL = "\u226a\u53d6\u7d44\u72b6\u6cc1\u226b";
const FALLBACK_TITLE_PREFIX = "\u4e8b\u696d";

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const extractNo = (text: string): string | null => {
  const m = text.match(/(?:NO|No|no)\.?\s*([0-9]{1,4})/);
  return m?.[1] ?? null;
};

const extractNoFromItems = (items: PageTextItem[]): string | null => {
  const normalized = items.map((i) => ({ ...i, t: i.str.trim() })).filter((i) => i.t.length > 0);

  const noLabel = normalized.find((i) => /^NO\.?$/i.test(i.t));
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

const extractBusinessNameFromLabelLine = (items: PageTextItem[], label: string): string | undefined => {
  const normalized = items.map((i) => ({ ...i, t: i.str.trim() })).filter((i) => i.t.length > 0);
  const labelItem = normalized.find((i) => i.t === label);
  if (!labelItem) return undefined;

  const lineItems = normalized
    .filter((i) => Math.abs(i.y - labelItem.y) <= 3 && i.x > labelItem.x)
    .sort((a, b) => a.x - b.x);

  if (lineItems.length === 0) return undefined;

  const firstNonNumber = lineItems.find((i, idx) => !/^\d{1,4}$/.test(i.t) && (idx === 0 || /^\d{1,4}$/.test(lineItems[idx - 1].t)));
  if (firstNonNumber) return cleanupBusinessName(firstNonNumber.t);

  const joined = normalizeText(lineItems.map((i) => i.t).join(" "));
  return cleanupBusinessName(joined);
};

const extractTitleFromItems = (items: PageTextItem[]): string | undefined => {
  const normalized = items.map((i) => ({ ...i, t: i.str.trim() })).filter((i) => i.t.length > 0);
  const label = normalized.find((i) => i.t === JIMU_LABEL);
  if (!label) return undefined;

  const candidates = normalized
    .filter((i) => i.x > label.x + 20 && Math.abs(i.y - label.y) <= 4)
    .map((i) => i.t)
    .filter((t) => !/^[:\uff1a\-\u30fb\s]+$/.test(t));

  if (candidates.length === 0) return undefined;
  const joined = normalizeText(candidates.join(" "));
  return joined || undefined;
};

const cleanupBusinessName = (value: string): string | undefined => {
  const cleaned = normalizeText(value)
    .replace(/^[:\uff1a\-\u30fb\s]+/, "")
    .replace(/\s*(?:\u4e8b\u696d\u306e\u76ee\u7684|\u4e8b\u696d\u76ee\u7684|\u6240\u5c5e|\u62c5\u5f53|\u4e88\u7b97|\u8a55\u4fa1|\u6210\u679c\u6307\u6a19|\u6307\u6a19).*$/, "")
    .trim();

  if (!cleaned) return undefined;
  if (cleaned.length > 120) return undefined;
  return cleaned;
};

const hasReiwaBusinessHeader = (text: string): boolean => /\u4ee4\u548c[6\uff16]\u5e74\u5ea6\s*\u4e8b\u696d\u540d/.test(text);

const extractBusinessNameFromItems = (items: PageTextItem[]): string | undefined => {
  const normalized = items
    .map((i) => ({ ...i, t: i.str.trim() }))
    .filter((i) => i.t.length > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const header = normalized.find((i) => /\u4ee4\u548c[6\uff16]\u5e74\u5ea6\s*\u4e8b\u696d\u540d/.test(i.t));
  if (!header) {
    return (
      extractBusinessNameFromLabelLine(items, SIMPLE_BUSINESS_LABEL) ??
      extractBusinessNameFromLabelLine(items, "\u7d30\u4e8b\u696d\u540d\u79f0")
    );
  }

  const lineItems = normalized
    .filter((i) => Math.abs(i.y - header.y) <= 3 && i.x > header.x)
    .sort((a, b) => a.x - b.x);

  const tokens: string[] = [];
  for (const item of lineItems) {
    if (/^(?:\u6b73\u51fa\u4e88\u7b97\u79d1\u76ee|\u6240\u7ba1\u533a\u5c40\u30fb\u8ab2|\u6240\u7ba1\u533a\u5c40|\u8a55\u4fa1\u66f8\u756a\u53f7|\u4e8b\u696d\u6982\u8981)$/.test(item.t)) {
      break;
    }
    tokens.push(item.t);
  }

  return cleanupBusinessName(tokens.join(" "));
};

const extractBusinessNameFromText = (text: string): string | undefined => {
  const patterns = [
    /\u4ee4\u548c[6\uff16]\u5e74\u5ea6\s*\u4e8b\u696d\u540d\s*[:\uff1a]?\s*(.+?)(?=\s*(?:\u6b73\u51fa\u4e88\u7b97\u79d1\u76ee|\u6240\u7ba1\u533a\u5c40\u30fb\u8ab2|\u4e8b\u696d\u6982\u8981|$))/,
    /\u4e8b\u696d\u540d\s*\d{1,4}\s*([^\s]+)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const name = cleanupBusinessName(match[1]);
    if (name) return name;
  }

  return undefined;
};

const upsertPolicies = (base: PolicyOutput[], incoming: PolicyOutput[]): { merged: PolicyOutput[]; added: number } => {
  const byId = new Map(base.map((item) => [item.id, item]));
  let added = 0;
  incoming.forEach((item) => {
    if (!byId.has(item.id)) added += 1;
    byId.set(item.id, item);
  });
  return { merged: [...byId.values()], added };
};

export const importPoliciesFromPdf = async (options: ImportPdfOptions): Promise<ImportPdfResult> => {
  const sourcePdfPath = resolve(options.rootDir, options.inputPdfPath);
  const outDirAbs = resolve(options.rootDir, options.outDir);
  const policiesOutAbs = resolve(options.rootDir, options.policiesOutPath);

  if (!existsSync(sourcePdfPath)) {
    throw new Error(`Input PDF not found: ${sourcePdfPath}`);
  }

  const sourceBytes = readFileSync(sourcePdfPath);
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const pageCount = sourcePdf.getPageCount();

  const data = new Uint8Array(sourceBytes);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, disableWorker: true } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;

  const segments: Segment[] = [];
  let current: Segment | null = null;
  let autoNo = 0;

  const pageTexts: string[] = [];
  const pageTitles: Array<string | undefined> = [];
  const pageBusinessNames: Array<string | undefined> = [];
  const pageHasBusinessHeader: boolean[] = [];
  const pageNos: Array<string | null> = [];
  const pageBasicFlags: boolean[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageItems: PageTextItem[] = textContent.items
      .map((item) => {
        if (!("str" in item) || !("transform" in item)) return null;
        return {
          str: item.str ?? "",
          x: item.transform?.[4] ?? 0,
          y: item.transform?.[5] ?? 0
        };
      })
      .filter((item): item is PageTextItem => item !== null);

    const text = normalizeText(pageItems.map((item) => item.str).join(" "));
    const no = extractNoFromItems(pageItems) ?? extractNo(text);
    const businessName = extractBusinessNameFromItems(pageItems) ?? extractBusinessNameFromText(text);
    const title = businessName ?? extractTitleFromItems(pageItems);
    const isBasicPageLike =
      text.includes(SHEET_LABEL) &&
      text.includes(JIMU_LABEL) &&
      !text.includes(DETAIL_SECTION_LABEL) &&
      !text.includes(STATUS_SECTION_LABEL);

    pageTexts.push(text);
    pageNos.push(no);
    pageTitles.push(title);
    pageBusinessNames.push(businessName);
    pageHasBusinessHeader.push(hasReiwaBusinessHeader(text));
    pageBasicFlags.push(isBasicPageLike);
  }

  const mlPredictions = await predictStartPages(options.rootDir, pageTexts);
  let mlUsed = false;
  let lastBusinessName: string | null = null;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const no = pageNos[pageNumber - 1];
    const title = pageTitles[pageNumber - 1];
    const businessName = pageBusinessNames[pageNumber - 1];
    const hasBusinessHeader = pageHasBusinessHeader[pageNumber - 1];
    const isBasicPageLike = pageBasicFlags[pageNumber - 1];
    // ML start prediction is only used in the fallback block when rule-based splitting yields 0 segments.
    const mlStart = false;

    let startKey: string | null = null;
    if (hasBusinessHeader) {
      autoNo += 1;
      startKey = String(autoNo);
      if (businessName) lastBusinessName = businessName;
    } else if (businessName && businessName !== lastBusinessName) {
      autoNo += 1;
      startKey = String(autoNo);
      lastBusinessName = businessName;
    } else if (no) {
      startKey = no;
    } else if (isBasicPageLike && title) {
      autoNo += 1;
      startKey = String(autoNo);
      if (mlStart) mlUsed = true;
    }

    if (startKey && (!current || current.no !== startKey)) {
      if (current) segments.push(current);
      current = { no: startKey, startPage: pageNumber, endPage: pageNumber, title: businessName ?? title };
      continue;
    }

    if (current) {
      current.endPage = pageNumber;
      if ((businessName ?? title) && !current.title) current.title = businessName ?? title;
    }
  }

  if (current) segments.push(current);

  if (segments.length === 0 && mlPredictions) {
    const startPages = mlPredictions
      .map((pred, idx) => ({ page: idx + 1, p: pred.probability }))
      .filter((item) => item.p >= 0.5)
      .map((item) => item.page);

    if (startPages.length === 0 || startPages[0] !== 1) {
      startPages.unshift(1);
    }

    const uniqueStartPages = [...new Set(startPages)].sort((a, b) => a - b);
    for (let i = 0; i < uniqueStartPages.length; i += 1) {
      const startPage = uniqueStartPages[i];
      const endPage = i + 1 < uniqueStartPages.length ? uniqueStartPages[i + 1] - 1 : pageCount;
      if (endPage < startPage) continue;
      const no = String(i + 1);
      const title = pageBusinessNames[startPage - 1] ?? pageTitles[startPage - 1];
      segments.push({ no, startPage, endPage, title });
    }
    mlUsed = true;
  }

  if (segments.length === 0) {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      segments.push({
        no: String(pageNumber),
        startPage: pageNumber,
        endPage: pageNumber,
        title: pageBusinessNames[pageNumber - 1] ?? pageTitles[pageNumber - 1]
      });
    }
  }

  if (segments.length === 0) {
    throw new Error("No business segments found. Check PDF format.");
  }

  const policies: PolicyOutput[] = [];
  const previewItems: ImportPdfPreviewItem[] = [];
  const selectedIdSet = options.selectedIds ? new Set(options.selectedIds) : null;

  if (!options.dryRun) {
    mkdirSync(outDirAbs, { recursive: true });
    mkdirSync(dirname(policiesOutAbs), { recursive: true });
  }

  for (const segment of segments) {
    const noPadded = segment.no.padStart(3, "0");
    const id = `${options.idPrefix}-${noPadded}`;
    const outputPath = resolve(outDirAbs, `${id}.pdf`);
    const title = segment.title ?? `${FALLBACK_TITLE_PREFIX}${segment.no}`;

    previewItems.push({
      id,
      title,
      startPage: segment.startPage,
      endPage: segment.endPage,
      pageCount: segment.endPage - segment.startPage + 1
    });

    if (selectedIdSet && !selectedIdSet.has(id)) continue;

    if (!options.dryRun) {
      const splitPdf = await PDFDocument.create();
      const pageIndexes = Array.from({ length: segment.endPage - segment.startPage + 1 }, (_, i) => segment.startPage - 1 + i);
      const copied = await splitPdf.copyPages(sourcePdf, pageIndexes);
      copied.forEach((p) => splitPdf.addPage(p));
      writeFileSync(outputPath, await splitPdf.save());
    }

    const relPath = relative(resolve(options.rootDir, "data"), outputPath).replace(/\\/g, "/");
    policies.push({
      id,
      municipalityCode: options.municipalityCode,
      municipalityName: options.municipalityName,
      title,
      summary: "",
      details: "",
      keywords: [],
      pdfPath: relPath
    });
  }

  if (!options.dryRun) {
    writeFileSync(policiesOutAbs, `${JSON.stringify(policies, null, 2)}\n`, "utf-8");
  }

  const result: ImportPdfResult = {
    pageCount,
    segmentCount: policies.length,
    outDir: outDirAbs,
    policiesOutPath: policiesOutAbs,
    previewItems,
    mlPredictionUsed: mlUsed
  };

  if (!options.dryRun && options.mergeToPoliciesJson !== false) {
    const mergedPath = resolve(options.rootDir, "data/policies.json");
    const currentPolicies = existsSync(mergedPath)
      ? (JSON.parse(readFileSync(mergedPath, "utf-8")) as PolicyOutput[])
      : [];
    const merged = upsertPolicies(currentPolicies, policies);
    writeFileSync(mergedPath, `${JSON.stringify(merged.merged, null, 2)}\n`, "utf-8");
    result.mergedPoliciesPath = mergedPath;
    result.mergedAdded = merged.added;
  }

  return result;
};
