/** The page bundle runs in X's MAIN world. Nothing from this context is sent to the extension UI. */
export type NativeRequest = {path:string;method:string;host?:string;uri?:string;params?:Record<string,unknown>;data?:unknown;headers?:Record<string,string>;timeout?:number};
export type NativeResponse = {body:string;status:number;headers:Record<string,string>;request:NativeRequest};
export type NativeFilter = (request:NativeRequest,next:(request:NativeRequest)=>Promise<NativeResponse>)=>Promise<NativeResponse>;
export type NativeHttp = {host:()=>string;filters:NativeFilter[];dispatch:(request:NativeRequest)=>Promise<NativeResponse>};
export type Descriptor = {queryId:string;operationName:string;features:string[];fieldToggles:string[]};
export type XContext = {http:NativeHttp;features:{getValueWithoutScribeImpression:(key:string)=>unknown};queries:Record<string,Descriptor>};

type NativeStage = 'actor'|'root'|'rootMarker'|'fiberScan'|'fiberNodeLimit'|'fiberTimeLimit'|'fiberChanged'|'storeSelection'|'storeActor'|'apiService'|'apiShape'|'webpack'|'runtime'|'factories'|'queries'|'metadata'|'clientShape'|'clientConstruction';
type DiagnosticCounts = {rootMarkers:number;visited:number;stores:number;matchedActor:number;queryFound:number};
const diagnosticErrors = new WeakMap<object,string>();
const emptyCounts = ():DiagnosticCounts => ({rootMarkers:0,visited:0,stores:0,matchedActor:0,queryFound:0});

/** Only errors created here can supply diagnostics. External messages and lookalike objects are ignored. */
export function nativeDiagnostic(error:unknown):string|undefined {
  return error!==null&&(typeof error==='object'||typeof error==='function')?diagnosticErrors.get(error):undefined;
}

const unavailable = (stage:NativeStage,counts:DiagnosticCounts=emptyCounts()):never => {
  // Native errors may contain request headers. Never retain their message, cause, or object.
  const error=new Error('API_UNAVAILABLE: The current X web client could not be located. Refresh the signed-in X page and reopen the extension.');
  diagnosticErrors.set(error,`stage=${stage}; rootMarkers=${counts.rootMarkers}; visited=${counts.visited}; stores=${counts.stores}; matchedActor=${counts.matchedActor}; queryFound=${counts.queryFound}`);
  throw error;
};
const object = (value:unknown):Record<string,unknown>|undefined => value!==null&&typeof value==='object'?value as Record<string,unknown>:undefined;
const queryNames = ['Viewer','Following','UserByRestId','UserByScreenName'];

/** Accept only the complete, literal-only metadata factory shape used by the current X bundle. */
function descriptorFromFactory(source:string,failMetadata:()=>never):Descriptor|undefined {
  if(source.length>16000)return undefined;
  const assignment=source.match(/^(?:function(?:\s+[A-Za-z_$][\w$]*)?\s*|(?:[A-Za-z_$][\w$]*|\d+)\s*)?\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*(?:"use strict";\s*)?\1\.exports\s*=\s*(\{[\s\S]*\})\s*;?\s*\}$/);
  if(!assignment)return undefined;
  // The full anchored match prevents keys inside other identifiers or string values from matching.
  // No source is evaluated and no webpack factory is invoked, including metadata factories.
  const text='"(?:[^"\\\\]|\\\\.)*"';
  const list='\\[\\s*(?:'+text+'(?:\\s*,\\s*'+text+')*)?\\s*\\]';
  const key=(name:string)=>'(?:'+name+'|"'+name+'")\\s*:\\s*';
  const literal=new RegExp('^\\{\\s*'+key('queryId')+'"([A-Za-z0-9_-]{8,100})"\\s*,\\s*'+key('operationName')+'"(Viewer|Following|UserByRestId|UserByScreenName)"\\s*,\\s*'+key('operationType')+'"query"\\s*,\\s*'+key('metadata')+'\\{\\s*'+key('featureSwitches')+'('+list+')\\s*,\\s*'+key('fieldToggles')+'('+list+')\\s*\\}\\s*\\}\\s*$');
  const fields=assignment[2].match(literal);
  if(!fields)return undefined;
  const readList=(value:string):string[]=>{
    let parsed:unknown;
    try{parsed=JSON.parse(value);}catch{return failMetadata();}
    if(!Array.isArray(parsed)||parsed.length>200||parsed.some(item=>typeof item!=='string'||!/^[A-Za-z0-9_]{1,160}$/.test(item))||new Set(parsed).size!==parsed.length)return failMetadata();
    return parsed as string[];
  };
  return {queryId:fields[1],operationName:fields[2],features:readList(fields[3]),fieldToggles:readList(fields[4])};
}

export function getXContext(actorId:string):XContext {
  let stage:NativeStage='actor';
  const counts=emptyCounts();
  const fail=():never=>unavailable(stage,counts);
  try {
    if(!/^[1-9][0-9]{0,19}$/.test(actorId))return fail();
    stage='root';
    const root=document.getElementById('react-root');
    if(!root)return fail();
    stage='rootMarker';
    const markers:unknown[]=[];
    for(const key of Object.keys(root))if(/^__react(?:Container|Fiber)\$/.test(key))markers.push((root as unknown as Record<string,unknown>)[key]);
    counts.rootMarkers=markers.length;
    if(!markers.length)return fail();
    // React keeps the original HostRoot marker on the DOM container. Its FiberRoot.current
    // points to the committed tree; pendingProps can belong to an uncommitted transition.
    const committed=(marker:unknown):unknown=>{const value=object(marker);return object(object(value?.stateNode)?.current)??object(value?.current)??value;};
    const roots=markers.map(committed);
    const queue:unknown[]=[...roots];
    stage='fiberScan';
    const seen=new Set<object>();
    const stores=new Map<object,{store:Record<string,unknown>;actorId:string}>();
    const checkedStores=new Set<object>();
    // A normal X page can exceed 12000 fibers. Complete the committed-tree scan so
    // a later conflicting store cannot be missed, while bounding pathological trees.
    const maxFibers=250000,maxScanMs=1500;
    const clock=():number=>typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now();
    const started=clock();
    const checkTime=():void=>{const elapsed=clock()-started;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>maxScanMs)unavailable('fiberTimeLimit',counts);};
    for(let cursor=0;cursor<queue.length;cursor++){
      const fiber=object(queue[cursor]);
      if(!fiber||seen.has(fiber))continue;
      if(seen.size>=maxFibers)return unavailable('fiberNodeLimit',counts);
      seen.add(fiber);
      counts.visited=seen.size;
      if((seen.size&255)===0)checkTime();
      for(const rawProps of [fiber.memoizedProps]){
        const props=object(rawProps);if(!props)continue;
        for(const candidate of [props.store,object(props.value)?.store]){
          const store=object(candidate);
          if(!store||checkedStores.has(store)||typeof store.getState!=='function'||typeof store.dispatch!=='function')continue;
          checkedStores.add(store);
          const state=object(Reflect.apply(store.getState,store,[]));
          const currentActor=object(state?.session)?.user_id;
          if(typeof currentActor==='string'&&/^[1-9][0-9]{0,19}$/.test(currentActor)){
            stores.set(store,{store,actorId:currentActor});
            counts.stores=stores.size;
            if(currentActor===actorId)counts.matchedActor++;
          }
        }
      }
      for(const child of [fiber.child,fiber.sibling])if(object(child))queue.push(child);
    }
    checkTime();
    if(markers.some((marker,index)=>committed(marker)!==roots[index]))return unavailable('fiberChanged',counts);
    // Distinct stores in the committed tree remain ambiguous. Repeated references to the
    // same store are normal and deduplicated; no account or ambiguity check is relaxed.
    stage='storeSelection';
    if(stores.size!==1)return fail();
    const selected=stores.values().next().value;
    stage='storeActor';
    if(!selected||selected.actorId!==actorId)return fail();
    // X's first middleware is thunk with a getter for its existing API service. This returns
    // that reference; it dispatches no action, makes no request, and never serializes state.
    stage='apiService';
    const service=object(Reflect.apply(selected.store.dispatch as Function,selected.store,[(_dispatch:unknown,_getState:unknown,extra:unknown)=>object(extra)?.api]));
    stage='apiShape';
    const api=object(service?.apiClient),http=api?.client as NativeHttp|undefined,features=api?.featureSwitches as XContext['features']|undefined;
    stage='storeActor';
    const freshState=object(Reflect.apply(selected.store.getState as Function,selected.store,[]));
    if(markers.some((marker,index)=>committed(marker)!==roots[index]))return unavailable('fiberChanged',counts);
    if(object(freshState?.session)?.user_id!==actorId)return fail();
    stage='apiShape';
    if(!http||!features||typeof http.dispatch!=='function'||typeof http.host!=='function'||!Array.isArray(http.filters)||http.filters.length>100||http.filters.some(filter=>typeof filter!=='function')||typeof features.getValueWithoutScribeImpression!=='function')return fail();

    stage='webpack';
    const chunks=(window as unknown as Record<string,unknown>).webpackChunk_twitter_responsive_web;
    if(!Array.isArray(chunks)||typeof chunks.push!=='function')return fail();
    stage='runtime';
    let runtime:{m?:Record<string,Function>}|undefined;
    const marker=[['reciprocal_metadata_'+crypto.randomUUID()],{},(require:unknown)=>{runtime=require as typeof runtime;}];
    try{chunks.push(marker);}finally{if(chunks[chunks.length-1]===marker)chunks.pop();}
    if(!runtime?.m)return fail();
    stage='factories';
    const factories=Object.values(runtime.m);
    if(factories.length>20000)return fail();
    stage='queries';
    const queries:Record<string,Descriptor>=Object.create(null);
    for(const factory of factories){
      if(typeof factory!=='function')continue;
      const descriptor=descriptorFromFactory(Function.prototype.toString.call(factory),()=>unavailable('metadata',counts));
      if(!descriptor)continue;
      if(queries[descriptor.operationName])return fail();
      queries[descriptor.operationName]=descriptor;
      counts.queryFound++;
    }
    if(queryNames.some(name=>!queries[name]))return fail();
    return {http,features,queries};
  } catch(error) {
    if(nativeDiagnostic(error)!==undefined)throw error;
    return fail();
  }
}

/** A separate client preserves X's current signing filters but never installs a retry filter. */
export function singleRequestClient(context:XContext,dispatcher:(request:NativeRequest)=>Promise<NativeResponse>):NativeHttp {
  let stage:NativeStage='clientShape';
  try {
    const Ctor=context.http.constructor as new (options:unknown)=>NativeHttp;
    if(typeof Ctor!=='function')return unavailable(stage);
    const pass:NativeFilter=(request,next)=>next(request);
    stage='clientConstruction';
    const client=new Ctor({host:()=>context.http.host(),filters:[...context.http.filters],retryFilter:pass,errorFilter:pass,dispatcher});
    stage='clientShape';
    if(!client||client===context.http||typeof client.dispatch!=='function')return unavailable(stage);
    return client;
  } catch(error) {
    if(nativeDiagnostic(error)!==undefined)throw error;
    return unavailable(stage);
  }
}
