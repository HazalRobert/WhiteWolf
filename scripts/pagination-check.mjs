import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fixtureCursor,installXFixture} from './x-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),[beforeDist,afterDist,fixturePath]=process.argv.slice(2);
if(!fixturePath)throw Error('Usage: pagination-check.mjs before-dist after-dist public-following.json');
const fixtureBytes=await readFile(fixturePath),payload=JSON.parse(fixtureBytes);
const instructions=payload.data.user.result.timeline.timeline.instructions;
const publicBottom=instructions.flatMap(instruction=>instruction.entries||[]).find(entry=>entry.content?.cursorType==='Bottom')?.content.value;
assert.equal(fixtureCursor,publicBottom,'Use the independently downloaded public cursor value exactly.');
const report={at:new Date().toISOString(),source:'https://github.com/vladkens/twscrape/blob/568844df82af956df5970bcf7ff84dd5ba729eb0/tests/mocked-data/raw_following.json',fixtureSha256:createHash('sha256').update(fixtureBytes).digest('hex'),cursor:publicBottom,scope:'A synthetic two-page scan uses the exact cursor format from a pinned public response. The original public response also terminates Bottom; it is not claimed to be a two-page capture. All X traffic intercepted. No real account requests or writes.',cases:[]};
await mkdir('qa',{recursive:true});
for(const [label,dist]of [['before',beforeDist],['after',afterDist]]){
  const extension=path.join(root,`qa-pagination-${label}-${Date.now()}`);await cp(dist,extension,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['https://x.com/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const context=await chromium.launchPersistentContext(path.join(root,`qa-pagination-profile-${label}-${Date.now()}`),{executablePath:process.env.BROWSER_EXECUTABLE||chromium.executablePath(),headless:true,viewport:{width:1100,height:920},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const fixture=await installXFixture(context);fixture.state.multiPage=true;
    const xpage=await context.newPage();await xpage.goto('https://x.com/home');
    let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    const ui=await context.newPage();await ui.goto(`chrome-extension://${extensionId}/index.html`);
    await ui.locator('.language-picker select').selectOption('zh-CN');
    await ui.getByRole('button',{name:'连接 X 账号',exact:true}).first().click();await ui.locator('.connected-indicator').waitFor();
    await ui.getByRole('button',{name:'扫描关注列表',exact:true}).click();
    if(label==='before')await ui.locator('[role=alert] code').waitFor();
    else {await ui.getByText('Fixture Chen',{exact:true}).waitFor();await ui.waitForFunction(()=>!document.querySelector('.spin'));}
    const state=await ui.evaluate(()=>({connected:!!document.querySelector('.connected-indicator'),error:document.querySelector('[role=alert] code')?.textContent||null,rows:document.querySelectorAll('.person-row').length}));
    const pages=fixture.requests.filter(request=>request.operation==='Following');
    if(label==='before'){assert.equal(state.error,'SCHEMA: Missing pagination cursor');assert.equal(pages.length,1);assert.equal(state.rows,0);}
    else {assert.equal(state.error,null);assert.equal(state.connected,true);assert.equal(state.rows,2);assert.equal(pages.length,2);assert.equal(pages[1].variables.cursor,publicBottom);}
    assert.equal(fixture.writes.length,0);assert.deepEqual(fixture.violations,[]);
    report.cases.push({label,version:manifest.version,...state,pages,writes:fixture.writes.length,passed:true});
    await ui.screenshot({path:`qa/pagination-${label}.png`,fullPage:true});
  }finally{await context.close();}
}
report.passed=report.cases.length===2&&report.cases.every(test=>test.passed);
await writeFile('qa/pagination-regression.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
