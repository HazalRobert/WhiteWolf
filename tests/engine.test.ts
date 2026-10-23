import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, parseHandles, isWhitelisted, isAutoReady, csvCell, csvFileName } from '../src/engine';
import { emptySaved, type Repository, type Saved } from '../src/storage';
import type { Adapter, FollowingPage, Relation } from '../src/types';
class Memory implements Repository{data=emptySaved();async read(){return structuredClone(this.data)}async write(data:Saved){this.data=structuredClone(data)}}
class Fake implements Adapter{
  account={id:'99',handle:'tester',name:'Tester'}; writes:string[]=[]; followCalls=0; mutateError=''; identityError=''; pageCalls=0; missing=false; repeated=false; reversed=false; changed=false;
  private sessionLost:((message:string)=>void)|null=null;
  setSessionLostListener(listener:(message:string)=>void){this.sessionLost=listener}
  loseSession(message='WORKER_RESTART: Synthetic control connection stopped'){this.sessionLost?.(message)}
  async connect(){return this.changed?{...this.account,id:'98'}:this.account}
  async identity(){if(this.identityError)throw new Error(this.identityError);return this.account}
  async following(_actor:string,_cursor:string):Promise<FollowingPage>{this.pageCalls++;return {users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}],nextCursor:this.repeated?'123':'0'}}
  async relations(_actor:string,ids:string[]):Promise<Relation[]>{return ids.filter(id=>!this.missing||id==='1').map(id=>({id,following:true,followedBy:this.reversed}))}
  async resolve(_actor:string,handle:string){return {id:handle==='alice'?'1':'2',handle,name:handle}}
  async unfollow(_actor:string,id:string){if(this.mutateError)throw new Error(this.mutateError);this.writes.push(id)}
  async followAuthor(){this.followCalls++}
  cancel(){}
}
async function setup(){const adapter=new Fake(),memory=new Memory(),c=new Controller(adapter,memory,false,0);await c.initialize();await c.scan();return {adapter,memory,c}}
test('username parsing accepts separators and X URLs but rejects arbitrary paths',()=>{assert.deepEqual(parseHandles('@Alice，https://x.com/Bob\nalice'),['alice','bob']);assert.throws(()=>parseHandles('https://evil.test/bob'));assert.throws(()=>parseHandles('ab/cd'));});
test('CSV cells quote names and neutralize formulas including leading whitespace',()=>{assert.equal(csvCell('a,"b"'),'"a,""b"""');assert.equal(csvCell(' \t=1+1'),'"\' \t=1+1"');assert.equal(csvCell('@handle'),'"\'@handle"');assert.equal(csvCell(null),'""');});
test('whitelist uses permanent ID, not a stale username',()=>{assert.equal(isWhitelisted({id:'1',handle:'renamed'},[{id:'1',handle:'old'}]),true);assert.equal(isWhitelisted({id:'2',handle:'old'},[{id:'1',handle:'old'}]),false);});
test('automatic readiness uses its explicit value and falls back to completeness only for legacy snapshots',()=>{
  assert.equal(isAutoReady({complete:true}),true);assert.equal(isAutoReady({complete:false}),false);
  assert.equal(isAutoReady({complete:false,autoReady:true}),true);assert.equal(isAutoReady({complete:true,autoReady:false}),false);
});
test('complete scan confirms known relations without performing writes',async()=>{const {c,adapter}=await setup();assert.equal(c.getSnapshot().complete,true);assert.equal(c.getSnapshot().rows.length,2);assert.deepEqual(adapter.writes,[]);assert.equal(adapter.followCalls,0);});

test('opaque Following cursors containing a pipe cross page boundaries unchanged',async()=>{
  const {c,adapter}=await setup();const seen:string[]=[];
  const cursor='1771337970390780275|2085474368099450818';
  adapter.following=async(_actor:string,input:string)=>{
    seen.push(input);
    return input==='-1'?{users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:cursor}
      :{users:[{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0'};
  };
  await c.scan();assert.deepEqual(seen,['-1',cursor]);assert.equal(c.getSnapshot().pages,2);
  assert.equal(c.getSnapshot().complete,true);assert.equal(c.getSnapshot().error,null);
  assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2']);assert.deepEqual(adapter.writes,[]);
});

test('missing users and invalid cursors produce distinct scan errors before relationships or writes',async()=>{
  for(const result of [null,{}, {users:null,nextCursor:'0'}, {users:[],nextCursor:''}, {users:[],nextCursor:'bad cursor'}, {users:[],nextCursor:'x'.repeat(4097)}]){
    const {c,adapter}=await setup();let relations=0;
    adapter.following=async()=>result as never;adapter.relations=async()=>{relations++;return []};
    await c.scan();
    assert.match(c.getSnapshot().error!,result&&Array.isArray((result as {users?:unknown}).users)?/no valid opaque pagination cursor/:/no users array/);
    assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().pages,0);assert.equal(relations,0);assert.deepEqual(adapter.writes,[]);
  }
});

test('a terminal controller validation error releases its adapter control session',async()=>{
  const {c,adapter}=await setup();let cancelled=0;
  adapter.cancel=()=>{cancelled++};adapter.following=async()=>({users:[],nextCursor:'bad cursor'});
  await c.scan();assert.match(c.getSnapshot().error!,/^SCHEMA: Following page has no valid opaque pagination cursor/);
  assert.equal(cancelled,1);assert.equal(c.getSnapshot().connected,false);assert.equal(c.getSnapshot().complete,false);assert.deepEqual(adapter.writes,[]);
});

test('a late generic port closure cannot overwrite the original terminal scan error',async()=>{
  const {c,adapter}=await setup();
  const original='SCHEMA: Following timeline reset during pagination';
  adapter.following=async()=>{throw new Error(original)};
  await c.scan();assert.equal(c.getSnapshot().error,original);assert.equal(c.getSnapshot().connected,false);
  adapter.loseSession('WORKER_RESTART: Synthetic later idle port closure');
  assert.equal(c.getSnapshot().error,original);assert.equal(c.getSnapshot().connected,false);assert.equal(c.getSnapshot().phase,'error');
  assert.deepEqual(adapter.writes,[]);
});

test('a late generic port closure cannot hide an already recorded uncertain write',async()=>{
  const {c,adapter,memory}=await setup();adapter.mutateError='UNCERTAIN: Synthetic original write result missing';
  await c.unfollow('1');const original=c.getSnapshot().error;
  adapter.loseSession('WORKER_RESTART: Synthetic later idle port closure');
  assert.equal(c.getSnapshot().error,original);assert.match(original!,/^UNCERTAIN:/);
  assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');assert.ok(memory.data.unresolved['99'].includes('1'));
  assert.deepEqual(adapter.writes,[]);
});

test('an explicit replacement during a scan preserves the cancellation reason without resuming',async()=>{
  const {c,adapter}=await setup();let release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve});
  adapter.following=async()=>{started();await new Promise<void>(resolve=>{release=resolve});return {users:[],nextCursor:'0'}};
  const scanning=c.scan();await ready;
  const reason='CANCELLED: This control session was replaced by another connection. Reconnect explicitly.';
  adapter.loseSession(reason);release();await scanning;
  assert.equal(c.getSnapshot().error,reason);assert.equal(c.getSnapshot().phase,'paused');assert.equal(c.getSnapshot().connected,false);
  assert.equal(c.getSnapshot().complete,false);assert.deepEqual(adapter.writes,[]);
});
test('missing relationship remains unknown and disables automatic mode',async()=>{const {c,adapter}=await setup();adapter.missing=true;await c.scan();assert.equal(c.getSnapshot().rows[1].relation.followedBy,null);assert.equal(c.getSnapshot().complete,false);await c.startAuto();assert.deepEqual(adapter.writes,[]);assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);});
test('repeated cursor or duplicate page stops incomplete scan',async()=>{const {c,adapter}=await setup();adapter.repeated=true;await c.scan();assert.equal(c.getSnapshot().complete,false);assert.match(c.getSnapshot().error!,/Duplicate page|Repeated cursor/);assert.deepEqual(adapter.writes,[]);});
test('automatic mode excludes whitelist and obeys batch limit',async()=>{const {c,adapter}=await setup();await c.addWhitelist('@alice');c.setPacing(5,1);await c.startAuto();assert.deepEqual(adapter.writes,['2']);assert.equal(c.getSnapshot().rows[1].outcome,'unfollowed');});
test('manual explicit choice can unfollow a whitelisted candidate',async()=>{const {c,adapter}=await setup();await c.addWhitelist('@alice');await c.unfollow('1');assert.deepEqual(adapter.writes,['1']);});
test('fresh relationship becoming mutual is skipped before mutation',async()=>{const {c,adapter}=await setup();adapter.reversed=true;await c.unfollow('1');assert.deepEqual(adapter.writes,[]);assert.equal(c.getSnapshot().rows[0].outcome,'skipped');});
test('rate limit stops batch without retry',async()=>{const {c,adapter}=await setup();adapter.mutateError='RATE_LIMIT: HTTP 429';await c.startAuto();assert.deepEqual(adapter.writes,[]);assert.equal(c.getSnapshot().phase,'error');assert.match(c.getSnapshot().error!,/^RATE_LIMIT:/);});
test('uncertain write never requeues or retries the same row',async()=>{const {c,adapter}=await setup();adapter.mutateError='UNCERTAIN: Response lost';await c.unfollow('1');assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');adapter.mutateError='';await c.unfollow('1');assert.deepEqual(adapter.writes,[]);});
test('account switch clears old candidates before a write',async()=>{const {c,adapter}=await setup();adapter.changed=true;await c.unfollow('1');assert.deepEqual(adapter.writes,[]);assert.equal(c.getSnapshot().rows.length,0);assert.equal(c.getSnapshot().complete,false);assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);});
test('opening persisted data does not resume operations or retain live candidates',async()=>{const {c,memory,adapter}=await setup();c.toggleWhitelist('1');await new Promise(r=>setTimeout(r,0));const reopened=new Controller(adapter,memory);await reopened.initialize();assert.equal(reopened.getSnapshot().rows.length,0);assert.equal(reopened.getSnapshot().phase,'idle');assert.deepEqual(adapter.writes,[]);await reopened.connect();assert.equal(reopened.getSnapshot().whitelist[0].id,'1');});
test('author is followed only through explicit followAuthor action',async()=>{const {c,adapter}=await setup();assert.equal(adapter.followCalls,0);await c.followAuthor();assert.equal(adapter.followCalls,1);assert.equal(c.getSnapshot().authorFollowed,true);});
test('uncertain writes remain excluded after reopening and rescanning',async()=>{const {c,adapter,memory}=await setup();adapter.mutateError='UNCERTAIN: Response lost';await c.unfollow('1');adapter.mutateError='';const reopened=new Controller(adapter,memory,false,0);await reopened.initialize();await reopened.scan();assert.equal(reopened.getSnapshot().rows[0].outcome,'uncertain');await reopened.unfollow('1');assert.deepEqual(adapter.writes,[]);});
test('an interrupted intent is restored as uncertain before any new mutation',async()=>{const {adapter,memory}=await setup();memory.data.unresolved['99']=['1'];memory.data.logs.push({at:new Date().toISOString(),actorId:'99',targetId:'1',handle:'alice',action:'unfollow',result:'intent'});const reopened=new Controller(adapter,memory,false,0);await reopened.initialize();await reopened.scan();assert.equal(reopened.getSnapshot().rows[0].outcome,'uncertain');reopened.setPacing(5,1);await reopened.startAuto();assert.deepEqual(adapter.writes,['2']);});

for(const code of ['HTTP','NETWORK','SCHEMA','RATE_LIMIT','AUTH','ACCOUNT_CHANGED','API_UNAVAILABLE','WORKER_RESTART','NOT_CONNECTED','TAB_REQUIRED','TAB_PERMISSION']){
  test(`${code} invalidates the live connection while preserving verified results`,async()=>{
    const {c,adapter}=await setup();
    await c.unfollow('1');
    const before=structuredClone(c.getSnapshot());
    adapter.identityError=`${code}: Simulated read failure`;
    await c.unfollow('2');
    const failed=c.getSnapshot();
    assert.equal(failed.connected,false);
    assert.equal(failed.phase,'error');
    assert.equal(failed.error,adapter.identityError);
    assert.deepEqual(failed.account,before.account);
    assert.deepEqual(failed.rows,before.rows);
    assert.equal(failed.complete,before.complete);
    assert.deepEqual(failed.logs,before.logs);
    assert.deepEqual(adapter.writes,['1']);
    adapter.identityError='';
    await c.connect();
    assert.equal(c.getSnapshot().connected,true);
    assert.deepEqual(c.getSnapshot().rows,before.rows);
    assert.deepEqual(adapter.writes,['1']);
  });
}

test('an uncertain write disconnects without losing its persistent no-retry record',async()=>{
  const {c,adapter,memory}=await setup();
  adapter.mutateError='UNCERTAIN: Verified result was not received';
  await c.unfollow('1');
  assert.equal(c.getSnapshot().connected,false);
  assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
  assert.equal(c.getSnapshot().rows[1].outcome,'pending');
  assert.deepEqual(memory.data.unresolved['99'],['1']);
  adapter.mutateError='';
  await c.connect();
  assert.equal(c.getSnapshot().connected,true);
  assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
  await c.unfollow('1');
  assert.deepEqual(adapter.writes,[]);
  assert.deepEqual(memory.data.unresolved['99'],['1']);
});

test('a local incomplete-scan guard keeps an otherwise live session connected',async()=>{
  const {c,adapter}=await setup();
  adapter.missing=true;
  await c.scan();
  assert.equal(c.getSnapshot().connected,true);
  await c.startAuto();
  assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);
  assert.equal(c.getSnapshot().connected,true);
  assert.deepEqual(adapter.writes,[]);
});

test('scan follows opaque GraphQL cursors without treating them as numeric IDs',async()=>{
  const adapter=new Fake(),memory=new Memory(),c=new Controller(adapter,memory,false,0),cursors:string[]=[];
  adapter.following=async(_actor:string,cursor:string)=>{
    cursors.push(cursor);
    return cursor==='-1'?{users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'DAABC+_/-=='}:{users:[],nextCursor:'0'};
  };
  await c.initialize();await c.scan();
  assert.equal(c.getSnapshot().complete,true);assert.deepEqual(cursors,['-1','DAABC+_/-==']);assert.deepEqual(adapter.writes,[]);
});

test('a second-page schema failure retains unknown first-page rows and never enables automatic or manual writes',async()=>{
  const adapter=new Fake(),memory=new Memory(),c=new Controller(adapter,memory,false,0);
  const cursors:string[]=[],mutationAttempts:string[]=[];
  let relationshipLookups=0;
  const people=[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}];
  const reason='SCHEMA: Following timeline reset during pagination; type=TimelineClearCache; index=0. Restart the scan.';
  adapter.following=async(_actor:string,cursor:string)=>{
    cursors.push(cursor);
    if(cursor==='-1')return {users:people,nextCursor:'next-page-token',unavailableCount:2};
    assert.equal(cursor,'next-page-token');
    throw new Error(reason);
  };
  adapter.relations=async(_actor:string,ids:string[])=>{
    relationshipLookups++;
    return ids.map(id=>({id,following:true,followedBy:false}));
  };
  adapter.unfollow=async(_actor:string,id:string)=>{mutationAttempts.push(id);adapter.writes.push(id);};
  await c.initialize();await c.scan();
  const failed=c.getSnapshot();
  const expectedRows=people.map(person=>({...person,relation:{id:person.id,following:null,followedBy:null},outcome:'pending'}));
  assert.deepEqual(cursors,['-1','next-page-token']);
  assert.equal(failed.error,reason);assert.equal(failed.phase,'error');assert.equal(failed.connected,false);
  assert.equal(failed.complete,false);assert.equal(failed.autoReady,false);assert.equal(failed.unavailableCount,2);
  assert.equal(failed.scannedAt,null);assert.equal(failed.pages,1);assert.equal(failed.checked,0);
  assert.deepEqual(failed.rows,expectedRows);assert.equal(relationshipLookups,0);
  assert.deepEqual(mutationAttempts,[]);assert.deepEqual(adapter.writes,[]);assert.equal(adapter.followCalls,0);

  await c.startAuto();
  assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);
  assert.deepEqual(c.getSnapshot().rows,expectedRows);assert.equal(c.getSnapshot().complete,false);
  // Manual entry reconnects, but unknown relationships cannot become write candidates.
  await c.unfollow('1');await c.unfollow('2');
  assert.deepEqual(c.getSnapshot().rows,expectedRows);assert.equal(c.getSnapshot().complete,false);
  assert.equal(relationshipLookups,0);assert.deepEqual(mutationAttempts,[]);assert.deepEqual(adapter.writes,[]);
  assert.equal(adapter.followCalls,0);assert.deepEqual(c.getSnapshot().logs,[]);assert.deepEqual(memory.data.logs,[]);
});

test('an idle unexpected disconnect immediately clears connected while preserving scan and whitelist',async()=>{
  const {c,adapter,memory}=await setup();
  await c.addWhitelist('@alice');
  const before=structuredClone(c.getSnapshot()),savedBefore=structuredClone(memory.data);
  const reason='WORKER_RESTART: Synthetic idle connection closed';
  adapter.loseSession(reason);
  const after=c.getSnapshot();
  assert.equal(after.connected,false);
  assert.equal(after.phase,'error');
  assert.equal(after.error,reason);
  assert.deepEqual(after.account,before.account);
  assert.deepEqual(after.rows,before.rows);
  assert.deepEqual(after.whitelist,before.whitelist);
  assert.deepEqual(after.logs,before.logs);
  assert.equal(after.complete,true);
  assert.equal(after.scannedAt,before.scannedAt);
  assert.deepEqual(memory.data,savedBefore);
  assert.deepEqual(adapter.writes,[]);
});

test('disconnect between automatic writes wakes the pacing wait and prevents the next write',{timeout:2000},async()=>{
  const {c,adapter,memory}=await setup();
  c.setPacing(5,2);
  let disconnectQueued=false;
  const unsubscribe=c.subscribe(()=>{
    if(!disconnectQueued&&c.getSnapshot().logs.some(entry=>entry.targetId==='1'&&entry.result==='verified')){
      disconnectQueued=true;
      // Leave the completed write's persistence turn before losing the port, so this
      // exercises the actual pacing wait rather than a still-pending mutation.
      setImmediate(()=>adapter.loseSession('WORKER_RESTART: Synthetic loss between writes'));
    }
  });
  try{await c.startAuto();}finally{unsubscribe();}
  assert.equal(disconnectQueued,true);
  assert.deepEqual(adapter.writes,['1']);
  assert.equal(c.getSnapshot().connected,false);
  assert.equal(c.getSnapshot().phase,'error');
  assert.match(c.getSnapshot().error!,/^WORKER_RESTART:/);
  assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');
  assert.equal(c.getSnapshot().rows[1].outcome,'pending');
  assert.equal(c.getSnapshot().logs.some(entry=>entry.targetId==='2'&&entry.result==='intent'),false);
  assert.deepEqual(memory.data.unresolved['99'],[]);
});

for(const code of ['TAB_REQUIRED','TAB_PERMISSION']){
  test(`${code} from reconnect preserves the previous scan and whitelist but invalidates connection`,async()=>{
    const {c,adapter}=await setup();
    await c.addWhitelist('@alice');
    const before=structuredClone(c.getSnapshot());
    adapter.connect=async()=>{throw new Error(`${code}: Synthetic entry failure`)};
    await c.connect();
    assert.equal(c.getSnapshot().connected,false);
    assert.equal(c.getSnapshot().phase,'error');
    assert.match(c.getSnapshot().error!,new RegExp(`^${code}:`));
    assert.deepEqual(c.getSnapshot().rows,before.rows);
    assert.deepEqual(c.getSnapshot().whitelist,before.whitelist);
    assert.equal(c.getSnapshot().complete,true);
    assert.deepEqual(adapter.writes,[]);
  });
}

test('disconnect during a pending write retains UNCERTAIN and its persistent no-retry record',async()=>{
  const {c,adapter,memory}=await setup();
  let notifyStarted!:()=>void,rejectWrite!:(error:Error)=>void;
  const started=new Promise<void>(resolve=>{notifyStarted=resolve});
  const response=new Promise<void>((_resolve,reject)=>{rejectWrite=reject});
  const attempts:string[]=[];
  adapter.unfollow=async(_actor,id)=>{attempts.push(id);notifyStarted();return response};
  const run=c.unfollow('1');
  await started;
  assert.deepEqual(memory.data.unresolved['99'],['1']);
  adapter.loseSession('WORKER_RESTART: Synthetic port closed during write');
  assert.equal(c.getSnapshot().connected,false);
  rejectWrite(new Error('UNCERTAIN: The requested write lost its verified response'));
  await run;
  assert.match(c.getSnapshot().error!,/^UNCERTAIN:/);
  assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
  assert.equal(c.getSnapshot().rows[1].outcome,'pending');
  assert.deepEqual(memory.data.unresolved['99'],['1']);
  assert.deepEqual(memory.data.logs.filter(entry=>entry.targetId==='1').map(entry=>entry.result),['intent','uncertain']);
  adapter.unfollow=async(_actor,id)=>{attempts.push(id);adapter.writes.push(id)};
  await c.connect();
  await c.unfollow('1');
  assert.deepEqual(attempts,['1']);
  const reopened=new Controller(adapter,memory,false,0);
  await reopened.initialize();await reopened.scan();await reopened.unfollow('1');
  assert.equal(reopened.getSnapshot().rows[0].outcome,'uncertain');
  assert.deepEqual(attempts,['1']);
  assert.deepEqual(memory.data.unresolved['99'],['1']);
});

test('session loss while persisting a verified manual write settles to error without losing the confirmed result',{timeout:2000},async()=>{
  const {c,adapter,memory}=await setup();
  let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve});
  const pendingSave=new Promise<void>(resolve=>{release=resolve});
  memory.write=async(data:Saved)=>{
    if(data.logs.at(-1)?.result==='verified'){started();await pendingSave;}
    memory.data=structuredClone(data);
  };
  const running=c.unfollow('1');
  await ready;
  assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');
  const reason='WORKER_RESTART: Synthetic heartbeat lost while saving the verified result';
  adapter.loseSession(reason);
  release();await running;
  assert.equal(c.getSnapshot().phase,'error');
  assert.equal(c.getSnapshot().connected,false);
  assert.equal(c.getSnapshot().error,reason);
  assert.equal(c.getSnapshot().message,'statusPaused');
  assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');
  assert.equal(c.getSnapshot().rows[0].relation.following,false);
  assert.deepEqual(memory.data.unresolved['99'],[]);
  assert.deepEqual(memory.data.logs.filter(entry=>entry.targetId==='1').map(entry=>entry.result),['intent','verified']);
  assert.deepEqual(adapter.writes,['1']);
});

test('mixed Following pages count unavailable accounts and allow automatic writes only for verified candidates',async()=>{
  const {c,adapter}=await setup(),lookups:string[][]=[];
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:2});
  adapter.relations=async(_actor,ids)=>{
    lookups.push([...ids]);
    return ids.map(id=>({id,following:true,followedBy:false}));
  };
  await c.scan();
  assert.equal(c.getSnapshot().unavailableCount,2);assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().checked,2);
  assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.getSnapshot().error,null);
  assert.equal(c.getSnapshot().autoReady,true);
  assert.ok(c.getSnapshot().rows.every(row=>row.relation.following===true&&row.relation.followedBy===false));
  c.setPacing(5,1);
  await c.startAuto();
  assert.deepEqual(adapter.writes,['1']);assert.deepEqual(lookups,[['1','2'],['1']]);assert.equal(c.getSnapshot().error,null);
  await c.unfollow('2');
  assert.deepEqual(lookups,[['1','2'],['1'],['2']]);assert.deepEqual(adapter.writes,['1','2']);
  assert.equal(c.getSnapshot().rows[0].outcome,'unfollowed');assert.equal(c.getSnapshot().unavailableCount,2);
  assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().autoReady,true);
});

test('unavailable accounts never bypass the fresh relationship check for a manual choice',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:1});
  await c.scan();
  let freshLookups=0;
  adapter.relations=async(_actor,ids)=>{freshLookups++;assert.deepEqual(ids,['1']);return [{id:'1',following:null,followedBy:null}];};
  await c.unfollow('1');
  assert.equal(freshLookups,1);assert.match(c.getSnapshot().error!,/^SCHEMA: Current relationship unknown/);
  assert.deepEqual(adapter.writes,[]);assert.deepEqual(c.getSnapshot().logs,[]);assert.equal(c.getSnapshot().unavailableCount,1);
});

test('a page containing only unavailable accounts advances to normal pages and accumulates counts',async()=>{
  const {c,adapter}=await setup(),cursors:string[]=[];
  adapter.following=async(_actor,cursor)=>{
    cursors.push(cursor);
    if(cursor==='-1')return {users:[],nextCursor:'unavailable-page|next',unavailableCount:3};
    assert.equal(cursor,'unavailable-page|next');
    return {users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:2};
  };
  let relationCalls=0;
  adapter.relations=async(_actor,ids)=>{
    relationCalls++;assert.deepEqual(ids,['1']);assert.equal(c.getSnapshot().unavailableCount,5);
    return [{id:'1',following:true,followedBy:false}];
  };
  await c.scan();
  assert.deepEqual(cursors,['-1','unavailable-page|next']);assert.equal(c.getSnapshot().pages,2);
  assert.equal(relationCalls,1);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1']);
  assert.equal(c.getSnapshot().unavailableCount,5);assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().checked,1);
  assert.equal(c.getSnapshot().autoReady,true);
  assert.equal(c.getSnapshot().error,null);assert.deepEqual(adapter.writes,[]);
});

test('a terminal page containing only unavailable accounts remains incomplete without inventing candidate rows',async()=>{
  const {c,adapter}=await setup();let relations=0;
  adapter.following=async()=>({users:[],nextCursor:'0',unavailableCount:4});
  adapter.relations=async()=>{relations++;return [];};
  await c.scan();
  assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().unavailableCount,4);assert.equal(c.getSnapshot().complete,false);
  assert.equal(c.getSnapshot().phase,'ready');assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(relations,0);
  assert.equal(c.getSnapshot().autoReady,true);
  await c.startAuto();assert.equal(c.getSnapshot().error,null);assert.deepEqual(adapter.writes,[]);
});

for(const unavailableCount of [undefined,0]){
  test(`a nonterminal cursor-only page with ${String(unavailableCount)} unavailable accounts still fails closed`,async()=>{
    const {c,adapter}=await setup();let relations=0;
    adapter.following=async()=>({users:[],nextCursor:'next',...(unavailableCount===undefined?{}:{unavailableCount})});
    adapter.relations=async()=>{relations++;return [];};
    await c.scan();
    assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.equal(c.getSnapshot().pages,0);
    assert.equal(c.getSnapshot().unavailableCount,0);assert.equal(c.getSnapshot().complete,false);
    assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(relations,0);assert.deepEqual(adapter.writes,[]);
  });
}

for(const unavailableCount of [-1,0.5,'2',null,true,NaN,Infinity,{}]){
  test(`invalid unavailableCount ${String(unavailableCount)} rejects the entire page before committing its rows or count`,async()=>{
    const {c,adapter}=await setup();let relations=0;
    adapter.following=async(_actor,cursor)=>cursor==='-1'
      ?{users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'next',unavailableCount:2}
      :{users:[{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount} as never;
    adapter.relations=async()=>{relations++;return [];};
    await c.scan();
    assert.match(c.getSnapshot().error!,/^SCHEMA:/);assert.equal(c.getSnapshot().connected,false);
    assert.equal(c.getSnapshot().unavailableCount,2);assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().checked,0);
    assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1']);assert.equal(c.getSnapshot().complete,false);
    assert.equal(relations,0);assert.deepEqual(adapter.writes,[]);
  });
}

for(const [label,page] of [
  ['invalid account',{users:[{id:'bad-id',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:7}],
  ['invalid relationship evidence',{users:[{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:7,relations:[]}],
  ['invalid cursor',{users:[{id:'2',handle:'bob',name:'Bob'}],nextCursor:'bad cursor',unavailableCount:7}],
  ['duplicate account page',{users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:7}],
] satisfies Array<[string,FollowingPage]>){
  test(`${label} never commits an otherwise valid unavailable count`,async()=>{
    const {c,adapter}=await setup();let relations=0;
    adapter.following=async(_actor,cursor)=>cursor==='-1'
      ?{users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'next',unavailableCount:2}
      :structuredClone(page);
    adapter.relations=async()=>{relations++;return [];};
    await c.scan();
    assert.match(c.getSnapshot().error!,/^(SCHEMA|INCOMPLETE):/);assert.equal(c.getSnapshot().pages,1);
    assert.equal(c.getSnapshot().unavailableCount,2);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1']);
    assert.equal(c.getSnapshot().complete,false);assert.equal(relations,0);assert.deepEqual(adapter.writes,[]);
  });
}

for(const nextCursor of ['next','-1']){
  test(`unavailable-only cursor cycle back to ${nextCursor} is rejected before a second count is committed`,async()=>{
    const {c,adapter}=await setup(),cursors:string[]=[];
    adapter.following=async(_actor,cursor)=>{
      cursors.push(cursor);
      return cursor==='-1'?{users:[],nextCursor:'next',unavailableCount:2}:{users:[],nextCursor,unavailableCount:3};
    };
    await c.scan();
    assert.match(c.getSnapshot().error!,/^SCHEMA:.*cursor/i);assert.deepEqual(cursors,['-1','next']);
    assert.equal(c.getSnapshot().pages,1);assert.equal(c.getSnapshot().unavailableCount,2);
    assert.equal(c.getSnapshot().complete,false);assert.deepEqual(c.getSnapshot().rows,[]);assert.deepEqual(adapter.writes,[]);
  });
}

test('pausing a pending page ignores its late unavailable count and explicit resume commits that page once',async()=>{
  const {c,adapter}=await setup(),cursors:string[]=[];
  let started!:()=>void,release!:(page:FollowingPage)=>void;
  const ready=new Promise<void>(resolve=>{started=resolve}),reply=new Promise<FollowingPage>(resolve=>{release=resolve});
  const nextPage:FollowingPage={users:[{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:3};
  adapter.following=async(_actor,cursor)=>{
    cursors.push(cursor);
    if(cursor==='-1')return {users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'next',unavailableCount:2};
    started();return reply;
  };
  const running=c.scan();await ready;
  assert.equal(c.getSnapshot().unavailableCount,2);c.pause();await c.resumeScan();release(nextPage);await running;
  assert.equal(c.getSnapshot().unavailableCount,2);assert.equal(c.getSnapshot().pages,1);
  assert.equal(c.getSnapshot().autoReady,false);
  assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1']);assert.equal(c.getSnapshot().canResumeScan,true);
  adapter.following=async(_actor,cursor)=>{cursors.push(cursor);return nextPage;};
  await c.resumeScan();await c.resumeScan();
  assert.deepEqual(cursors,['-1','next','next']);assert.equal(c.getSnapshot().unavailableCount,5);
  assert.equal(c.getSnapshot().pages,2);assert.deepEqual(c.getSnapshot().rows.map(row=>row.id),['1','2']);
  assert.equal(c.getSnapshot().checked,2);assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().canResumeScan,false);
  assert.equal(c.getSnapshot().autoReady,true);
  assert.deepEqual(adapter.writes,[]);
});

test('relationship-phase pause and resume preserve the committed unavailable count without rereading Following',async()=>{
  const {c,adapter}=await setup();let followingCalls=0,relationshipCalls=0,started!:()=>void,release!:(relations:Relation[])=>void;
  const ready=new Promise<void>(resolve=>{started=resolve}),reply=new Promise<Relation[]>(resolve=>{release=resolve});
  const known:Relation[]=[{id:'1',following:true,followedBy:false},{id:'2',following:true,followedBy:false}];
  adapter.following=async()=>{followingCalls++;return {users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:4};};
  adapter.relations=async()=>{relationshipCalls++;started();return reply;};
  const running=c.scan();await ready;
  assert.equal(c.getSnapshot().unavailableCount,4);c.pause();release(known);await running;
  assert.equal(c.getSnapshot().unavailableCount,4);assert.equal(c.getSnapshot().checked,0);assert.equal(c.getSnapshot().canResumeScan,true);
  adapter.relations=async()=>{relationshipCalls++;return known;};
  await c.resumeScan();
  assert.equal(followingCalls,1);assert.equal(relationshipCalls,2);assert.equal(c.getSnapshot().unavailableCount,4);
  assert.equal(c.getSnapshot().checked,2);assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().phase,'ready');
  assert.deepEqual(adapter.writes,[]);
});

test('unavailable count initializes to zero and a new scan resets it before its first response',async()=>{
  const adapter=new Fake(),memory=new Memory(),c=new Controller(adapter,memory,false,0);
  await c.initialize();assert.equal(c.getSnapshot().unavailableCount,0);assert.equal(c.getSnapshot().autoReady,false);
  adapter.following=async()=>({users:[],nextCursor:'0',unavailableCount:5});await c.scan();
  assert.equal(c.getSnapshot().unavailableCount,5);assert.equal(c.getSnapshot().autoReady,true);
  let started!:()=>void,release!:(page:FollowingPage)=>void;
  const ready=new Promise<void>(resolve=>{started=resolve}),reply=new Promise<FollowingPage>(resolve=>{release=resolve});
  adapter.following=async()=>{started();return reply;};
  const running=c.scan();await ready;
  assert.equal(c.getSnapshot().unavailableCount,0);assert.equal(c.getSnapshot().pages,0);assert.equal(c.getSnapshot().complete,false);
  assert.equal(c.getSnapshot().autoReady,false);
  release({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0'});await running;
  assert.equal(c.getSnapshot().unavailableCount,0);assert.equal(c.getSnapshot().complete,true);assert.deepEqual(adapter.writes,[]);
});

test('changing accounts on resume clears the previous unavailable count with its paused candidates',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:6});
  let paused=false;
  const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().phase==='scanning'&&c.getSnapshot().unavailableCount===6){paused=true;c.pause();}});
  try{await c.scan();}finally{unsubscribe();}
  assert.equal(c.getSnapshot().unavailableCount,6);assert.equal(c.getSnapshot().canResumeScan,true);
  adapter.changed=true;await c.resumeScan();
  assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);assert.equal(c.getSnapshot().unavailableCount,0);
  assert.equal(c.getSnapshot().autoReady,false);
  assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(c.getSnapshot().pages,0);assert.equal(c.getSnapshot().complete,false);
  assert.equal(c.getSnapshot().canResumeScan,false);
  assert.deepEqual(adapter.writes,[]);
});

test('clearing local data resets the unavailable count and cannot restore it through resume',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:6});
  let paused=false;
  const unsubscribe=c.subscribe(()=>{if(!paused&&c.getSnapshot().phase==='scanning'&&c.getSnapshot().unavailableCount===6){paused=true;c.pause();}});
  try{await c.scan();}finally{unsubscribe();}
  assert.equal(c.getSnapshot().unavailableCount,6);assert.equal(c.getSnapshot().canResumeScan,true);
  await c.clearLocalData();await c.resumeScan();
  assert.equal(c.getSnapshot().unavailableCount,0);assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(c.getSnapshot().account,null);
  assert.equal(c.getSnapshot().autoReady,false);
  assert.equal(c.getSnapshot().canResumeScan,false);assert.equal(c.getSnapshot().complete,false);assert.deepEqual(adapter.writes,[]);
});

test('an unavailable entry does not hide unknown relationships or authorize automatic writes',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:3});
  adapter.missing=true;await c.scan();
  assert.equal(c.getSnapshot().unavailableCount,3);assert.equal(c.getSnapshot().rows[1].relation.followedBy,null);
  assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().autoReady,false);
  await c.startAuto();assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.deepEqual(adapter.writes,[]);
});

for(const malformed of [{following:undefined,followedBy:false},{following:true,followedBy:'false'}]){
  test(`unavailable entries cannot make a malformed ${typeof malformed.following==='boolean'?'followedBy':'following'} relationship automatically ready`,async()=>{
    const {c,adapter}=await setup();
    adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:1});
    adapter.relations=async()=>[{id:'1',following:true,followedBy:false},{id:'2',...malformed}] as never;
    await c.scan();
    assert.equal(c.getSnapshot().unavailableCount,1);assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().autoReady,false);
    assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);await c.startAuto();assert.deepEqual(adapter.writes,[]);
  });
}

test('automatic processing with unavailable entries still respects the whitelist and batch limit',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'},{id:'3',handle:'carol',name:'Carol'}],nextCursor:'0',unavailableCount:2});
  await c.scan();await c.addWhitelist('@alice');c.setPacing(5,1);
  await c.startAuto();
  assert.deepEqual(adapter.writes,['2']);assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().autoReady,true);
  assert.deepEqual(c.getSnapshot().rows.map(row=>row.outcome),['pending','unfollowed','pending']);
  assert.equal(c.getSnapshot().unavailableCount,2);assert.equal(adapter.followCalls,0);
});

test('automatic processing with unavailable entries skips a candidate that becomes mutual before its write',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:2});
  await c.scan();adapter.reversed=true;await c.startAuto();
  assert.equal(c.getSnapshot().autoReady,true);assert.deepEqual(adapter.writes,[]);
  assert.equal(c.getSnapshot().rows[0].outcome,'skipped');assert.equal(c.getSnapshot().rows[0].relation.followedBy,true);
  assert.deepEqual(c.getSnapshot().logs.map(entry=>entry.result),['skipped']);
});

test('automatic processing with unavailable entries stops when the fresh relationship is unknown',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:1});
  await c.scan();let freshLookups=0;
  adapter.relations=async(_actor,ids)=>{freshLookups++;assert.deepEqual(ids,['1']);return [{id:'1',following:null,followedBy:null}];};
  await c.startAuto();
  assert.equal(freshLookups,1);assert.match(c.getSnapshot().error!,/^SCHEMA: Current relationship unknown/);
  assert.deepEqual(adapter.writes,[]);assert.deepEqual(c.getSnapshot().logs,[]);
});

for(const failFinalIdentity of [false,true]){
  test(`automatic readiness stays false until final scan identity ${failFinalIdentity?'fails':'succeeds'}`,async()=>{
    const {c,adapter}=await setup();let identityCalls=0,started!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve}),reply=new Promise<void>(resolve=>{release=resolve});
    adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:1});
    adapter.identity=async()=>{
      if(++identityCalls===2){started();await reply;if(failFinalIdentity)throw new Error('ACCOUNT_CHANGED: Synthetic final identity mismatch');}
      return adapter.account;
    };
    const running=c.scan();await ready;
    assert.equal(c.getSnapshot().checked,1);assert.equal(c.getSnapshot().autoReady,false);
    await c.startAuto();assert.deepEqual(adapter.writes,[]);
    release();await running;
    assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().autoReady,!failFinalIdentity);
    await c.startAuto();
    if(failFinalIdentity){assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.deepEqual(adapter.writes,[]);}
    else{assert.equal(c.getSnapshot().error,null);assert.deepEqual(adapter.writes,['1']);}
  });
}

test('automatic pause with unavailable entries retains eligibility and resumes remaining rows only after a new start',{timeout:2000},async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'},{id:'2',handle:'bob',name:'Bob'}],nextCursor:'0',unavailableCount:2});
  await c.scan();c.setPacing(5,2);let paused=false;
  const unsubscribe=c.subscribe(()=>{
    if(!paused&&c.getSnapshot().logs.some(entry=>entry.targetId==='1'&&entry.result==='verified')){paused=true;setImmediate(()=>c.pause());}
  });
  try{await c.startAuto();}finally{unsubscribe();}
  assert.equal(paused,true);assert.deepEqual(adapter.writes,['1']);assert.equal(c.getSnapshot().phase,'paused');
  assert.equal(c.getSnapshot().autoReady,true);assert.equal(c.getSnapshot().complete,false);assert.equal(c.getSnapshot().canResumeScan,false);
  await c.resumeScan();assert.deepEqual(adapter.writes,['1']);
  await c.startAuto();assert.deepEqual(adapter.writes,['1','2']);assert.equal(c.getSnapshot().unavailableCount,2);
});

test('automatic eligibility cannot survive an account switch during automatic reconnect',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:1});
  await c.scan();assert.equal(c.getSnapshot().autoReady,true);
  adapter.changed=true;await c.startAuto();
  assert.match(c.getSnapshot().error!,/^ACCOUNT_CHANGED:/);assert.equal(c.getSnapshot().autoReady,false);
  assert.equal(c.getSnapshot().complete,false);assert.deepEqual(c.getSnapshot().rows,[]);assert.deepEqual(adapter.writes,[]);
});

test('clearing a successfully scanned account also clears automatic eligibility',async()=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:1});
  await c.scan();assert.equal(c.getSnapshot().autoReady,true);await c.clearLocalData();
  assert.equal(c.getSnapshot().autoReady,false);await c.startAuto();
  assert.match(c.getSnapshot().error!,/^INCOMPLETE:/);assert.deepEqual(adapter.writes,[]);
});

test('unavailable entries do not requeue an uncertain automatic mutation after reopening',async()=>{
  const {c,adapter,memory}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:1});
  await c.scan();let attempts=0;
  adapter.unfollow=async()=>{attempts++;throw new Error('UNCERTAIN: Synthetic result was not received');};
  await c.startAuto();assert.equal(attempts,1);assert.equal(c.getSnapshot().rows[0].outcome,'uncertain');
  await c.startAuto();assert.equal(attempts,1);
  const reopened=new Controller(adapter,memory,false,0);await reopened.initialize();await reopened.scan();
  assert.equal(reopened.getSnapshot().autoReady,true);await reopened.startAuto();
  assert.equal(attempts,1);assert.deepEqual(memory.data.unresolved['99'],['1']);assert.deepEqual(adapter.writes,[]);
});

test('CSV keeps incomplete coverage and unavailable counts while exporting separate automatic readiness',async(t)=>{
  const {c,adapter}=await setup();
  adapter.following=async()=>({users:[{id:'1',handle:'alice',name:'Alice'}],nextCursor:'0',unavailableCount:2});
  await c.scan();let exported!:Blob,clicks=0;
  const documentBefore=Object.getOwnPropertyDescriptor(globalThis,'document');
  const link={href:'',download:'',click:()=>{clicks++;}};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>link}});
  t.after(()=>{if(documentBefore)Object.defineProperty(globalThis,'document',documentBefore);else Reflect.deleteProperty(globalThis,'document');});
  t.mock.method(URL,'createObjectURL',(blob:Blob)=>{exported=blob;return 'blob:synthetic-export';});
  c.exportCsv();
  const [header,row]=(await exported.text()).trim().split('\r\n').map(line=>line.split(','));
  assert.deepEqual(header.slice(-3),['"scanned_at"','"unavailable_entries"','"auto_ready"']);
  assert.equal(row[7],'"false"');assert.deepEqual(row.slice(-2),['"2"','"true"']);
  assert.equal(link.download,csvFileName('tester',c.getSnapshot().scannedAt));assert.match(link.download,/^whitewolf-tester-\d{8}-\d{4}\.csv$/);
  assert.equal(clicks,1);assert.deepEqual(adapter.writes,[]);
});

test('CSV file names use the scan time and only the X username alphabet',()=>{
  const at=new Date(2026,9,3,7,5).getTime();
  assert.equal(csvFileName('Alice_01',at),'whitewolf-Alice_01-20261003-0705.csv');
  assert.equal(csvFileName('@a/b..c\\d',at),'whitewolf-abcd-20261003-0705.csv');
  assert.equal(csvFileName(undefined,null,at),'whitewolf-20261003-0705.csv');
});
