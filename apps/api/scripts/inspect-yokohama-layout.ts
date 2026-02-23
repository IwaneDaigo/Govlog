import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = resolve('C:/VsCodeProject/Huckkason/02_R7digital-yokohama.pdf');
const data = new Uint8Array(readFileSync(input));

const run = async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, disableWorker: true } as any).promise;
  const max = Math.min(doc.numPages, 12);
  for (let p = 1; p <= max; p += 1) {
    const page = await doc.getPage(p);
    const text = await page.getTextContent();
    const items = text.items
      .map((it: any) => ({ str: (it.str || '').trim(), x: it.transform?.[4] ?? 0, y: it.transform?.[5] ?? 0 }))
      .filter((it: any) => it.str);

    const labels = items.filter((it: any) =>
      it.str.includes('事業名') || it.str.includes('令和6年度') || it.str.includes('令和６年度')
    );

    console.log(`--- page ${p} ---`);
    labels.slice(0, 20).forEach((it: any) => {
      console.log(`${it.y.toFixed(1)} ${it.x.toFixed(1)} :: ${it.str}`);
    });

    const lineLike = items
      .filter((it: any) => it.y > 670 && it.y < 760)
      .sort((a: any, b: any) => b.y - a.y || a.x - b.x)
      .slice(0, 80)
      .map((it: any) => it.str)
      .join(' ');
    console.log(`line: ${lineLike.slice(0, 250)}`);
  }
};

run().catch((e)=>{console.error(e); process.exit(1);});
