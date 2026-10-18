import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type * as Native from '../src/x-native';

const compiled=buildSync({entryPoints:[fileURLToPath(new URL('../src/x-native.ts',import.meta.url))],bundle:true,
  platform:'browser',format:'cjs',target:'chrome120',write:false}).outputFiles[0].text;
const actorId='1922333444555666777';
const secret='private-header-and-state-must-not-leak';
const fixedMessage='API_UNAVAILABLE: The current X web client could not be located. Refresh the signed-in X page and reopen the extension.';

function harness(now:()=>number=()=>0){
  function viewer(e:{exports:unknown}){e.exports={queryId:"fixtureViewer01",operationName:"Viewer",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};}
  function following(e:{exports:unknown}){e.exports={queryId:"fixtureFollowing01",operationName:"Following",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};}
  function byId(e:{exports:unknown}){e.exports={queryId:"fixtureById01",operationName:"UserByRestId",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};}
  function byName(e:{exports:unknown}){e.exports={queryId:"fixtureByName01",operationName:"UserByScreenName",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};}
  let nativeCalls=0,thunkCalls=0;
  const http={host:()=> 'https://x.com/i/api',filters:[] as Native.NativeFilter[],dispatch:async(request:Native.NativeRequest)=>{
    nativeCalls++;return {body:'{}',status:200,headers:{},request};
  }};
  const features={getValueWithoutScribeImpression:()=>false};
  const service={apiClient:{client:http,featureSwitches:features}};
  const state={session:{user_id:actorId},privateState:secret};
  const store={getState:()=>state,dispatch:(thunk:Function)=>{thunkCalls++;return thunk(undefined,undefined,{api:service});}};
  const fiber:Record<string,unknown>={memoizedProps:{store}};
  let root:unknown={__reactContainer$fixture:fiber};
  const runtime:{m:Record<string,Function>|undefined}={m:{viewer,following,byId,byName}};
  const chunks:unknown[]=[];
  chunks.push=function(...values:unknown[]):number{
    for(const value of values)if(Array.isArray(value)&&typeof value[2]==='function')value[2](runtime);
    return Array.prototype.push.apply(this,values);
  };
  const window:Record<string,unknown>={webpackChunk_twitter_responsive_web:chunks};
  const document={getElementById:()=>root};
  const moduleValue={exports:{} as typeof Native};
  runInNewContext(compiled,{module:moduleValue,exports:moduleValue.exports,window,document,crypto:{randomUUID:()=> 'fixture'},performance:{now}});
  return {native:moduleValue.exports,document,window,store,state,fiber,http,features,service,runtime,chunks,
    setRoot:(value:unknown)=>{root=value;},counts:()=>({nativeCalls,thunkCalls})};
}

function chain(first:Record<string,unknown>,length:number,duplicateEdges=false):Record<string,unknown>{
  let tail=first;
  for(let index=1;index<length;index++){
    const next:Record<string,unknown>={};
    tail.child=next;
    if(duplicateEdges)tail.sibling=next;
    tail=next;
  }
  return tail;
}

function failure(h:ReturnType<typeof harness>,stage:string,run:()=>unknown=()=>h.native.getXContext(actorId)){
  let caught:unknown;
  try{run();}catch(error){caught=error;}
  assert.ok(caught,'Expected native discovery to fail');
  assert.equal((caught as Error).message,fixedMessage);
  assert.equal(Object.prototype.hasOwnProperty.call(caught,'cause'),false);
  const diagnostic=h.native.nativeDiagnostic(caught);
  assert.match(diagnostic??'',new RegExp('^stage='+stage+'; rootMarkers=\\d+; visited=\\d+; stores=\\d+; matchedActor=\\d+; queryFound=\\d+$'));
  assert.equal(diagnostic?.includes(actorId),false);
  assert.equal(diagnostic?.includes(secret),false);
  assert.equal(diagnostic?.includes('fixtureViewer01'),false);
  assert.equal(h.counts().nativeCalls,0);
  return {error:caught as Error,diagnostic:diagnostic!};
}

test('valid discovery returns existing references without sending native requests or retaining a runtime marker',()=>{
  const h=harness(),context=h.native.getXContext(actorId);
  assert.equal(context.http,h.http);assert.equal(context.features,h.features);
  assert.deepEqual(Object.keys(context.queries).sort(),['Following','UserByRestId','UserByScreenName','Viewer']);
  assert.deepEqual(h.counts(),{nativeCalls:0,thunkCalls:1});assert.equal(h.chunks.length,0);
});

test('native diagnostics require the exact privately marked error and never read external error properties',()=>{
  const h=harness(),{error,diagnostic}=failure(h,'actor',()=>h.native.getXContext('invalid'));
  error.message=secret;
  assert.equal(h.native.nativeDiagnostic(error),diagnostic);
  for(const value of [null,undefined,secret,42,new Error(fixedMessage),{message:fixedMessage,stage:'actor'},Object.assign({},error),
    new Proxy(error,{get(){throw new Error(secret);}}),new Proxy({},{get(){throw new Error(secret);}})]){
    assert.equal(h.native.nativeDiagnostic(value),undefined);
  }
});

test('actor, root, and missing marker failures have distinct stages and zero sensitive details',()=>{
  let h=harness();failure(h,'actor',()=>h.native.getXContext('0'));
  h=harness();h.setRoot(null);failure(h,'root');
  h=harness();h.setRoot({});failure(h,'rootMarker');
  h=harness();h.document.getElementById=()=>{throw new Error(secret);};failure(h,'root');
  h=harness();h.setRoot(new Proxy({},{ownKeys(){throw new Error(secret);}}));failure(h,'rootMarker');
});

test('fiber exceptions are replaced with fixed errors without reading their messages or causes',()=>{
  const h=harness();
  Object.defineProperty(h.fiber,'memoizedProps',{get(){throw new Proxy({},{get(){throw new Error('Untrusted error property was read');}});}});
  const {diagnostic}=failure(h,'fiberScan');
  assert.equal(diagnostic,'stage=fiberScan; rootMarkers=1; visited=1; stores=0; matchedActor=0; queryFound=0');
});

test('store selection counts distinct stores, deduplicates Provider references, and fails closed on ambiguity',()=>{
  const h=harness();
  h.fiber.child={memoizedProps:{value:{store:h.store}},sibling:{memoizedProps:{store:{getState:()=>h.state,dispatch:h.store.dispatch}}}};
  const {diagnostic}=failure(h,'storeSelection');
  assert.equal(diagnostic,'stage=storeSelection; rootMarkers=1; visited=3; stores=2; matchedActor=2; queryFound=0');
  assert.equal(h.counts().thunkCalls,0);
});

test('only the committed root and memoized props contribute stores; pending props are never read',()=>{
  const h=harness();
  const staleStore={getState:()=>({session:{user_id:'2'}}),dispatch:h.store.dispatch};
  h.setRoot({__reactContainer$fixture:{stateNode:{current:h.fiber},child:{memoizedProps:{store:staleStore}}}});
  Object.defineProperty(h.fiber,'pendingProps',{get(){throw new Error(secret);}});
  assert.equal(h.native.getXContext(actorId).http,h.http);
  assert.equal(h.counts().thunkCalls,1);
});

test('changing the committed root during service lookup fails before any request',()=>{
  const h=harness(),fiberRoot={current:h.fiber};
  h.setRoot({__reactContainer$fixture:{stateNode:fiberRoot}});
  h.store.dispatch=()=>{fiberRoot.current={memoizedProps:{store:h.store}};return h.service;};
  failure(h,'fiberChanged');
});

test('a valid graph larger than 12000 fibers is scanned completely, including duplicate edges and a cycle',()=>{
  const h=harness(),tail=chain(h.fiber,18000,true);
  let tailReads=0;
  Object.defineProperty(tail,'memoizedProps',{get(){tailReads++;return undefined;}});
  tail.child=h.fiber;tail.sibling=tail;
  assert.equal(h.native.getXContext(actorId).http,h.http);
  assert.equal(tailReads,1);
  assert.deepEqual(h.counts(),{nativeCalls:0,thunkCalls:1});
});

test('a second distinct store beyond 12000 fibers is rejected for either the same actor or a different actor',()=>{
  for(const secondActor of [actorId,'2']){
    const h=harness(),tail=chain(h.fiber,16001);
    tail.memoizedProps={store:{getState:()=>({session:{user_id:secondActor}}),dispatch:h.store.dispatch}};
    const {diagnostic}=failure(h,'storeSelection');
    assert.equal(diagnostic,`stage=storeSelection; rootMarkers=1; visited=16001; stores=2; matchedActor=${secondActor===actorId?2:1}; queryFound=0`);
    assert.equal(h.counts().thunkCalls,0);
  }
});

test('exactly 250000 fibers are accepted and a 250001st fiber is rejected before another service lookup',()=>{
  const h=harness(),tail=chain(h.fiber,250000);
  assert.equal(h.native.getXContext(actorId).http,h.http);
  assert.equal(h.counts().thunkCalls,1);
  tail.child={};
  const {diagnostic}=failure(h,'fiberNodeLimit');
  assert.equal(diagnostic,'stage=fiberNodeLimit; rootMarkers=1; visited=250000; stores=1; matchedActor=1; queryFound=0');
  assert.equal(h.counts().thunkCalls,1);
});

test('an injected clock stops an over-time scan before reaching its tail or obtaining the API service',()=>{
  let clockReads=0,tailReads=0;
  const h=harness(()=>clockReads++===0?0:1501),tail=chain(h.fiber,1024);
  Object.defineProperty(tail,'memoizedProps',{get(){tailReads++;return undefined;}});
  const {diagnostic}=failure(h,'fiberTimeLimit');
  assert.ok(clockReads>=2);
  assert.ok(Number(diagnostic.match(/visited=(\d+);/)?.[1])<1024);
  assert.equal(tailReads,0);assert.equal(h.counts().thunkCalls,0);
});

test('the final time check rejects a slow scan shorter than the periodic check interval',()=>{
  let elapsed=0;
  const h=harness(()=>elapsed);
  Object.defineProperty(h.fiber,'memoizedProps',{get(){elapsed=1501;return {store:h.store};}});
  const {diagnostic}=failure(h,'fiberTimeLimit');
  assert.match(diagnostic,/visited=1; stores=1; matchedActor=1; queryFound=0$/);
  assert.equal(h.counts().thunkCalls,0);
});

test('cycles and repeated references count each visited fiber and matching store exactly once',()=>{
  const h=harness(),shared={memoizedProps:{store:h.store},child:h.fiber,sibling:h.fiber};
  h.fiber.child=shared;h.fiber.sibling=shared;
  delete h.runtime.m!.byName;
  assert.equal(failure(h,'queries').diagnostic,'stage=queries; rootMarkers=1; visited=2; stores=1; matchedActor=1; queryFound=3');
  assert.equal(h.counts().thunkCalls,1);
});

test('missing store and mismatching actor fail at separate stages without reporting actor IDs',()=>{
  let h=harness();h.fiber.memoizedProps={};failure(h,'storeSelection');
  h=harness();h.state.session.user_id='2';
  assert.equal(failure(h,'storeActor').diagnostic,'stage=storeActor; rootMarkers=1; visited=1; stores=1; matchedActor=0; queryFound=0');
});

test('thunk exceptions are apiService diagnostics, while invalid client fields are apiShape diagnostics',()=>{
  let h=harness();h.store.dispatch=()=>{throw new Error(secret);};failure(h,'apiService');
  h=harness();Object.defineProperty(h.service,'apiClient',{get(){throw new Error(secret);}});failure(h,'apiShape');
  h=harness();Object.defineProperty(h.http,'filters',{value:[null]});failure(h,'apiShape');
});

test('actor change after obtaining the API is reported at storeActor',()=>{
  const h=harness();h.store.dispatch=()=>{h.state.session.user_id='2';return h.service;};
  failure(h,'storeActor');
});

test('webpack absence and missing runtime module exposure remain distinct',()=>{
  let h=harness();h.window.webpackChunk_twitter_responsive_web=undefined;failure(h,'webpack');
  h=harness();h.runtime.m=undefined;failure(h,'runtime');assert.equal(h.chunks.length,0);
  h=harness();h.chunks.push=()=>{throw new Error(secret);};failure(h,'runtime');
});

test('factory enumeration failures and excessive factory counts fail at factories',()=>{
  let h=harness();h.runtime.m=new Proxy({},{ownKeys(){throw new Error(secret);}});failure(h,'factories');
  h=harness();h.runtime.m=Object.fromEntries(Array.from({length:20001},(_,index)=>[String(index),()=>{}]));failure(h,'factories');
});

test('query diagnostics report only the number of accepted descriptors',()=>{
  const h=harness();delete h.runtime.m!.byName;
  assert.equal(failure(h,'queries').diagnostic,'stage=queries; rootMarkers=1; visited=1; stores=1; matchedActor=1; queryFound=3');
});

test('duplicate query descriptors fail closed without invoking any factory',()=>{
  const h=harness();h.runtime.m!.duplicate=h.runtime.m!.viewer;
  h.runtime.m!.unrelated=()=>{throw new Error(secret);};
  const {diagnostic}=failure(h,'queries');assert.match(diagnostic,/queryFound=4$/);
});

test('invalid metadata lists and malformed JSON escapes retain the metadata stage through the outer catch',()=>{
  function duplicateFeatures(e:{exports:unknown}){e.exports={queryId:"fixtureViewer01",operationName:"Viewer",operationType:"query",metadata:{featureSwitches:["repeat","repeat"],fieldToggles:[]}};}
  let h=harness();h.runtime.m!.viewer=duplicateFeatures;failure(h,'metadata');
  h=harness();h.runtime.m!.viewer=runInNewContext('(function(e){e.exports={queryId:"fixtureViewer01",operationName:"Viewer",operationType:"query",metadata:{featureSwitches:["\\x61"],fieldToggles:[]}}})') as Function;
  failure(h,'metadata');
});

test('a previously marked native error remains marked when encountered in a later discovery stage',()=>{
  const h=harness(),first=failure(h,'actor',()=>h.native.getXContext('0'));
  h.store.dispatch=()=>{throw first.error;};
  const second=failure(h,'actor');assert.equal(second.error,first.error);assert.equal(second.diagnostic,first.diagnostic);
});

test('singleRequestClient uses fixed clientShape and clientConstruction diagnostics without external messages',()=>{
  const dispatcher=async(request:Native.NativeRequest)=>({body:'{}',status:200,headers:{},request});
  let h=harness(),context=h.native.getXContext(actorId);
  Object.defineProperty(h.http,'constructor',{value:null});failure(h,'clientShape',()=>h.native.singleRequestClient(context,dispatcher));
  h=harness();context=h.native.getXContext(actorId);
  Object.defineProperty(h.http,'constructor',{get(){throw new Error(secret);}});failure(h,'clientShape',()=>h.native.singleRequestClient(context,dispatcher));
  h=harness();context=h.native.getXContext(actorId);
  Object.defineProperty(h.http,'constructor',{value:class{constructor(){throw new Error(secret);}}});failure(h,'clientConstruction',()=>h.native.singleRequestClient(context,dispatcher));
  h=harness();context=h.native.getXContext(actorId);
  Object.defineProperty(h.http,'constructor',{value:class{}});failure(h,'clientShape',()=>h.native.singleRequestClient(context,dispatcher));
});

test('singleRequestClient creates an independent client and copies filters without dispatching',()=>{
  const h=harness(),context=h.native.getXContext(actorId);
  let options:Record<string,unknown>|undefined;
  class Client{dispatch(){return Promise.resolve({});}constructor(value:Record<string,unknown>){options=value;}}
  Object.defineProperty(h.http,'constructor',{value:Client});
  const dispatcher=async(request:Native.NativeRequest)=>({body:'{}',status:200,headers:{},request});
  const client=h.native.singleRequestClient(context,dispatcher);
  assert.notEqual(client,h.http);assert.equal(options?.dispatcher,dispatcher);assert.notEqual(options?.filters,h.http.filters);
  assert.equal(typeof options?.retryFilter,'function');assert.equal(typeof options?.errorFilter,'function');assert.equal(h.counts().nativeCalls,0);
});
