import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixtureActor, fixtureIds, fixtureCursor, installXFixture, restrictToLocalOrigin } from './x-fixture.mjs';
const root=process.cwd();
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const executablePath=process.env.BROWSER_EXECUTABLE||chromium.executablePath();
const report={at:new Date().toISOString(),network:'All X traffic intercepted by local synthetic fixtures; no real account or external API calls',tests:[],screenshots:[],errors:[]};
const check=(name,value=true)=>{assert.ok(value,name);report.tests.push(name);console.log('PASS',name)};
await mkdir('qa',{recursive:true});
const server=createServer(async(req,res)=>{try{let file=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(file==='/')file='/index.html';const target=path.join(root,'dist',file);if(!target.startsWith(path.join(root,'dist')))throw Error();const body=await readFile(target);const ext=path.extname(target);res.setHeader('Content-Type',({'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png'})[ext]||'application/octet-stream');res.end(body);}catch{res.statusCode=404;res.end('not found')}});
await new Promise(resolve=>server.listen(4173,'127.0.0.1',resolve));
let browser,context;
try{
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage({viewport:{width:1100,height:920}});
  const demoNetwork=await restrictToLocalOrigin(page.context(),'http://127.0.0.1:4173');
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto('http://127.0.0.1:4173');
  await page.getByText('Alex Morgan',{exact:true}).waitFor();
  check('Demo renders populated synthetic data');
  check('Manual mode hides whitelist setup',await page.locator('.whitelist-card').count()===0);
  for(const language of ['zh-CN','en','fr','es','ru','de','pt','ja','ko','ar']){
    await page.locator('.language-picker select').selectOption(language);
    await page.waitForTimeout(40);
    check('Language '+language+' renders without horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    if(language==='ar'){
      check('Arabic uses RTL layout',await page.locator('main').getAttribute('dir')==='rtl');
      await page.screenshot({path:'qa/arabic-desktop.png',fullPage:true});
    }
  }
  await page.locator('.language-picker select').selectOption('zh-CN');
  await page.screenshot({path:'qa/manual-desktop.png',fullPage:true});
  report.screenshots.push('manual-desktop.png','arabic-desktop.png');
  await page.getByRole('tab',{name:'自动模式'}).click();
  await page.screenshot({path:'qa/automatic-desktop.png',fullPage:true});
  report.screenshots.push('automatic-desktop.png');
  await page.setViewportSize({width:520,height:900});
  check('520px automatic layout has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.screenshot({path:'qa/automatic-compact.png',fullPage:true});report.screenshots.push('automatic-compact.png');
  await page.setViewportSize({width:360,height:800});
  check('360px layout has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  demoNetwork.assertIsolated();check('Demo requests remain on the exact local origin');
  await browser.close();browser=null;

  // The test-only copy grants the fixture origin so automation need not click browser toolbar UI.
  // Delivery has activeTab+scripting+storage and optional x.com access, no required host_permissions.
  const testExtension=path.join(root,'qa-extension');await cp('dist',testExtension,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(testExtension,'manifest.json'),'utf8'));
  manifest.host_permissions=['https://x.com/*'];await writeFile(path.join(testExtension,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(path.join(root,'qa-profile-'+Date.now()),{executablePath,headless:true,viewport:{width:1100,height:920},args:[`--disable-extensions-except=${testExtension}`,`--load-extension=${testExtension}`]});
  const fixture=await installXFixture(context);const {writes,following}=fixture;
  report.fixture={requests:fixture.requests,violations:fixture.violations};
  const xpage=await context.newPage();await xpage.goto('https://x.com/home');
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host;
  const tabId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://x.com/*'});return tabs[0].id});
  const ui=await context.newPage();ui.on('pageerror',e=>report.errors.push(e.message));
  await ui.goto(`chrome-extension://${extensionId}/index.html?tab=${tabId}`);
  report.disconnectedLayouts=[];
  for(const width of [1100,800,520,360]){
    await ui.setViewportSize({width,height:920});
    for(const language of ['zh-CN','en','fr','es','ru','de','pt','ja','ko','ar']){
      await ui.locator('.language-picker select').selectOption(language);
      const fits=await ui.evaluate(()=>{
        const boxes=[...document.querySelectorAll('.app-header > *')].map(e=>e.getBoundingClientRect());
        const overlap=boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
        return document.documentElement.scrollWidth<=innerWidth&&!overlap;
      });
      report.disconnectedLayouts.push({width,language,fits});
      assert.ok(fits,`Disconnected header overflows: ${width}/${language}`);
    }
  }
  check('Disconnected account header fits 10 languages at 4 widths');
  await ui.setViewportSize({width:1100,height:920});
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.screenshot({path:'qa/disconnected-desktop.png',fullPage:true});
  await ui.getByRole('button',{name:'连接 X 账号',exact:true}).first().click();
  await ui.getByText('@qa_owner',{exact:true}).waitFor();
  check('Real MV3 worker connects through page adapter to isolated X fixture');
  check('Connected idle header shows connected status',await ui.locator('.connected-indicator').innerText().then(text=>text.trim()==='已连接'));
  report.connectedIdleLayouts=[];
  for(const width of [1100,800,520,360]){
    await ui.setViewportSize({width,height:920});
    for(const language of ['zh-CN','en','fr','es','ru','de','pt','ja','ko','ar']){
      await ui.locator('.language-picker select').selectOption(language);
      const fits=await ui.evaluate(()=>{
        const boxes=[...document.querySelectorAll('.app-header > *')].map(e=>e.getBoundingClientRect());
        return document.documentElement.scrollWidth<=innerWidth&&!boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
      });
      report.connectedIdleLayouts.push({width,language,fits});
      assert.ok(fits,`Connected idle header overflows: ${width}/${language}`);
    }
  }
  check('Connected idle header fits 10 languages at 4 widths');
  await ui.setViewportSize({width:1100,height:920});
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.getByRole('button',{name:'扫描关注列表',exact:true}).click();
  await ui.getByText('Fixture Alice',{exact:true}).waitFor();
  check('Mutual accounts are excluded from actionable list',await ui.getByText('Fixture Bob',{exact:true}).count()===0);
  check('Scanning never sends relationship mutations',writes.length===0);
  check('ClearCache plus Bottom termination accepts users and never follows the retained cursor',fixture.requests.filter(request=>request.operation==='Following').length===1);
  fixture.state.multiPage=true;
  const paginationStart=fixture.requests.length;
  await ui.getByRole('button',{name:'重新扫描',exact:true}).click();
  await ui.getByText('Fixture Chen',{exact:true}).waitFor();
  await ui.waitForFunction(()=>!document.querySelector('.spin'));
  const pageRequests=fixture.requests.slice(paginationStart).filter(request=>request.operation==='Following');
  check('Two-page scan preserves the public pipe cursor through UI, worker, page adapter and encoded GraphQL request',pageRequests.length===2&&pageRequests[0].variables.cursor===undefined&&pageRequests[1].variables.cursor===fixtureCursor);
  check('Two-page scan completes with both non-mutual accounts and no relationship writes',await ui.locator('.person-row').count()===2&&await ui.locator('[role=alert]').count()===0&&writes.length===0);
  fixture.state.multiPage=false;
  await ui.getByRole('tab',{name:'自动模式'}).click();
  await ui.locator('.whitelist-form input').fill('@fixture_alice');
  await ui.locator('.whitelist-form button').click();
  await ui.locator('.whitelist-chip').filter({hasText:'fixture_alice'}).waitFor();
  await ui.locator('.pacing-fields input').nth(1).fill('1');
  await ui.getByRole('button',{name:'预览自动处理',exact:true}).click();
  await ui.locator('dialog .button-primary').click();
  await ui.locator('.row-status.success').first().waitFor({timeout:15000});
  await ui.waitForFunction(()=>!document.querySelector('.spin'));
  check('Automatic run excludes whitelist and performs exactly one verified mutation',writes.length===1&&writes[0].id===fixtureIds.chen);
  check('Protected candidate remains followed',following.has(fixtureIds.alice));
  await ui.getByRole('button',{name:'关注 @MagicalStocker',exact:true}).click();
  await ui.waitForTimeout(600);
  check('Explicit author button follows only MagicalStocker',writes.length===2&&writes[1].action==='follow'&&writes[1].id===fixtureIds.author);
  await ui.getByRole('tab',{name:'手动模式'}).click();
  await ui.locator('.person-row').filter({hasText:'Fixture Alice'}).getByRole('button',{name:'取消关注',exact:true}).click();
  check('Manual click opens confirmation before writing',writes.length===2&&await ui.locator('dialog').isVisible());
  await ui.locator('dialog .button-danger').click();
  await ui.waitForFunction(()=>document.querySelectorAll('.row-status.success').length===2);
  check('Manual confirmation can process a whitelisted account',writes.length===3&&writes[2].id===fixtureIds.alice);
  const storage=await worker.evaluate(()=>chrome.storage.local.get(null));
  check('No CSRF or session cookies are persisted',!JSON.stringify(storage).includes('synthetic-fixture-not-a-secret')&&!JSON.stringify(storage).includes('u%3D'+fixtureActor.id));
  fixture.assertTraffic();check('All four GraphQL read operations use exact routes and native filtered headers');
  check('No legacy REST GET requests; relationship mutations use POST only');
  const before=writes.length;fixture.state.limited=true;
  await ui.getByRole('button',{name:'重新扫描',exact:true}).click();
  await ui.locator('[role=alert]').waitFor();
  check('429 surfaces an error without issuing new mutations',writes.length===before);
  fixture.assertTraffic();check('Rate-limit scenario preserves strict request methods and network isolation');
  await ui.screenshot({path:'qa/extension-fixture-rate-limit.png',fullPage:true});
  fixture.state.limited=false;
  await ui.getByRole('button',{name:'连接 X 账号',exact:true}).first().click();
  await ui.locator('.connected-indicator').waitFor();
  fixture.state.unsupportedInstruction=true;
  // A new scan clears the old timestamp even if connection preparation fails.
  // After reconnecting, the same primary action can correctly be labelled Scan.
  await ui.getByTestId('scan-start').click();
  await ui.locator('[role=alert] code').waitFor();
  check('Unsupported instruction exposes bounded type and index in automatically expanded details',await ui.locator('[role=alert] details').getAttribute('open')!==null&&await ui.locator('[role=alert] code').textContent()==='SCHEMA: Unsupported Following timeline instruction; type=TimelinePinEntry; index=4.');
  check('Unsupported instruction stops scan with no partial actionable users or new mutations',await ui.locator('.person-row').count()===0&&writes.length===before);
  await ui.screenshot({path:'qa/schema-diagnostic.png',fullPage:true});report.screenshots.push('schema-diagnostic.png');
  await ui.close();fixture.state.unsupportedInstruction=false;

  const entry=await context.newPage();entry.on('pageerror',e=>report.errors.push(e.message));
  await entry.goto(`chrome-extension://${extensionId}/index.html`);
  await entry.locator('.language-picker select').selectOption('zh-CN');
  check('Control page displays the installed manifest version',await entry.locator('.footer-version').innerText().then(t=>t.includes('v'+manifest.version)));
  await entry.getByRole('button',{name:'连接 X 账号',exact:true}).click();
  await entry.getByText('@qa_owner',{exact:true}).waitFor();
  check('Direct-open control page discovers and connects its sole X tab with a pregranted host permission',writes.length===before);
  await xpage.reload();
  await entry.getByRole('button',{name:'连接 X 账号',exact:true}).waitFor();
  check('Reloading the selected X tab immediately disconnects an idle control page');
  await entry.close();

  const secondX=await context.newPage();await secondX.goto('https://x.com/home?fixture=second');
  const chooser=await context.newPage();chooser.on('pageerror',e=>report.errors.push(e.message));
  await chooser.goto(`chrome-extension://${extensionId}/index.html`);
  await chooser.locator('.language-picker select').selectOption('zh-CN');
  const requestsBefore=fixture.requests.length;
  await chooser.getByRole('button',{name:'连接 X 账号',exact:true}).click();
  await chooser.locator('.tab-choice').first().waitFor();
  check('Multiple X tabs require selection before any account request',await chooser.locator('.tab-choice').count()===2&&fixture.requests.length===requestsBefore&&await chooser.locator('dialog .button-primary').isDisabled());
  await chooser.setViewportSize({width:360,height:800});
  check('Tab selection dialog fits a 360px control window',await chooser.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await chooser.screenshot({path:'qa/tab-selection-compact.png',fullPage:true});report.screenshots.push('tab-selection-compact.png');
  await chooser.locator('.tab-choice').filter({hasText:'https://x.com/home?fixture=second'}).click();
  await secondX.close();
  await chooser.locator('dialog .button-primary').click();
  await chooser.locator('[role=alert]').waitFor();
  check('Closing the selected tab before confirmation reports TAB_REQUIRED without account requests',await chooser.locator('[role=alert] code').textContent().then(t=>t?.startsWith('TAB_REQUIRED:'))&&fixture.requests.length===requestsBefore);
  await chooser.getByRole('button',{name:'连接 X 账号',exact:true}).click();
  await chooser.getByText('@qa_owner',{exact:true}).waitFor();
  check('Explicit reconnect recovers the remaining X tab without changing relationships',writes.length===before);
  await chooser.close();await xpage.close();

  const empty=await context.newPage();empty.on('pageerror',e=>report.errors.push(e.message));
  await empty.goto(`chrome-extension://${extensionId}/index.html`);
  await empty.locator('.language-picker select').selectOption('zh-CN');
  await empty.getByRole('button',{name:'连接 X 账号',exact:true}).click();
  await empty.locator('[role=alert]').waitFor();
  check('No X tab produces a page-selection error instead of an expired-login error',await empty.locator('[role=alert] code').textContent().then(t=>t?.startsWith('TAB_REQUIRED:')));
  await empty.screenshot({path:'qa/connect-no-x.png',fullPage:true});report.screenshots.push('connect-no-x.png');
  // Chrome-created tabs can navigate before Playwright attaches routing. Capture the
  // requested URL and create about:blank, then navigate through the fixture explicitly.
  await empty.evaluate(()=>{
    const create=chrome.tabs.create.bind(chrome.tabs);
    window.__fixtureRequestedTabUrl=null;
    chrome.tabs.create=options=>{window.__fixtureRequestedTabUrl=options.url;return create({...options,url:'about:blank'});};
  });
  const newXPromise=context.waitForEvent('page',{timeout:15000});
  await empty.getByRole('button',{name:'打开 X',exact:true}).click();
  const newX=await newXPromise;
  check('Open X button requests the correct URL without connecting or writing',await empty.evaluate(()=>window.__fixtureRequestedTabUrl)==='https://x.com/home'&&await empty.getByRole('button',{name:'连接 X 账号',exact:true}).isVisible()&&writes.length===before);
  await newX.goto('https://x.com/home');
  report.openXNavigation='Initial Chrome-created navigation replaced with about:blank to ensure fixture routing; the UI-requested URL is asserted separately.';
  await empty.getByRole('button',{name:'连接 X 账号',exact:true}).click();
  await empty.getByText('@qa_owner',{exact:true}).waitFor();
  check('A later explicit Connect establishes the newly opened fixture session',writes.length===before);
  fixture.assertTraffic();check('All added entry scenarios preserve exact request routing and zero extra mutations');
  await empty.close();
  // Remove only the isolated fixture's own marker to exercise the complete diagnostic path.
  await newX.evaluate(()=>{delete document.getElementById('react-root').__reactContainer$synthetic_fixture;});
  const diagnosticPage=await context.newPage();diagnosticPage.on('pageerror',e=>report.errors.push(e.message));
  await diagnosticPage.goto(`chrome-extension://${extensionId}/index.html`);
  await diagnosticPage.locator('.language-picker select').selectOption('zh-CN');
  const beforeDiagnostic=fixture.requests.length;
  await diagnosticPage.getByRole('button',{name:'连接 X 账号',exact:true}).click();
  await diagnosticPage.locator('[role=alert] code').waitFor();
  const diagnostic=await diagnosticPage.locator('[role=alert] code').textContent();
  check('Native discovery stage survives page-to-worker-to-UI serialization',diagnostic?.includes('stage=rootMarker;')&&diagnostic.includes('rootMarkers=0;'));
  check('Discovery diagnostics contain no session values and issue no requests',!diagnostic?.includes('synthetic-fixture-not-a-secret')&&!diagnostic?.includes('Bearer')&&fixture.requests.length===beforeDiagnostic&&writes.length===before);
  await diagnosticPage.screenshot({path:'qa/connection-diagnostic.png',fullPage:true});report.screenshots.push('connection-diagnostic.png');
  check('No browser runtime exceptions',report.errors.length===0);
  await context.close();context=null;
}catch(error){report.failure=error.stack||String(error);console.error(report.failure);if(context){for(const p of context.pages()){if(p.url().startsWith('chrome-extension:'))await p.screenshot({path:'qa/failure.png',fullPage:true}).catch(()=>{});}}process.exitCode=1;}
finally{if(browser)await browser.close();if(context)await context.close();server.close();await writeFile('qa/browser-report.json',JSON.stringify(report,null,2));}
