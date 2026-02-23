import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";

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
};

const SHEET_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u8a55\u4fa1\u30b7\u30fc\u30c8";
const JIMU_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u540d";
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
  const doc = await pdfjs.getDocument({ data, disableWorker: true } as unknown as Parameters<typeof pdfjs.getDocument>[0])
    .promise;

  const segments: Segment[] = [];
  let current: Segment | null = null;
  let autoNo = 0;

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
    const title = extractTitleFromItems(pageItems);
    const isBasicPageLike =
      text.includes(SHEET_LABEL) &&
      text.includes(JIMU_LABEL) &&
      !text.includes(DETAIL_SECTION_LABEL) &&
      !text.includes(STATUS_SECTION_LABEL);

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
      if (title && !current.title) current.title = title;
    }
  }

  if (current) segments.push(current);
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

    if (selectedIdSet && !selectedIdSet.has(id)) {
      continue;
    }

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
    previewItems
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
