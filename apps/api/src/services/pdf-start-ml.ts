import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type StartPageModel = {
  weights: Map<string, number>;
  bias: number;
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
const START_THRESHOLD = 0.85;
const TEMPERATURE = 1.0;
const LR_EPOCHS = 3;
const LR_RATE = 0.05;
const L2 = 1e-4;

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

type Example = { tokens: string[]; label: 0 | 1 };

const trainStartPageModel = async (rootDir: string): Promise<StartPageModel | null> => {
  const trainDir = resolve(rootDir, TRAIN_DIR);
  const files = walkPdfFiles(trainDir).slice(0, MAX_DOCS);
  if (files.length === 0) return null;

  const examples: Example[] = [];
  let posDocs = 0;
  let negDocs = 0;

  for (const file of files) {
    const pageTexts = await extractPageTextsFromPdf(file);
    for (let i = 0; i < pageTexts.length; i += 1) {
      const isStart = i === 0;
      const tokens = tokenize(pageTexts[i]);
      if (tokens.length === 0) continue;
      const label: 0 | 1 = isStart ? 1 : 0;
      examples.push({ tokens, label });
      if (isStart) posDocs += 1;
      else negDocs += 1;
    }
  }

  if (posDocs === 0) return null;
  if (negDocs === 0) {
    // Add a synthetic negative to avoid a degenerate model.
    examples.push({ tokens: ["__NEG__"], label: 0 });
  }

  const weights = new Map<string, number>();
  let bias = 0;

  for (let epoch = 0; epoch < LR_EPOCHS; epoch += 1) {
    for (const ex of examples) {
      let score = bias;
      for (const token of ex.tokens) {
        score += weights.get(token) ?? 0;
      }
      const p = sigmoid(score);
      const err = ex.label - p;
      bias += LR_RATE * err;
      for (const token of ex.tokens) {
        const w = weights.get(token) ?? 0;
        const updated = w + LR_RATE * (err - L2 * w);
        weights.set(token, updated);
      }
    }
  }

  return { weights, bias, trainedAt: Date.now() };
};

const ensureModel = async (rootDir: string): Promise<StartPageModel | null> => {
  if (modelCache) return modelCache;
  modelCache = await trainStartPageModel(rootDir);
  return modelCache;
};

export const predictStartPages = async (rootDir: string, pageTexts: string[]): Promise<StartPagePrediction[] | null> => {
  const model = await ensureModel(rootDir);
  if (!model) return null;

  return pageTexts.map((text) => {
    const tokens = tokenize(text);
    let score = model.bias;
    for (const token of tokens) {
      score += model.weights.get(token) ?? 0;
    }
    const probability = sigmoid(score / TEMPERATURE);
    return {
      probability,
      isStart: probability >= START_THRESHOLD
    };
  });
};
