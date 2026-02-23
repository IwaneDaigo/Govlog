import { resolve } from "node:path";
import { importPoliciesFromPdf } from "../src/services/pdf-import";

const getArg = (name: string, fallback?: string): string => {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing argument --${name}`);
};

const run = async (): Promise<void> => {
  const rootDir = resolve(__dirname, "../../../");
  const input = getArg("input");
  const municipalityCode = getArg("municipalityCode", "14100");
  const municipalityName = getArg("municipalityName", "横浜市");
  const idPrefix = getArg("idPrefix", "yokohama-r7");
  const outDir = getArg("outDir", "data/policies-pdf/yokohama");
  const policiesOut = getArg("policiesOut", "data/policies.yokohama.json");

  const result = await importPoliciesFromPdf({
    rootDir,
    inputPdfPath: input,
    outDir,
    policiesOutPath: policiesOut,
    municipalityCode,
    municipalityName,
    idPrefix,
    mergeToPoliciesJson: true,
    dryRun: false
  });

  console.log(`pages: ${result.pageCount}`);
  console.log(`imported segments: ${result.segmentCount}`);
  console.log(`preview segments: ${result.previewItems.length}`);
  console.log(`ml prediction used: ${result.mlPredictionUsed}`);
  if (result.mergedPoliciesPath) {
    console.log(`merged policies: ${result.mergedPoliciesPath}`);
    console.log(`merged added: ${result.mergedAdded ?? 0}`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
