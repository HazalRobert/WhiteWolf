import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {installXFixture} from './x-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd();
const label=process.argv[2]||'after';
const baseline=label==='before';
const dist=process.argv[3]||'dist';
const executablePath=process.env.BROWSER_EXECUTABLE||chromium.executablePath();
const observationMs=Number(process.env.LIFECYCLE_OBSERVATION_MS||65000);
const report={at:new Date().toISOString(),label,observationMs,network:'All external requests intercepted by synthetic X fixture; no real account requests or writes.',boundary:'No worker.evaluate or Chrome API polling during idle observation; only extension-page DOM is sampled. Playwright attaches to workers internally, so this does not establish uninstrumented Chrome idle suspension. Worker shutdown is then forced through CDP only inside the isolated test browser. Test-only host permission replaces toolbar activation.',cases:[]};
await mkdir('qa',{recursive:true});
async function scenario(kind){
  const extension=path.join(root,`qa-lifecycle-${label}-${kind}-${Date.now()}`);
  await cp(dist,extension,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions=['https://x.com/*'];
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const context=await chromium.launchPersistentContext(path.join(root,`qa-lifecycle-profile-${label}-${kind}-${Date.now()}`),{executablePath,headless:true,viewport:{width:1100,height:920},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const result={kind,version:manifest.version,samples:[],passed:false};report.cases.push(result);
  try{
    const fixture=await installXFixture(context);
    const xpage=await context.newPage();await xpage.goto('https://x.com/home');
    let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    const ui=await context.newPage();await ui.goto(`chrome-extension://${extensionId}/index.html`);
    await ui.locator('.language-picker select').selectOption('zh-CN');
    await ui.getByRole('button',{name:'连接 X 账号',exact:true}).first().click();
    await ui.locator('.connected-indicator').waitFor();
    if(kind==='schema'){
      fixture.state.unsupportedInstruction=true;
      await ui.getByRole('button',{name:'扫描关注列表',exact:true}).click();
      await ui.locator('[role=alert] code').waitFor();
      result.originalError=await ui.locator('[role=alert] code').textContent();
      assert.ok(result.originalError.startsWith('SCHEMA: Unsupported Following timeline instruction;'));
    }
    const requestsAtStart=fixture.requests.length;
    const started=Date.now();
    for(let index=0;index<=Math.ceil(observationMs/5000);index++){
      if(index)await new Promise(resolve=>setTimeout(resolve,5000));
      const state=await ui.evaluate(()=>({connected:!!document.querySelector('.connected-indicator'),error:document.querySelector('[role=alert] code')?.textContent||null,rows:document.querySelectorAll('.person-row').length}));
      result.samples.push({elapsedMs:Date.now()-started,...state});
      console.log(label,kind,Math.round((Date.now()-started)/1000)+'s',state.connected?'connected':state.error||'disconnected');
    }
    result.observationRequests=fixture.requests.length-requestsAtStart;
    assert.equal(result.observationRequests,0,'Idle control heartbeats must never request X');
    assert.equal(fixture.writes.length,0,'Lifecycle checks must never mutate a relationship');
    const last=result.samples.at(-1);
    if(baseline){
      result.reproduced=kind==='idle'?!last.connected&&last.error?.startsWith('WORKER_RESTART:'):last.error?.startsWith('WORKER_RESTART:');
      // Record natural suspension without asserting it: automation may keep the
      // worker attached. Controlled teardown below isolates the lifecycle logic.
    }else if(kind==='idle'){
      assert.ok(result.samples.every(sample=>sample.connected&&!sample.error),'Connected control must survive all 65 idle seconds');
      await ui.getByRole('button',{name:'扫描关注列表',exact:true}).click();
      await ui.getByText('Fixture Alice',{exact:true}).waitFor();
      result.scanAfterIdle=true;
      assert.equal(fixture.writes.length,0);
    }else{
      assert.ok(result.samples.every(sample=>!sample.connected&&sample.error===result.originalError),'Original schema failure must survive later worker teardown');
      assert.equal(last.rows,0);
    }
    const cdp=await context.newCDPSession(ui);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    if(kind==='idle'||baseline)await ui.waitForFunction(()=>document.querySelector('[role=alert] code')?.textContent?.startsWith('WORKER_RESTART:'),{},{timeout:10000});
    else await new Promise(resolve=>setTimeout(resolve,1500));
    result.afterForcedStop=await ui.evaluate(()=>({connected:!!document.querySelector('.connected-indicator'),error:document.querySelector('[role=alert] code')?.textContent||null,rows:document.querySelectorAll('.person-row').length}));
    assert.equal(result.afterForcedStop.connected,false);
    if(kind==='schema'&&!baseline)assert.equal(result.afterForcedStop.error,result.originalError,'Original SCHEMA error must survive actual worker shutdown');
    else assert.ok(result.afterForcedStop.error.startsWith('WORKER_RESTART:'));
    const requestsAfterStop=fixture.requests.length;
    await new Promise(resolve=>setTimeout(resolve,1500));
    assert.equal(fixture.requests.length,requestsAfterStop,'Worker shutdown must never reconnect or resume requests');
    assert.equal(fixture.writes.length,0);
    assert.deepEqual(fixture.violations,[]);
    result.requests=fixture.requests;
    result.writes=fixture.writes;
    result.passed=true;
    await ui.screenshot({path:`qa/lifecycle-${label}-${kind}.png`,fullPage:true});
  }catch(error){result.error=error.stack;throw error;}
  finally{await context.close();}
}
const settled=await Promise.allSettled([scenario('idle'),scenario('schema')]);
report.passed=settled.every(result=>result.status==='fulfilled');
await writeFile(`qa/lifecycle-${label}.json`,JSON.stringify(report,null,2));
assert.ok(report.passed,JSON.stringify(report.cases.map(({kind,error})=>({kind,error})),null,2));
console.log('PASS',label,'both MV3 lifecycle cases, observation',observationMs,'ms');
