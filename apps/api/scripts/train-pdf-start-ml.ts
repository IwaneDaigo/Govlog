import { resolve } from "node:path";
import { predictStartPages } from "../src/services/pdf-start-ml";

const run = async (): Promise<void> => {
  const rootDir = resolve(__dirname, "../../../");
  const result = await predictStartPages(rootDir, ["事務事業評価シート 事務事業名 NO.1"]);
  if (!result) {
    console.log("ML model training skipped (no training data).");
    return;
  }
  console.log("ML model trained from data/policies-pdf.");
  console.log(`sanity probability: ${result[0].probability.toFixed(4)}`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
