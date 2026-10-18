import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
// Code-native vector mark. A filled blue tile remains visible on both light and
// dark browser chrome; the 16px version omits details that cannot survive rasterization.
const mark = (compact = false) => `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 32 32">
<rect x=".5" y=".5" width="31" height="31" rx="7" fill="#1468df"/>
<path d="M5 4 12 8.5Q16 7 20 8.5L27 4 26 15.5 28 19 24.5 20.5 24 24 16 29 8 24 7.5 20.5 4 19 6 15.5Z" fill="#fff"/>
<path d="m7.5 8 3.8 3-3.5 2ZM24.5 8l-3.8 3 3.5 2Z" fill="#153451"/>
${compact ? '' : '<path d="M8 13.5 16 18l8-4.5-3 9L16 27l-5-4.5Z" fill="#e3effb"/>'}
<path d="m8 15 6 1.5-1.5 2-3-1ZM24 15l-6 1.5 1.5 2 3-1Z" fill="#153451"/>
<path d="M12.7 22Q16 20.5 19.3 22L16 25.5Z" fill="#153451"/>
</svg>`;
const svg = mark();
await mkdir('public/icons',{recursive:true});
await writeFile('public/icons/whitewolf.svg',svg);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), headless:true });
try {
  const page = await browser.newPage();
  for (const size of [16,20,24,32,48,128]) {
    const data = await page.evaluate(async ({svg,size}) => {
      const image = new Image(); image.src = 'data:image/svg+xml;base64,'+btoa(svg); await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=size;
      canvas.getContext('2d').drawImage(image,0,0,size,size);
      return canvas.toDataURL('image/png').split(',')[1];
    },{svg:mark(size <= 20),size});
    await writeFile(`public/icons/${size}.png`,Buffer.from(data,'base64'));
  }
} finally { await browser.close(); }
