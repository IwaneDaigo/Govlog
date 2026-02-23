import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";

type ManifestItem = {
  id: string;
  title: string;
  municipalityCode: string;
  municipalityName: string;
  startPage: number;
  endPage: number;
  keywords?: string[];
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

const getArg = (name: string, fallback?: string): string => {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing argument --${name}`);
};

const rootDir = resolve(__dirname, "../../../");
const inputPdfPath = resolve(rootDir, getArg("input"));
const manifestPath = resolve(rootDir, getArg("manifest"));
const outputDir = resolve(rootDir, getArg("outDir", "data/policies-pdf"));
const policiesOutPath = resolve(rootDir, getArg("policiesOut", "data/policies.json"));

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestItem[];
if (!Array.isArray(manifest) || manifest.length === 0) {
  throw new Error("Manifest must be a non-empty array");
}

const run = async (): Promise<void> => {
  const sourceBytes = readFileSync(inputPdfPath);
  const source = await PDFDocument.load(sourceBytes);
  const sourcePages = source.getPageCount();

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(dirname(policiesOutPath), { recursive: true });

  const policies: PolicyOutput[] = [];

  for (const item of manifest) {
    if (item.startPage < 1 || item.endPage < 1 || item.startPage > item.endPage) {
      throw new Error(`Invalid page range for ${item.id}: ${item.startPage}-${item.endPage}`);
    }
    if (item.endPage > sourcePages) {
      throw new Error(`Out of range for ${item.id}: source has ${sourcePages} pages`);
    }

    const newPdf = await PDFDocument.create();
    const pageIndexes = Array.from({ length: item.endPage - item.startPage + 1 }, (_, i) => item.startPage - 1 + i);
    const copiedPages = await newPdf.copyPages(source, pageIndexes);
    copiedPages.forEach((page) => newPdf.addPage(page));

    const outputFileName = `${item.id}.pdf`;
    const outputPath = resolve(outputDir, outputFileName);
    const outputBytes = await newPdf.save();
    writeFileSync(outputPath, outputBytes);

    const relPath = relative(resolve(rootDir, "data"), outputPath).replace(/\\/g, "/");
    policies.push({
      id: item.id,
      municipalityCode: item.municipalityCode,
      municipalityName: item.municipalityName,
      title: item.title,
      summary: "",
      details: "",
      keywords: item.keywords ?? [],
      pdfPath: relPath
    });
  }

  writeFileSync(policiesOutPath, `${JSON.stringify(policies, null, 2)}\n`, "utf-8");
  // eslint-disable-next-line no-console
  console.log(`Created ${policies.length} policy PDFs in ${outputDir}`);
  // eslint-disable-next-line no-console
  console.log(`Created policy metadata: ${policiesOutPath}`);
};

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
