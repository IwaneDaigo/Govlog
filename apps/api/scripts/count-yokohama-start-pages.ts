import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = resolve('C:/VsCodeProject/Huckkason/02_R7digital-yokohama.pdf');
const data = new Uint8Array(readFileSync(input));

const run = async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, disableWorker: true } as any).promise;
  let count = 0;
  const pages:number[] = [];
  for (let p=1;p<=doc.numPages;p++){
    const page = await doc.getPage(p);
    const t = await page.getTextContent();
    const text = t.items.map((it:any)=>('str' in it ? (it.str||'') : '')).join(' ').replace(/\s+/g,' ').trim();
    if (/令和[6６]年度\s*事業名/.test(text)) {count++; pages.push(p);}    
  }
  console.log({count,pages});
};
run().catch((e)=>{console.error(e);process.exit(1);});
