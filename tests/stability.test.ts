import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, isResumableScanError } from '../src/engine';
import { emptySaved, type Repository, type Saved } from '../src/storage';
import type { Account, Adapter, FollowingPage, Relation } from '../src/types';

// 1.3 regression cases: transient interruptions, whitelist failures, uncertain recovery and run progress.
const people=(start:number,count:number)=>Array.from({length:count},(_,i)=>({id:String(start+i),handle:`user${start+i}`,name:`User ${start+i}`}));
const known=(ids:string[],followedBy=false):Relation[]=>ids.map(id=>({id,following:true,followedBy}));
class Memory implements Repository {
  data=emptySaved();
  async read(){return structuredClone(this.data);}
  async write(data:Saved){this.data=structuredClone(data);}
}
class StableAdapter implements Adapter {
  account:Account={id:'999',handle:'tester',name:'Tester'};
  connectCalls=0; identityCalls=0; cursors:string[]=[]; relationCalls:string[][]=[]; resolveCalls:string[]=[];
  writes:string[]=[]; cancelCalls=0;
  private lost:((message:string)=>void)|null=null;
  page:(cursor:string)=>Promise<FollowingPage>=async()=>({users:people(1,2),nextCursor:'0'});
  lookup:(ids:string[])=>Promise<Relation[]>=async ids=>known(ids);
  write:(id:string)=>Promise<void>=async id=>{this.writes.push(id);};
  resolver:(handle:string)=>Promise<{id:string;handle:string;name:string}>=async handle=>({id:'500',handle,name:handle});
  setSessionLostListener(listener:(message:string)=>void){this.lost=listener;}
  loseSession(message='WORKER_RESTART: Synthetic lost session'){this.lost?.(message);}
  async connect(){this.connectCalls++;return {...this.account};}
  async identity(){this.identityCalls++;return {...this.account};}
  async following(_actor:string,cursor:string){this.cursors.push(cursor);return this.page(cursor);}
  async relations(_actor:string,ids:string[]){this.relationCalls.push([...ids]);return this.lookup(ids);}
  async resolve(_actor:string,handle:string){this.resolveCalls.push(handle);return this.resolver(handle);}
  async unfollow(_actor:string,id:string){return this.write(id);}
  async followAuthor(){}
  cancel(){this.cancelCalls++;}
}
async function setup(readDelay=0){
  const adapter=new StableAdapter(),memory=new Memory();
  const c=new Controller(adapter,memory,false,readDelay);await c.initialize();
  return {adapter,memory,c};
}
const twoPages=(adapter:StableAdapter,failure:Error)=>{
  adapter.page=async cursor=>{
    if(cursor==='-1')return {users:people(1,2),nextCursor:'page-two|opaque'};
    throw failure;
  };
};

test('only transport, rate-limit and session failures are resumable scan errors',()=>{
  for(const code of ['CANCELLED','RATE_LIMIT','NETWORK','HTTP','AUTH','API_UNAVAILABLE','WORKER_RESTART','TAB_REQUIRED','TAB_PERMISSION','NOT_CONNECTED','BUSY'])
    assert.equal(isResumableScanError(`${code}: synthetic`),true,code);
  for(const code of ['SCHEMA','INCOMPLETE','ACCOUNT_CHANGED','UNCERTAIN','WHITELIST','NOT_FOUND','SKIPPED','RATE_LIMITED',''])
    assert.equal(isResumableScanError(`${code}: synthetic`),false,code);
  assert.equal(isResumableScanError('RATE_LIMIT without a colon'),false);
});

for(const code of ['RATE_LIMIT','NETWORK','HTTP','AUTH','API_UNAVAILABLE','WORKER_RESTART','TAB_REQUIRED','TAB_PERMISSION']){
  test(`${code} on a later Following page keeps committed pages and resumes the failed cursor after reconnecting`,async()=>{
    const {c,adapter}=await setup();
    twoPages(adapter,new Error(`${code}: Synthetic interruption on page two`));
    await c.scan();
    const failed=c.getSnapshot();
    assert.match(failed.error!,new RegExp(`^${code}:`));assert.equal(failed.phase,'error');assert.equal(failed.connected,false);
    assert.equal(failed.canResumeScan,true);assert.equal(failed.pages,1);assert.equal(failed.complete,false);assert.equal(failed.autoReady,false);
    assert.deepEqual(failed.rows.map(row=>row.id),['1','2']);assert.ok(failed.rows.every(row=>row.relation.following===null));
    assert.equal(adapter.cancelCalls,1);
    // A paused scan still blocks every write path until it is explicitly continued or replaced.
    await c.unfollow('1');await c.startAuto();await c.recheck('1');
    assert.equal(adapter.connectCalls,1);assert.deepEqual(adapter.writes,[]);
    adapter.page=async()=>({users:people(3,1),nextCursor:'0'});
    await c.resumeScan();
    assert.equal(adapter.connectCalls,2);assert.deepEqual(adapter.cursors,['-1','page-two|opaque','page-two|opaque']);
    const resumed=c.getSnapshot();
    assert.deepEqual(resumed.rows.map(row=>row.id),['1','2','3']);assert.equal(resumed.pages,2);assert.equal(resumed.checked,3);
    assert.equal(resumed.complete,true);assert.equal(resumed.canResumeScan,false);assert.equal(resumed.error,null);
    assert.deepEqual(adapter.writes,[]);
  });
}

for(const failure of ['SCHEMA: Synthetic invalid page','INCOMPLETE: Duplicate page','ACCOUNT_CHANGED: Synthetic switch']){
  test(`${failure.split(':')[0]} on a later page still discards the checkpoint`,async()=>{
    const {c,adapter}=await setup();
    twoPages(adapter,new Error(failure));
    await c.scan();
    assert.equal(c.getSnapshot().error,failure);assert.equal(c.getSnapshot().canResumeScan,false);
    await c.resumeScan();assert.equal(adapter.connectCalls,1);assert.deepEqual(adapter.cursors,['-1','page-two|opaque']);
  });
}

for(const failure of ['RATE_LIMIT: Viewer GET: HTTP 429','NETWORK: Synthetic connect failure','WORKER_RESTART: Synthetic restart']){
  test(`${failure.split(':')[0]} before any committed page leaves no empty resumable checkpoint`,async()=>{
    const {c,adapter}=await setup();
    adapter.connect=async()=>{adapter.connectCalls++;throw new Error(failure);};
    await c.scan();
    assert.equal(c.getSnapshot().error,failure);assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().pages,0);
    adapter.connect=async()=>{adapter.connectCalls++;return {...adapter.account};};
    await c.resumeScan();assert.equal(adapter.connectCalls,1);assert.deepEqual(adapter.cursors,[]);
    await c.scan();assert.equal(c.getSnapshot().complete,true);
  });
}

test('a rate-limited resume keeps the same checkpoint for a later attempt',async()=>{
  const {c,adapter}=await setup();
  twoPages(adapter,new Error('RATE_LIMIT: Following GET: HTTP 429; resetAt=2026-10-23T12:00:00.000Z'));
  await c.scan();await c.resumeScan();
  assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(c.getSnapshot().pages,1);
  assert.deepEqual(adapter.cursors,['-1','page-two|opaque','page-two|opaque']);
  adapter.page=async()=>({users:people(3,1),nextCursor:'0'});await c.resumeScan();
  assert.equal(c.getSnapshot().complete,true);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2','3']);
});

test('a relationship-phase network failure resumes from the first unverified batch without rereading Following',async()=>{
  const {c,adapter}=await setup();let failed=false;
  adapter.page=async()=>({users:people(1,150),nextCursor:'0'});
  adapter.lookup=async ids=>{if(ids[0]==='101'&&!failed){failed=true;throw new Error('NETWORK: Synthetic relationship transport failure');}return known(ids);};
  await c.scan();
  assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(c.getSnapshot().checked,100);
  await c.resumeScan();
  assert.deepEqual(adapter.cursors,['-1']);
  assert.deepEqual(adapter.relationCalls.map(ids=>[ids[0],ids.length]),[['1',100],['101',50],['101',50]]);
  assert.equal(c.getSnapshot().checked,150);assert.equal(c.getSnapshot().complete,true);assert.deepEqual(adapter.writes,[]);
});

test('an explicit restart replaces an interrupted checkpoint and begins at the first cursor',async()=>{
  const {c,adapter}=await setup();
  twoPages(adapter,new Error('NETWORK: Synthetic failure'));
  await c.scan();assert.equal(c.getSnapshot().canResumeScan,true);
  adapter.page=async()=>({users:people(40,1),nextCursor:'0'});await c.scan();
  assert.deepEqual(adapter.cursors,['-1','page-two|opaque','-1']);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['40']);
  assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().complete,true);
});

test('an account change on resume after an interruption clears the interrupted checkpoint and rows',async()=>{
  const {c,adapter}=await setup();
  twoPages(adapter,new Error('WORKER_RESTART: Synthetic restart'));
  await c.scan();assert.equal(c.getSnapshot().canResumeScan,true);
  adapter.account={id:'998',handle:'other',name:'Other'};await c.resumeScan();
  assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);assert.equal(c.getSnapshot().canResumeScan,false);
  assert.deepEqual(c.getSnapshot().rows,[]);assert.deepEqual(adapter.cursors,['-1','page-two|opaque']);assert.deepEqual(adapter.writes,[]);
});

test('session loss while idle keeps a paused checkpoint resumable',async()=>{
  const {c,adapter}=await setup();
  twoPages(adapter,new Error('NETWORK: Synthetic failure'));
  await c.scan();await c.connect();
  assert.equal(c.getSnapshot().connected,true);assert.equal(c.getSnapshot().canResumeScan,true);
  adapter.loseSession('TAB_REQUIRED: The selected X tab was closed.');
  assert.equal(c.getSnapshot().connected,false);assert.equal(c.getSnapshot().canResumeScan,true);
  assert.match(c.getSnapshot().error!,/^TAB_REQUIRED:/);
});

for(const failure of ['NOT_FOUND: @missing is unavailable or does not exist on X.','WHITELIST: Invalid username','NETWORK: Synthetic lookup failure']){
  test(`a failed whitelist addition (${failure.split(':')[0]}) keeps a paused scan resumable`,async()=>{
    const {c,adapter}=await setup();
    twoPages(adapter,new Error('RATE_LIMIT: Synthetic limit'));
    await c.scan();assert.equal(c.getSnapshot().canResumeScan,true);
    adapter.resolver=async()=>{throw new Error(failure);};
    await c.addWhitelist(failure.startsWith('WHITELIST')?'bad/handle':'@missing');
    assert.equal(c.getSnapshot().error,failure);assert.equal(c.getSnapshot().canResumeScan,true);assert.deepEqual(c.getSnapshot().whitelist,[]);
    adapter.page=async()=>({users:people(3,1),nextCursor:'0'});await c.resumeScan();
    assert.equal(c.getSnapshot().complete,true);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2','3']);
  });
}

test('a not-found whitelist handle keeps the live connection and saves nothing',async()=>{
  const {c,adapter,memory}=await setup();await c.scan();
  adapter.resolver=async handle=>{if(handle==='missing')throw new Error('NOT_FOUND: @missing is unavailable or does not exist on X.');return {id:'1',handle,name:handle};};
  await c.addWhitelist('@user1 @missing');
  assert.match(c.getSnapshot().error!,/^NOT_FOUND:/);assert.equal(c.getSnapshot().connected,true);assert.equal(adapter.cancelCalls,0);
  assert.deepEqual(c.getSnapshot().whitelist,[]);assert.deepEqual(memory.data.whitelists['999']??[],[]);
  await c.addWhitelist('@user1');assert.deepEqual(c.getSnapshot().whitelist,[{id:'1',handle:'user1'}]);assert.equal(c.getSnapshot().error,null);
});

test('an account change during a whitelist addition still discards a paused scan',async()=>{
  const {c,adapter}=await setup();
  twoPages(adapter,new Error('NETWORK: Synthetic failure'));
  await c.scan();adapter.account={id:'998',handle:'other',name:'Other'};
  await c.addWhitelist('@someone');
  assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);assert.equal(c.getSnapshot().canResumeScan,false);assert.deepEqual(c.getSnapshot().rows,[]);
  await c.resumeScan();assert.deepEqual(adapter.cursors,['-1','page-two|opaque']);
});

async function uncertainRow(){
  const env=await setup();await env.c.scan();
  env.adapter.write=async()=>{throw new Error('UNCERTAIN: Synthetic lost verification');};
  await env.c.unfollow('1');
  assert.equal(env.c.getSnapshot().rows[0].outcome,'uncertain');assert.deepEqual(env.memory.data.unresolved['999'],['1']);
  env.adapter.write=async id=>{env.adapter.writes.push(id);};
  env.adapter.relationCalls.length=0;
  return env;
}

test('before recheck, an uncertain row that is still followed stays blocked even after a rescan',async()=>{
  const {c,adapter}=await uncertainRow();
  await c.connect();await c.scan();
  assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');assert.equal(c.getSnapshot().rows[0].relation.following,true);
  await c.unfollow('1');c.setPacing(5,5);await c.startAuto();
  assert.deepEqual(adapter.writes,['2']);assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
});

test('recheck releases a still-followed uncertain row to pending with one fresh read and no write',async()=>{
  const {c,adapter,memory}=await uncertainRow();
  const identityBefore=adapter.identityCalls;
  await c.recheck('1');
  const row=c.getSnapshot().rows[0];
  assert.equal(row.outcome,'pending');assert.deepEqual(row.relation,{id:'1',following:true,followedBy:false});
  assert.deepEqual(adapter.relationCalls,[['1']]);assert.equal(adapter.identityCalls,identityBefore+1);assert.deepEqual(adapter.writes,[]);
  assert.deepEqual(memory.data.unresolved['999'],[]);
  assert.deepEqual(memory.data.logs.filter(entry=>entry.targetId==='1').map(entry=>entry.result),['intent','uncertain','rechecked']);
  assert.equal(c.getSnapshot().message,'statusRechecked');assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.getSnapshot().error,null);
  await c.unfollow('1');assert.deepEqual(adapter.writes,['1']);assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');
});

test('a rechecked account stays out of automatic runs until the next scan but remains manually actionable',async()=>{
  const {c,adapter,memory}=await uncertainRow();
  await c.recheck('1');
  assert.equal(c.getSnapshot().rows[0].manualOnly,true);assert.deepEqual(memory.data.unresolved['999'],[]);
  c.setPacing(5,5);await c.startAuto();
  assert.deepEqual(adapter.writes,['2']);assert.equal(c.getSnapshot().rows[0].outcome,'pending');
  await c.unfollow('1');assert.deepEqual(adapter.writes,['2','1']);assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');
});

test('a new scan clears the manual-only mark of a rechecked account',async()=>{
  const {c,adapter}=await uncertainRow();
  await c.recheck('1');assert.equal(c.getSnapshot().rows[0].manualOnly,true);
  await c.scan();
  assert.equal(c.getSnapshot().rows[0].manualOnly,undefined);assert.equal(c.getSnapshot().rows[0].outcome,'pending');
  c.setPacing(5,1);await c.startAuto();assert.deepEqual(adapter.writes,['1']);
});

test('recheck confirms an uncertain unfollow that actually reached X',async()=>{
  const {c,adapter,memory}=await uncertainRow();
  adapter.lookup=async ids=>ids.map(id=>({id,following:false,followedBy:false}));
  await c.recheck('1');
  assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');assert.equal(c.getSnapshot().rows[0].relation.following,false);
  assert.deepEqual(memory.data.unresolved['999'],[]);assert.equal(memory.data.logs.at(-1)!.result,'verified');
  assert.equal(c.getSnapshot().message,'statusRecheckUnfollowed');assert.deepEqual(adapter.writes,[]);
});

test('recheck marks an uncertain account that now follows back as skipped',async()=>{
  const {c,adapter,memory}=await uncertainRow();
  adapter.lookup=async ids=>known(ids,true);
  await c.recheck('1');
  assert.equal(c.getSnapshot().rows[0].outcome,'skipped');assert.equal(c.getSnapshot().rows[0].relation.followedBy,true);
  assert.deepEqual(memory.data.unresolved['999'],[]);assert.equal(memory.data.logs.at(-1)!.result,'skipped');assert.deepEqual(adapter.writes,[]);
});

for(const relation of [{following:null,followedBy:false},{following:true,followedBy:null},{following:'true',followedBy:false}]){
  test(`recheck with an unknown fresh relationship ${JSON.stringify(relation)} keeps the row uncertain`,async()=>{
    const {c,adapter,memory}=await uncertainRow();
    adapter.lookup=async ids=>ids.map(id=>({id,...relation}) as never);
    await c.recheck('1');
    assert.match(c.getSnapshot().error!,/^SCHEMA: Current relationship unknown/);assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
    assert.deepEqual(memory.data.unresolved['999'],['1']);assert.deepEqual(adapter.writes,[]);
  });
}

test('recheck ignores rows that are not uncertain and never reads for them',async()=>{
  const {c,adapter}=await setup();await c.scan();adapter.relationCalls.length=0;
  await c.recheck('1');await c.recheck('missing');
  assert.deepEqual(adapter.relationCalls,[]);assert.equal(c.getSnapshot().rows[0].outcome,'pending');assert.deepEqual(adapter.writes,[]);
});

test('recheck detects an account change before reading the target',async()=>{
  const {c,adapter}=await uncertainRow();
  adapter.account={id:'998',handle:'other',name:'Other'};
  await c.recheck('1');
  assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);assert.deepEqual(adapter.relationCalls,[]);assert.deepEqual(c.getSnapshot().rows,[]);
});

test('automatic progress counts processed rows, announces the next pacing deadline and clears afterwards',{timeout:3000},async()=>{
  const {c}=await setup(),progress:Array<{total:number;processed:number;next:boolean}>=[];
  await c.scan();c.setPacing(5,3);
  const unsubscribe=c.subscribe(()=>{
    const value=c.getSnapshot().runProgress;
    if(value&&progress.at(-1)?.processed!==value.processed){
      progress.push({total:value.total,processed:value.processed,next:value.nextAt!==null});
      if(value.nextAt!==null){assert.ok(value.nextAt>Date.now());setImmediate(()=>c.pause());}
    }
  });
  try{await c.startAuto();}finally{unsubscribe();}
  assert.deepEqual(progress,[{total:2,processed:0,next:false},{total:2,processed:1,next:true}]);
  assert.equal(c.getSnapshot().runProgress,null);assert.equal(c.getSnapshot().phase,'paused');
});

test('a completed automatic run reports full progress before clearing it',async()=>{
  const {c,adapter}=await setup(),seen:number[]=[];
  await c.scan();c.setPacing(5,1);
  const unsubscribe=c.subscribe(()=>{const value=c.getSnapshot().runProgress;if(value)seen.push(value.processed);});
  try{await c.startAuto();}finally{unsubscribe();}
  assert.deepEqual([...new Set(seen)],[0,1]);assert.equal(c.getSnapshot().runProgress,null);assert.deepEqual(adapter.writes,['1']);
});
