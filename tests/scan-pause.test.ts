import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/engine';
import { emptySaved, type Repository, type Saved } from '../src/storage';
import type { Account, Adapter, FollowingPage, Mode, Relation } from '../src/types';

function deferred<T>() {
  let resolve!: (value:T|PromiseLike<T>)=>void, reject!: (error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const people=(start:number,count:number)=>Array.from({length:count},(_,i)=>({id:String(start+i),handle:`user${start+i}`,name:`User ${start+i}`}));
const known=(ids:string[]):Relation[]=>ids.map(id=>({id,following:true,followedBy:false}));
class Memory implements Repository {
  data=emptySaved();
  async read(){return structuredClone(this.data);}
  async write(data:Saved){this.data=structuredClone(data);}
}
class ScanAdapter implements Adapter {
  account:Account={id:'999',handle:'tester',name:'Tester'};
  connectCalls=0; identityCalls:string[]=[]; cursors:string[]=[]; relationCalls:string[][]=[];
  writes:string[]=[]; authorCalls=0; cancelCalls=0;
  private lost:((message:string)=>void)|null=null;
  page:(_cursor:string)=>Promise<FollowingPage>=async()=>({users:people(1,2),nextCursor:'0'});
  lookup:(ids:string[])=>Promise<Relation[]>=async ids=>known(ids);
  setSessionLostListener(listener:(message:string)=>void){this.lost=listener;}
  loseSession(message='WORKER_RESTART: Synthetic lost session'){this.lost?.(message);}
  async connect(){this.connectCalls++;return {...this.account};}
  async identity(actor:string){this.identityCalls.push(actor);return {...this.account};}
  async following(_actor:string,cursor:string){this.cursors.push(cursor);return this.page(cursor);}
  async relations(_actor:string,ids:string[]){this.relationCalls.push([...ids]);return this.lookup(ids);}
  async resolve(_actor:string,handle:string){return {id:'12345',handle,name:handle};}
  async unfollow(_actor:string,id:string){this.writes.push(id);}
  async followAuthor(){this.authorCalls++;}
  cancel(){this.cancelCalls++;}
}
async function setup(mode:Mode='manual',readDelay=0){
  const adapter=new ScanAdapter(),memory=new Memory();memory.data.settings.mode=mode;
  const controller=new Controller(adapter,memory,false,readDelay);await controller.initialize();
  return {adapter,memory,c:controller};
}
async function pendingSecondPage(mode:Mode='manual'){
  const env=await setup(mode),entered=deferred<void>(),reply=deferred<FollowingPage>();
  env.adapter.page=async cursor=>{
    if(cursor==='-1')return {users:people(1,2),nextCursor:'page-two|opaque'};
    entered.resolve();return reply.promise;
  };
  const running=env.c.scan();await entered.promise;
  return {...env,entered,reply,running};
}

for(const mode of ['manual','auto'] as const){
  test(`${mode}: pending pagination pauses immediately, ignores late response, then resumes the uncommitted cursor`,async()=>{
    const {c,adapter,reply,running}=await pendingSecondPage(mode);
    assert.equal(c.getSnapshot().activeOperation,'scan');
    c.pause();
    assert.equal(c.getSnapshot().connected,false);assert.equal(c.getSnapshot().pausePending,true);
    assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().pages,1);
    await c.resumeScan();await c.scan();await c.startAuto();
    assert.equal(adapter.connectCalls,1);assert.deepEqual(adapter.cursors,['-1','page-two|opaque']);
    reply.resolve({users:people(3,1),nextCursor:'0'});await running;
    assert.equal(c.getSnapshot().phase,'paused');assert.equal(c.getSnapshot().pausePending,false);
    assert.equal(c.getSnapshot().activeOperation,null);assert.equal(c.getSnapshot().canResumeScan,true);
    assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().checked,0);
    assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2']);assert.deepEqual(adapter.relationCalls,[]);
    adapter.page=async()=>({users:[...people(2,1),...people(3,1)],nextCursor:'0'});
    await c.resumeScan();
    assert.equal(adapter.connectCalls,2);assert.deepEqual(adapter.identityCalls,['999','999','999']);
    assert.deepEqual(adapter.cursors,['-1','page-two|opaque','page-two|opaque']);
    assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2','3']);
    assert.equal(c.getSnapshot().pages,2);assert.equal(c.getSnapshot().checked,3);
    assert.equal(c.getSnapshot().complete,true);assert.equal(c.getSnapshot().canResumeScan,false);
    assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.getSnapshot().error,null);
    assert.deepEqual(adapter.writes,[]);
  });

  test(`${mode}: pending relationship batch resumes from the first uncommitted offset without re-fetching pages`,async()=>{
    const {c,adapter}=await setup(mode),entered=deferred<void>(),reply=deferred<Relation[]>();
    adapter.page=async()=>({users:people(1,201),nextCursor:'0'});
    adapter.lookup=async ids=>{if(ids[0]==='101'){entered.resolve();return reply.promise;}return known(ids);};
    const running=c.scan();await entered.promise;c.pause();
    assert.equal(c.getSnapshot().checked,100);assert.equal(c.getSnapshot().rows.length,201);
    reply.resolve(known(people(101,100).map(person=>person.id)));await running;
    assert.equal(c.getSnapshot().checked,100);
    assert.equal(c.getSnapshot().rows[100].relation.following,null);
    adapter.lookup=async ids=>known(ids);await c.resumeScan();
    assert.deepEqual(adapter.cursors,['-1']);
    assert.deepEqual(adapter.relationCalls.map(ids=>[ids[0],ids.length]),[['1',100],['101',100],['101',100],['201',1]]);
    assert.equal(c.getSnapshot().checked,201);assert.equal(c.getSnapshot().complete,true);
    assert.equal(new Set(c.getSnapshot().rows.map(row=>row.id)).size,201);assert.deepEqual(adapter.writes,[]);
  });

  test(`${mode}: pause interrupts the pagination delay without waiting for its timer`,{timeout:2000},async()=>{
    const {c,adapter}=await setup(mode,60_000);let paused=false;
    adapter.page=async()=>({users:people(1,2),nextCursor:'next'});
    const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().pages===1){paused=true;setImmediate(()=>c.pause());}});
    try{await c.scan();}finally{unsubscribe();}
    assert.equal(paused,true);assert.deepEqual(adapter.cursors,['-1']);
    assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(c.getSnapshot().pausePending,false);
    adapter.page=async()=>({users:people(3,1),nextCursor:'0'});await c.resumeScan();
    assert.deepEqual(adapter.cursors,['-1','next']);assert.equal(c.getSnapshot().complete,true);
  });
}

test('pause interrupts the relationship delay and preserves the committed first batch',{timeout:2000},async()=>{
  const {c,adapter}=await setup('manual',60_000);let paused=false;
  adapter.page=async()=>({users:people(1,101),nextCursor:'0'});
  const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().checked===100){paused=true;setImmediate(()=>c.pause());}});
  try{await c.scan();}finally{unsubscribe();}
  assert.deepEqual(adapter.relationCalls.map(ids=>ids[0]),['1']);assert.equal(c.getSnapshot().canResumeScan,true);
  await c.resumeScan();assert.deepEqual(adapter.relationCalls.map(ids=>ids[0]),['1','101']);assert.equal(c.getSnapshot().complete,true);
});

test('pause during repository preparation prevents a later connection and resumes from the empty checkpoint',async()=>{
  const {c,adapter,memory}=await setup(),entered=deferred<void>(),read=deferred<Saved>();
  memory.read=async()=>{entered.resolve();return read.promise;};
  const running=c.scan();await entered.promise;c.pause();read.resolve(structuredClone(memory.data));await running;
  assert.equal(adapter.connectCalls,0);assert.deepEqual(adapter.cursors,[]);
  assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(c.getSnapshot().complete,false);
  memory.read=async()=>structuredClone(memory.data);await c.resumeScan();
  assert.equal(adapter.connectCalls,1);assert.deepEqual(adapter.cursors,['-1']);assert.equal(c.getSnapshot().complete,true);
});

test('pause during pending connect ignores its late account and resumes only after it settles',async()=>{
  const {c,adapter}=await setup(),entered=deferred<void>(),reply=deferred<Account>();
  adapter.connect=async()=>{adapter.connectCalls++;entered.resolve();return reply.promise;};
  const running=c.scan();await entered.promise;c.pause();await c.resumeScan();
  assert.equal(adapter.connectCalls,1);reply.resolve(adapter.account);await running;
  assert.equal(c.getSnapshot().account,null);assert.deepEqual(adapter.identityCalls,[]);assert.deepEqual(adapter.cursors,[]);
  adapter.connect=async()=>{adapter.connectCalls++;return {...adapter.account};};await c.resumeScan();
  assert.equal(c.getSnapshot().complete,true);assert.equal(adapter.connectCalls,2);
});

test('resume verifies the same account and discards the checkpoint on account change',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();reply.resolve({users:[],nextCursor:'0'});await running;
  adapter.account={id:'998',handle:'other',name:'Other'};await c.resumeScan();
  assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);assert.equal(c.getSnapshot().canResumeScan,false);
  assert.equal(c.getSnapshot().connected,false);assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(c.getSnapshot().complete,false);
  assert.deepEqual(adapter.cursors,['-1','page-two|opaque']);await c.resumeScan();assert.equal(adapter.connectCalls,2);
});

test('unexpected session loss keeps committed pages resumable and resume re-verifies the account',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();adapter.loseSession();
  reply.resolve({users:[],nextCursor:'0'});await running;
  assert.match(c.getSnapshot().error!,/^WORKER_RESTART:/);assert.equal(c.getSnapshot().canResumeScan,true);
  assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().rows.length,2);assert.equal(c.getSnapshot().connected,false);
  adapter.page=async()=>({users:people(3,1),nextCursor:'0'});await c.resumeScan();
  assert.equal(adapter.connectCalls,2);assert.deepEqual(adapter.identityCalls,['999','999','999']);
  assert.deepEqual(adapter.cursors,['-1','page-two|opaque','page-two|opaque']);
  assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2','3']);assert.equal(c.getSnapshot().complete,true);
  assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().error,null);assert.deepEqual(adapter.writes,[]);
});

test('terminal late errors discard the checkpoint rather than enabling a retry',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();reply.reject(new Error('SCHEMA: Invalid pending page'));await running;
  assert.match(c.getSnapshot().error!,/^SCHEMA:/);assert.equal(c.getSnapshot().canResumeScan,false);
  assert.equal(c.getSnapshot().phase,'error');await c.resumeScan();assert.equal(adapter.connectCalls,1);
});

test('repeated pause and resume clicks never overlap pending scan runs or duplicate committed rows',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();c.pause();await c.resumeScan();await c.resumeScan();
  reply.resolve({users:people(3,1),nextCursor:'0'});await running;
  const next=deferred<FollowingPage>(),entered=deferred<void>();
  adapter.page=async()=>{entered.resolve();return next.promise;};
  const resumed=c.resumeScan();await entered.promise;await c.resumeScan();c.pause();c.pause();
  next.resolve({users:people(3,1),nextCursor:'0'});await resumed;
  assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(c.getSnapshot().pages,1);assert.equal(adapter.connectCalls,2);
  adapter.page=async()=>({users:people(3,1),nextCursor:'0'});await c.resumeScan();
  assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2','3']);assert.equal(c.getSnapshot().complete,true);
  assert.deepEqual(adapter.cursors,['-1','page-two|opaque','page-two|opaque','page-two|opaque']);
});

test('pause triggered synchronously by a scan state subscriber remains resumable',async()=>{
  const {c,adapter}=await setup();let paused=false;
  const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().activeOperation==='scan'){paused=true;c.pause();}});
  try{await c.scan();}finally{unsubscribe();}
  assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(adapter.connectCalls,0);assert.deepEqual(adapter.cursors,[]);
  await c.resumeScan();assert.equal(c.getSnapshot().complete,true);
});

test('paused scan blocks write operations and auto mode until it is explicitly continued or replaced',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();reply.resolve({users:[],nextCursor:'0'});await running;
  await c.unfollow('1');await c.startAuto();await c.followAuthor();
  assert.equal(adapter.connectCalls,1);assert.deepEqual(adapter.writes,[]);assert.equal(adapter.authorCalls,0);
  assert.equal(c.getSnapshot().canResumeScan,true);assert.equal(c.getSnapshot().phase,'paused');
  adapter.page=async()=>({users:people(3,1),nextCursor:'0'});await c.resumeScan();await c.unfollow('1');
  assert.deepEqual(adapter.writes,['1']);
});

test('a new scan explicitly replaces its paused checkpoint and begins at the first cursor',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();reply.resolve({users:[],nextCursor:'0'});await running;
  adapter.page=async()=>({users:people(30,2),nextCursor:'0'});await c.scan();
  assert.deepEqual(adapter.cursors,['-1','page-two|opaque','-1']);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['30','31']);
  assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().complete,true);
});

test('clear local data discards the paused checkpoint and cannot be undone by resume',async()=>{
  const {c,adapter,reply,running}=await pendingSecondPage();c.pause();reply.resolve({users:[],nextCursor:'0'});await running;
  await c.clearLocalData();await c.resumeScan();
  assert.equal(c.getSnapshot().canResumeScan,false);assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(c.getSnapshot().account,null);
  assert.equal(adapter.connectCalls,1);assert.equal(c.getSnapshot().phase,'idle');
});

test('pause during final scan audit cannot be overwritten by ready and does not repeat its verified audit',async()=>{
  const {c,adapter,memory}=await setup(),entered=deferred<void>(),save=deferred<void>();
  memory.data.unresolved['999']=['1'];
  adapter.lookup=async ids=>known(ids).map(relation=>({...relation,following:relation.id==='1'?false:true}));
  memory.write=async data=>{if(data.logs.at(-1)?.result==='verified'){entered.resolve();await save.promise;}memory.data=structuredClone(data);};
  const running=c.scan();await entered.promise;c.pause();save.resolve();await running;
  assert.equal(c.getSnapshot().phase,'paused');assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().canResumeScan,true);
  assert.deepEqual(adapter.cursors,['-1']);assert.equal(adapter.relationCalls.length,1);
  await c.resumeScan();
  assert.equal(c.getSnapshot().complete,true);assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');
  assert.deepEqual(adapter.cursors,['-1']);assert.equal(adapter.relationCalls.length,1);
  assert.equal(memory.data.logs.filter(entry=>entry.result==='verified').length,1);assert.deepEqual(memory.data.unresolved['999'],[]);
});

test('pausing immediately after the last relationship commit prevents the final identity request',async()=>{
  const {c,adapter}=await setup();let paused=false;
  const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().checked===2){paused=true;c.pause();}});
  try{await c.scan();}finally{unsubscribe();}
  assert.equal(c.getSnapshot().phase,'paused');assert.equal(c.getSnapshot().canResumeScan,true);
  assert.deepEqual(adapter.identityCalls,['999']);assert.equal(c.getSnapshot().complete,false);
  await c.resumeScan();assert.deepEqual(adapter.identityCalls,['999','999','999']);
  assert.equal(adapter.relationCalls.length,1);assert.equal(c.getSnapshot().complete,true);
});

test('idle or completed scan pauses never invent a resumable checkpoint',async()=>{
  const {c,adapter}=await setup();c.pause();await c.resumeScan();assert.equal(adapter.connectCalls,0);assert.equal(c.getSnapshot().canResumeScan,false);
  await c.scan();c.pause();await c.resumeScan();
  assert.equal(adapter.connectCalls,1);assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().complete,true);
  assert.equal(c.getSnapshot().connected,false);assert.deepEqual(adapter.writes,[]);
});

test('automatic write pacing pause preserves completed scan and requires a separate explicit auto start',{timeout:2000},async()=>{
  const {c,adapter}=await setup('auto');await c.scan();c.setPacing(5,2);let paused=false;
  const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().logs.some(entry=>entry.result==='verified')){paused=true;setImmediate(()=>c.pause());}});
  try{await c.startAuto();}finally{unsubscribe();}
  assert.deepEqual(adapter.writes,['1']);assert.equal(c.getSnapshot().complete,true);assert.equal(c.getSnapshot().canResumeScan,false);
  assert.equal(c.getSnapshot().connected,false);assert.equal(c.getSnapshot().phase,'paused');assert.equal(c.getSnapshot().activeOperation,null);
  await c.resumeScan();assert.deepEqual(adapter.writes,['1']);await c.startAuto();assert.deepEqual(adapter.writes,['1','2']);
});

test('pause during a dispatched write preserves UNCERTAIN and never exposes scan resume or automatic retry',async()=>{
  const {c,adapter,memory}=await setup('auto');await c.scan();
  const entered=deferred<void>(),reply=deferred<void>();
  adapter.unfollow=async(_actor,id)=>{adapter.writes.push(id);entered.resolve();return reply.promise;};
  const running=c.startAuto();await entered.promise;c.pause();
  reply.reject(new Error('UNCERTAIN: Pause interrupted verification of a dispatched write'));await running;
  assert.match(c.getSnapshot().error!,/^UNCERTAIN:/);assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
  assert.deepEqual(memory.data.unresolved['999'],['1']);assert.equal(c.getSnapshot().canResumeScan,false);await c.resumeScan();
  assert.deepEqual(adapter.writes,['1']);assert.equal(c.getSnapshot().phase,'error');
});

test('an incomplete relationship scan cannot be continued after completion or used for automatic writes',async()=>{
  const {c,adapter}=await setup('auto');adapter.lookup=async ids=>ids.map(id=>({id,following:null,followedBy:null}));
  await c.scan();assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().canResumeScan,false);
  await c.resumeScan();await c.startAuto();assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.deepEqual(adapter.writes,[]);
});

test('resume preserves committed Following relationship evidence when a new lease loses its bulk cache',async()=>{
  const {c,adapter}=await setup(),entered=deferred<void>(),reply=deferred<FollowingPage>();
  const cache=new Map<string,Relation>();
  adapter.connect=async()=>{adapter.connectCalls++;cache.clear();return {...adapter.account};};
  adapter.following=async(_actor,cursor)=>{
    adapter.cursors.push(cursor);
    const page=cursor==='-1'?{users:people(1,2),nextCursor:'next',relations:[{id:'1',following:true,followedBy:true},{id:'2',following:true,followedBy:false}]}:await adapter.page(cursor);
    for(const relation of page.relations??[])cache.set(relation.id,relation);
    return page;
  };
  adapter.page=async()=>{entered.resolve();return reply.promise;};
  adapter.lookup=async ids=>ids.map(id=>cache.get(id)??{id,following:null,followedBy:null});
  const running=c.scan();await entered.promise;c.pause();reply.resolve({users:people(3,2),nextCursor:'0',relations:known(['3','4'])});await running;
  adapter.page=async()=>({users:people(3,2),nextCursor:'0',relations:known(['3','4'])});await c.resumeScan();
  assert.equal(cache.has('1'),false);assert.equal(cache.has('2'),false);
  assert.deepEqual(adapter.cursors,['-1','next','next']);assert.equal(c.getSnapshot().complete,true);
  assert.deepEqual(c.getSnapshot().rows.map(row=>[row.id,row.relation.following,row.relation.followedBy]),[['1',true,true],['2',true,false],['3',true,false],['4',true,false]]);
  assert.deepEqual(adapter.writes,[]);
});

async function pauseEvidenceScan(count=2,evidence:Relation[]=known(people(1,count).map(person=>person.id))){
  const env=await setup(),entered=deferred<void>(),reply=deferred<Relation[]>();
  env.adapter.page=async()=>({users:people(1,count),nextCursor:'0',relations:evidence});
  env.adapter.lookup=async()=>{entered.resolve();return reply.promise;};
  const running=env.c.scan();await entered.promise;env.c.pause();reply.resolve(evidence);await running;
  return env;
}

test('resume never substitutes page evidence for a fresh single-ID unknown relationship',async()=>{
  const {c,adapter}=await pauseEvidenceScan(1);adapter.lookup=async ids=>ids.map(id=>({id,following:null,followedBy:null}));
  await c.resumeScan();assert.equal(c.getSnapshot().complete,false);assert.deepEqual(c.getSnapshot().rows[0].relation,{id:'1',following:null,followedBy:null});
  assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.deepEqual(adapter.writes,[]);
});

test('resume keeps unknown page evidence unknown and honors a newer explicit relationship',async()=>{
  const {c,adapter}=await pauseEvidenceScan(2,[{id:'1',following:null,followedBy:null},{id:'2',following:true,followedBy:false}]);
  adapter.lookup=async()=>[{id:'1',following:null,followedBy:null},{id:'2',following:false,followedBy:true}];
  await c.resumeScan();assert.equal(c.getSnapshot().complete,false);
  assert.deepEqual(c.getSnapshot().rows.map(row=>row.relation),[{id:'1',following:null,followedBy:null},{id:'2',following:false,followedBy:true}]);
});

for(const kind of ['duplicate','unexpected','missing'] as const){
  test(`resume cannot conceal a ${kind} relationship batch using old page evidence`,async()=>{
    const {c,adapter}=await pauseEvidenceScan();
    adapter.lookup=async()=>kind==='duplicate'?[{id:'1',following:null,followedBy:null},{id:'1',following:null,followedBy:null}]:kind==='unexpected'?[{id:'1',following:null,followedBy:null},{id:'9999',following:null,followedBy:null}]:[{id:'1',following:null,followedBy:null}];
    await c.resumeScan();assert.equal(c.getSnapshot().complete,false);
    assert.ok(c.getSnapshot().rows.every(row=>row.relation.following===null&&row.relation.followedBy===null));
    assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.deepEqual(adapter.writes,[]);
  });
}

test('following evidence must match every page ID once before any checkpoint is committed',async()=>{
  for(const evidence of [[...known(['1']),...known(['1'])],known(['1','999']),known(['1'])]){
    const {c,adapter}=await setup();adapter.page=async()=>({users:people(1,2),nextCursor:'0',relations:evidence});
    await c.scan();assert.match(c.getSnapshot().error!,/^SCHEMA:/);assert.equal(c.getSnapshot().pages,0);
    assert.equal(c.getSnapshot().canResumeScan,false);assert.deepEqual(adapter.relationCalls,[]);assert.deepEqual(adapter.writes,[]);
  }
});
