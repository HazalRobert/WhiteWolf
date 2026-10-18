import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
await viteBuild({base:'./', build:{outDir:'dist',emptyOutDir:true,target:'chrome120'}});
await build({entryPoints:['src/background.ts'],outfile:'dist/background.js',bundle:true,format:'esm',platform:'browser',target:'chrome120'});
await build({entryPoints:['src/x-page.ts'],outfile:'dist/x-page.js',bundle:true,format:'iife',platform:'browser',target:'chrome120'});
