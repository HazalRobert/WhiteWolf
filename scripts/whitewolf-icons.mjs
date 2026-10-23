import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { brandIconSvg, ICON_VARIANTS } from '../src/brand-mark.ts';
// Rasterises the shared brand drawing (src/brand-mark.ts) into every manifest icon size, so the
// toolbar, chrome://extensions and the control-page header show the same mark.
await mkdir('public/icons',{recursive:true});
await writeFile('public/icons/whitewolf.svg',brandIconSvg(128,'large')+'\n');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), headless:true });
try {
  const page = await browser.newPage();
  for (const [size,variant] of Object.entries(ICON_VARIANTS)) {
    const data = await page.evaluate(async ({svg,size}) => {
      const image = new Image(); image.src = 'data:image/svg+xml;base64,'+btoa(svg); await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=size;
      canvas.getContext('2d').drawImage(image,0,0,size,size);
      return canvas.toDataURL('image/png').split(',')[1];
    },{svg:brandIconSvg(Number(size),variant),size:Number(size)});
    await writeFile(`public/icons/${size}.png`,Buffer.from(data,'base64'));
  }
} finally { await browser.close(); }
