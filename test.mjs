import {readdir,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
await mkdir('.test-build',{recursive:true});
const tests=(await readdir('tests')).filter(f=>f.endsWith('.test.ts'));
await build({entryPoints:tests.map(f=>'tests/'+f),outdir:'.test-build',outExtension:{'.js':'.mjs'},bundle:true,packages:'external',platform:'node',target:'node20',format:'esm'});
const result=spawnSync(process.execPath,['--test',...tests.map(f=>'.test-build/'+f.replace('.ts','.mjs'))],{stdio:'inherit'});
process.exit(result.status??1);
