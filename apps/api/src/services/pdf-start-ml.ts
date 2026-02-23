import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type TokenStats = {
  pos: Map<string, number>;
  neg: Map<string, number>;
  vocab: Set<string>;
  posDocs: number;
  negDocs: number;
  posTotal: number;
  negTotal: number;
};

type StartPageModel = {
  stats: TokenStats;
  trainedAt: number;
};

export type StartPagePrediction = {
  probability: number;
  isStart: boolean;
};

const SHEET_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u8a55\u4fa1\u30b7\u30fc\u30c8";
const TITLE_LABEL = "\u4e8b\u52d9\u4e8b\u696d\u540d";
const TRAIN_DIR = "data/policies-pdf";
const MAX_DOCS = 400;
const START_THRESHOLD = 0.72;
const TEMPERATURE = 6;

let modelCache: StartPageModel | null = null;

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const walkPdfFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkPdfFiles(abs));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      out.push(abs);
    }
  }
  return out;
};

const tokenize = (text: string): string[] => {
  const norm = normalizeText(text);
  if (!norm) return [];

  const tokens = new Set<string>();
  if (norm.includes(SHEET_LABEL)) tokens.add("__HAS_SHEET__");
  if (norm.includes(TITLE_LABEL)) tokens.add("__HAS_TITLE__");
  if (/NO\.?\s*\d{1,4}/i.test(norm)) tokens.add("__HAS_NO__");

  const latin = norm.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  latin.forEach((t) => tokens.add(`en:${t.toLowerCase()}`));

  const cjk = norm.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, "");
  for (let i = 0; i < cjk.length - 1; i += 1) {
    tokens.add(`ja2:${cjk.slice(i, i + 2)}`);
  }

  return [...tokens];
};

const extractPageTextsFromPdf = async (pdfPath: string): Promise<string[]> => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = readFileSync(pdfPath);
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data, disableWorker: true } as unknown as Parameters<typeof pdfjs.getDocument>[0])
    .promise;

  const texts: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = normalizeText(
      textContent.items
        .map((item) => ("str" in item ? item.str ?? "" : ""))
        .join(" ")
    );
    texts.push(text);
  }
  return texts;
};

const trainStartPageModel = async (rootDir: string): Promise<StartPageModel | null> => {
  const trainDir = resolve(rootDir, TRAIN_DIR);
  const files = walkPdfFiles(trainDir).slice(0, MAX_DOCS);
  if (files.length === 0) return null;

  const stats: TokenStats = {
    pos: new Map(),
    neg: new Map(),
    vocab: new Set(),
    posDocs: 0,
    negDocs: 0,
    posTotal: 0,
    negTotal: 0
  };

  for (const file of files) {
    const pageTexts = await extractPageTextsFromPdf(file);
    for (let i = 0; i < pageTexts.length; i += 1) {
      const isStart = i === 0;
      const tokens = tokenize(pageTexts[i]);
      if (tokens.length === 0) continue;

      if (isStart) stats.posDocs += 1;
      else stats.negDocs += 1;

      tokens.forEach((token) => {
        stats.vocab.add(token);
        if (isStart) {
          stats.pos.set(token, (stats.pos.get(token) ?? 0) + 1);
          stats.posTotal += 1;
        } else {
          stats.neg.set(token, (stats.neg.get(token) ?? 0) + 1);
          stats.negTotal += 1;
        }
      });
    }
  }

  if (stats.posDocs === 0) return null;
  if (stats.negDocs === 0) {
    // If only one-page PDFs exist, keep a small negative prior instead of returning null.
    stats.negDocs = 1;
  }
  return { stats, trainedAt: Date.now() };
};

const ensureModel = async (rootDir: string): Promise<StartPageModel | null> => {
  if (modelCache) return modelCache;
  modelCache = await trainStartPageModel(rootDir);
  return modelCache;
};

export const predictStartPages = async (rootDir: string, pageTexts: string[]): Promise<StartPagePrediction[] | null> => {
  const model = await ensureModel(rootDir);
  if (!model) return null;

  const { stats } = model;
  const vocabSize = Math.max(stats.vocab.size, 1);
  const prior = Math.log((stats.posDocs + 1) / (stats.negDocs + 1));

  return pageTexts.map((text) => {
    const tokens = tokenize(text);
    let score = prior;
    tokens.forEach((token) => {
      const pPos = ((stats.pos.get(token) ?? 0) + 1) / (stats.posTotal + vocabSize);
      const pNeg = ((stats.neg.get(token) ?? 0) + 1) / (stats.negTotal + vocabSize);
      score += Math.log(pPos) - Math.log(pNeg);
    });
    const probability = sigmoid(score / TEMPERATURE);
    return {
      probability,
      isStart: probability >= START_THRESHOLD
    };
  });
};
