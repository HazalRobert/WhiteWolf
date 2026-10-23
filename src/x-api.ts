import type { Account, FollowingPage, Person, Relation } from './types';
import { getXContext, nativeDiagnostic, singleRequestClient, type XContext, type NativeRequest, type NativeResponse } from './x-native';
import { parseXPayload } from './x-parsers';
import { isValidCursor } from './cursor';

export type PageOperation =
  | { kind: 'connect' }
  | { kind: 'cancel' }
  | { kind: 'probe' }
  | { kind: 'identity'; actorId: string }
  | { kind: 'following'; actorId: string; cursor: string }
  | { kind: 'relations'; actorId: string; ids: string[] }
  | { kind: 'resolve'; actorId: string; handle: string }
  | { kind: 'prepareUnfollow'; actorId: string; targetId: string }
  | { kind: 'unfollow'; actorId: string; targetId: string; automatic?: boolean; proofId?: string }
  | { kind: 'followAuthor'; actorId: string };

type ParserKind = 'person' | 'following' | 'relations' | 'relationship';
export type RuntimeInput =
  | { type: 'PAGE'; sessionId: string; bootId: string; operation: PageOperation }
  | { type: 'PARSE'; parser: ParserKind; payload: unknown; ids?: string[]; actorId?: string; targetId?: string };
export type RuntimeResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Bundled as x-page.js and injected into X's MAIN world; session material stays in that page. */
export function xPageRuntime(input: RuntimeInput): RuntimeResult | Promise<RuntimeResult> {
  const safeErrors = new WeakSet<Error>();
  const fail = (code: string, message: string): never => { const error=new Error(`${code}: ${message}`);safeErrors.add(error);throw error; };
  const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('SCHEMA', 'Expected an object.');
    return value as Record<string, unknown>;
  };
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) return fail('SCHEMA', 'Missing or invalid string user ID.');
    return value;
  };
  const handle = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(value)) return fail('SCHEMA', 'Invalid X handle.');
    return value;
  };
  const person = (raw: unknown): Person => {
    const value = record(raw);
    const userId = id(value.id_str);
    const username = handle(value.screen_name);
    if (typeof value.name !== 'string') return fail('SCHEMA', 'User name is missing.');
    const user: Person = { id: userId, handle: username, name: value.name };
    if (typeof value.description === 'string') user.bio = value.description;
    if (typeof value.profile_image_url_https === 'string' && /^https:\/\//i.test(value.profile_image_url_https)) user.avatar = value.profile_image_url_https;
    return user;
  };
  const following = (raw: unknown): FollowingPage => {
    const value = record(raw);
    if (!Array.isArray(value.users)) return fail('SCHEMA', 'Following page has no users array.');
    if (typeof value.next_cursor_str !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(value.next_cursor_str)) return fail('SCHEMA', 'Following page has no valid explicit next cursor.');
    if (value.users.length === 0 && value.next_cursor_str !== '0') return fail('SCHEMA', 'Empty page still has a continuation cursor.');
    const users = value.users.map(person);
    if (new Set(users.map(u => u.id)).size !== users.length) return fail('SCHEMA', 'Duplicate IDs inside a following page.');
    return { users, nextCursor: value.next_cursor_str };
  };
  const relations = (raw: unknown, requestedIds: string[]): Relation[] => {
    if (!Array.isArray(raw)) return fail('SCHEMA', 'Relationship lookup did not return an array.');
    requestedIds.forEach(id);
    const requested = new Set(requestedIds);
    if (requested.size !== requestedIds.length) return fail('SCHEMA', 'Duplicate requested relationship IDs.');
    const found = new Map<string, Relation>();
    const allowed = new Set(['following', 'following_requested', 'followed_by', 'none', 'blocking', 'muting']);
    for (const item of raw) {
      const value = record(item);
      const userId = id(value.id_str);
      if (!requested.has(userId) || found.has(userId)) return fail('SCHEMA', 'Unexpected or duplicate relationship ID.');
      if (value.connections === undefined || value.connections === null) {
        found.set(userId, { id: userId, following: null, followedBy: null });
        continue;
      }
      if (!Array.isArray(value.connections) || value.connections.some(c => typeof c !== 'string' || !allowed.has(c))) return fail('SCHEMA', 'Unknown relationship connection schema.');
      const connections = value.connections as string[];
      if (new Set(connections).size !== connections.length || (connections.includes('none') && connections.length !== 1)) return fail('SCHEMA', 'Contradictory relationship connections.');
      found.set(userId, connections.length === 0
        ? { id: userId, following: null, followedBy: null }
        : { id: userId, following: connections.includes('following'), followedBy: connections.includes('followed_by') });
    }
    return requestedIds.map(userId => found.get(userId) ?? { id: userId, following: null, followedBy: null });
  };
  const relationship = (raw: unknown, actorId: string, targetId: string): Relation => {
    const pair = record(record(raw).relationship);
    const source = record(pair.source);
    const target = record(pair.target);
    if (id(source.id_str) !== id(actorId) || id(target.id_str) !== id(targetId)) return fail('ACCOUNT_CHANGED', 'Relationship response is for a different account or target.');
    if (typeof source.following !== 'boolean' || typeof source.followed_by !== 'boolean') return fail('SCHEMA', 'Fresh relationship must contain both explicit boolean fields.');
    return { id: targetId, following: source.following, followedBy: source.followed_by };
  };
  const errorResult = (error: unknown): RuntimeResult => ({ ok: false, error: error instanceof Error ? error.message : 'NETWORK: Unknown adapter error.' });

  // Retained legacy parsers for offline compatibility tests. The page uses parseXPayload below.
  if (input.type === 'PARSE') {
    try {
      if (input.parser === 'person') return { ok: true, data: person(input.payload) };
      if (input.parser === 'following') return { ok: true, data: following(input.payload) };
      if (input.parser === 'relations') return { ok: true, data: relations(input.payload, input.ids ?? []) };
      return { ok: true, data: relationship(input.payload, input.actorId ?? '', input.targetId ?? '') };
    } catch (error) { return errorResult(error); }
  }

  return (async (): Promise<RuntimeResult> => {
    let mutationDispatched = false;
    let mutationAccepted = false;
    let writeValidUntil = 0;
    type Lease = { sessionId: string; bootId: string; cancelled: boolean; pendingWrite: boolean; context?:XContext; relations:Map<string,Relation>;
      proof?: { nonce: string; actorId: string; target: Person; at: number; used: boolean } };
    const page = window as typeof window & { __reciprocalXLeaseV1?: Lease };
    let lease: Lease | undefined;
    try {
      if (location.origin !== 'https://x.com') return fail('AUTH', 'Open the extension from an HTTPS x.com tab.');
      const operation = input.operation;
      if (operation.kind === 'cancel') {
        if (page.__reciprocalXLeaseV1?.sessionId === input.sessionId && page.__reciprocalXLeaseV1.bootId === input.bootId) page.__reciprocalXLeaseV1.cancelled = true;
        return { ok: true, data: null };
      }
      if (operation.kind === 'probe') {
        // Read-only lease check after a tab navigation; it never touches X or the lease itself.
        const current = page.__reciprocalXLeaseV1;
        return { ok: true, data: !!current && current.sessionId === input.sessionId && current.bootId === input.bootId && !current.cancelled };
      }
      if (operation.kind === 'connect') {
        if (page.__reciprocalXLeaseV1?.pendingWrite) return fail('UNCERTAIN', 'A previous write is still awaiting a result. Wait and reconnect.');
        if (page.__reciprocalXLeaseV1) page.__reciprocalXLeaseV1.cancelled = true;
        page.__reciprocalXLeaseV1 = { sessionId: input.sessionId, bootId: input.bootId, cancelled: false, pendingWrite: false, relations:new Map() };
      }
      lease = page.__reciprocalXLeaseV1;
      const requireLease = (): void => {
        if (!lease || page.__reciprocalXLeaseV1 !== lease || lease.sessionId !== input.sessionId || lease.bootId !== input.bootId || lease.cancelled) fail('CANCELLED', 'This run was paused, disconnected, or replaced. Reconnect before continuing.');
      };
      const cookie = (name: 'ct0' | 'twid'): string | null => {
        const item = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
        if (!item) return null;
        try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return null; }
      };
      const actorFromCookie = (): string => {
        const value = cookie('twid');
        const match = value?.match(/^"?u=([1-9][0-9]{0,19})"?$/);
        if (!match) return fail('AUTH', 'Cannot verify the current X session identity.');
        return match[1];
      };
      const expectedActor = operation.kind === 'connect' ? actorFromCookie() : id(operation.actorId);
      const guard = (): void => {
        requireLease();
        if (actorFromCookie() !== expectedActor) fail('ACCOUNT_CHANGED', 'The signed-in X account changed. Reconnect and scan again.');
      };
      guard();
      if (!cookie('ct0')) return fail('AUTH','The signed-in X session has no CSRF cookie.');
      if(operation.kind==='connect'&&lease){
        try{lease.context=getXContext(expectedActor);}catch(error){return fail('API_UNAVAILABLE',`X client connection failed. Diagnostic: ${nativeDiagnostic(error)??'stage=contextUnknown'}.`);}
      }
      const context=lease?.context;
      if(!context)return fail('API_UNAVAILABLE','The current X web client is unavailable. Refresh the X page and reconnect.');
      const feature=(key:string):boolean=>{try{return context.features.getValueWithoutScribeImpression(key)===true;}catch{return fail('API_UNAVAILABLE','The current X feature settings are unavailable.');}};
      const request=async(operationName:string,path:string,params:Record<string,string>,targetId?:string):Promise<unknown>=>{
        guard();
        const write=targetId!==undefined,method=write?'POST':'GET';
        const abort=new AbortController();
        const deadline=Date.now()+20000;
        let closed=false,dispatchCount=0,timer:ReturnType<typeof setTimeout>|undefined;
        const dispatcher=async(native:NativeRequest):Promise<NativeResponse>=>{
          if(closed||abort.signal.aborted||Date.now()>=deadline)return fail('CANCELLED','The request deadline passed before sending.');
          guard();
          if(++dispatchCount!==1)return fail('NETWORK','A native filter attempted to repeat a request; repetition was blocked.');
          const url=new URL(native.uri??'',location.origin);
          if(!['https://x.com','https://api.x.com'].includes(url.origin)||url.username||url.password||url.search||url.hash||![path,`/i/api${path}`].includes(url.pathname)||native.method!==method)return fail('SCHEMA','The native client changed the permitted request destination or method.');
          const headers=Object.fromEntries(Object.entries(native.headers??{}).map(([key,value])=>[key.toLowerCase(),String(value)]));
          for(const key of ['x-act-as-user-id','x-web-auth-multi-user-id'])if(headers[key]&&headers[key]!==expectedActor)return fail('ACCOUNT_CHANGED','The native client selected a different acting account.');
          if(!/^Bearer \S+$/.test(headers.authorization??'')||headers['x-csrf-token']!==cookie('ct0'))return fail('AUTH','The native client did not provide matching session credentials.');
          const query=new URLSearchParams();
          for(const [key,value]of Object.entries(native.params??{}))if(value!==undefined&&value!==null)query.set(key,String(value));
          // Do not allow filters to substitute the target or variables after our checks.
          for(const [key,value]of Object.entries(params))if(query.get(key)!==value)return fail('SCHEMA','Native request parameters changed unexpectedly.');
          let body:string|undefined;
          if(write){
            if(Date.now()>writeValidUntil)return fail('CANCELLED','Fresh verification expired while the native client was preparing the write.');
            if(typeof native.data!=='string'||!headers['content-type']?.startsWith('application/x-www-form-urlencoded'))return fail('SCHEMA','The native write was not encoded as a form.');
            body=native.data;
            const form=new URLSearchParams(body);
            if(form.getAll('user_id').length!==1||form.get('user_id')!==targetId||[...form.keys()].some(key=>key!=='user_id')||[...query.keys()].length!==0)return fail('SCHEMA','The native write target changed unexpectedly.');
          }else if(native.data!==undefined&&native.data!==null)return fail('SCHEMA','A read request unexpectedly contains a body.');
          url.search=query.toString();
          guard();
          if(write){if(!lease)return fail('CANCELLED','Missing run lease.');lease.pendingWrite=true;mutationDispatched=true;}
          const response=await fetch(url.href,{method,credentials:'include',mode:url.origin===location.origin?'same-origin':'cors',cache:'no-store',redirect:'error',signal:abort.signal,headers,...(body===undefined?{}:{body})});
          if(write&&response.ok)mutationAccepted=true;
          const responseHeaders:Record<string,string>={};response.headers.forEach((value,key)=>{responseHeaders[key.toLowerCase()]=value;});
          return {body:await response.text(),status:response.status,headers:responseHeaders,request:native};
        };
        try{
          const client=singleRequestClient(context,dispatcher);
          const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{closed=true;abort.abort();const error=new Error(`${write?'UNCERTAIN':'NETWORK'}: ${operationName} timed out; automatic retry is disabled.`);safeErrors.add(error);reject(error);},20000);});
          const response=await Promise.race([client.dispatch({path,method,params,headers:{'content-type':write?'application/x-www-form-urlencoded':'application/json'},...(write?{data:{user_id:targetId}}:{}),timeout:20000}),timeout]);
          if(dispatchCount!==1)return fail('API_UNAVAILABLE','The native client reused an existing request; fresh verification is unavailable.');
          guard();
          const detail=`${operationName} ${method} ${path}: HTTP ${response.status}; automatic retry is disabled.`;
          if(response.status===429){
            // X's reset header is epoch seconds. Report it only when it is plausible; it never schedules a retry.
            const reset=/^\d{9,11}$/.test(response.headers?.['x-rate-limit-reset']??'')?Number(response.headers['x-rate-limit-reset'])*1000:NaN;
            const resetAt=reset>Date.now()-60_000&&reset<Date.now()+86_400_000?`; resetAt=${new Date(reset).toISOString()}`:'';
            return fail('RATE_LIMIT',`${operationName} ${method} ${path}: HTTP 429${resetAt}; automatic retry is disabled.`);
          }
          if(response.status===401||response.status===403)return fail('AUTH',detail);
          if(response.status<200||response.status>=300)return fail(write?'UNCERTAIN':'HTTP',detail);
          if(write)return null;
          let data:unknown;try{data=JSON.parse(response.body);}catch{return fail('SCHEMA',`${operationName} returned a non-JSON response.`);}
          const envelope=record(data);
          if((envelope.errors!==undefined&&(!Array.isArray(envelope.errors)||envelope.errors.length>0))||envelope.error!==undefined)return fail('SCHEMA',`${operationName} returned an error envelope.`);
          return data;
        }catch(error){
          if(error instanceof Error&&safeErrors.has(error))throw error;
          const diagnostic=nativeDiagnostic(error);
          if(diagnostic)return fail(write?'UNCERTAIN':'API_UNAVAILABLE',`X client request setup failed. Diagnostic: ${diagnostic}.`);
          // Native errors can contain request headers. Never return their objects or messages.
          return fail(write?'UNCERTAIN':'NETWORK',`${operationName} request failed; automatic retry is disabled.`);
        }finally{closed=true;if(timer!==undefined)clearTimeout(timer);}
      };
      const graphql=(name:string,variables:Record<string,unknown>,toggles:Record<string,boolean>={}):Promise<unknown>=>{
        const descriptor=context.queries[name];
        if(!descriptor)return fail('API_UNAVAILABLE',`The current X client has no ${name} query metadata.`);
        let features:Record<string,boolean>;
        try{features=Object.fromEntries(descriptor.features.map(key=>[key,context.features.getValueWithoutScribeImpression(key)===true]));}catch{return fail('API_UNAVAILABLE','The current X query feature settings are unavailable.');}
        const fieldToggles=Object.fromEntries(descriptor.fieldToggles.filter(key=>Object.hasOwn(toggles,key)).map(key=>[key,toggles[key]]));
        return request(name,`/graphql/${descriptor.queryId}/${name}`,{variables:JSON.stringify(variables),...(descriptor.features.length?{features:JSON.stringify(features)}:{}),...(Object.keys(fieldToggles).length?{fieldToggles:JSON.stringify(fieldToggles)}:{})});
      };
      const parse=(...args:Parameters<typeof parseXPayload>):unknown=>{
        try{return parseXPayload(...args);}catch(error){return fail('SCHEMA',error instanceof Error&&error.message.startsWith('SCHEMA: ')?error.message.slice(8):'The X response schema was not recognized.');}
      };
      const verify=async():Promise<Account>=>{
        const account=parse('viewer',await graphql('Viewer',{withCommunitiesMemberships:feature('c9s_enabled')},{isDelegate:false,withAuxiliaryUserLabels:feature('blue_business_multi_affiliates_ui_enabled')})) as Account;
        if(account.id!==expectedActor)return fail('ACCOUNT_CHANGED','The verified account differs from this run.');
        guard();return {id:account.id,handle:account.handle,name:account.name,...(account.followingCount===undefined?{}:{followingCount:account.followingCount})};
      };
      const readUser=async(targetId:string):Promise<{person:Person;relation:Relation}>=>{
        const data=await graphql('UserByRestId',{userId:id(targetId)});
        const target=parse('userGraphql',data,{targetId}) as Person;
        const raw=record(record(record(data).data).user).result;
        return {person:target,relation:parse('relationFromUser',raw,{targetId}) as Relation};
      };
      const freshRelation=async(targetId:string):Promise<Relation>=>(await readUser(targetId)).relation;
      const resolve=async(username:string):Promise<Person>=>{
        const data=await graphql('UserByScreenName',{screen_name:handle(username),withGrokTranslatedBio:false},{withAuxiliaryUserLabels:feature('blue_business_multi_affiliates_ui_enabled'),withPayments:false});
        // Unknown and suspended names have no user or an explicit placeholder. This read-only lookup
        // failure is not a session or schema failure; any other shape still goes through the strict parser.
        const body=record(data).data,user=body&&typeof body==='object'&&!Array.isArray(body)?(body as Record<string,unknown>).user:undefined;
        const result=user&&typeof user==='object'&&!Array.isArray(user)?(user as Record<string,unknown>).result:undefined;
        if(body&&typeof body==='object'&&!Array.isArray(body)&&(user===undefined||user===null||(typeof user==='object'&&!Array.isArray(user)&&(result===undefined||result===null)&&Object.keys(user).every(key=>key==='result'))
          ||(!!result&&typeof result==='object'&&(result as Record<string,unknown>).__typename==='UserUnavailable')))return fail('NOT_FOUND',`@${username} is unavailable or does not exist on X.`);
        return parse('userGraphql',data) as Person;
      };

      if (operation.kind === 'connect' || operation.kind === 'identity') return { ok: true, data: await verify() };
      guard();
      if (operation.kind === 'following') {
        if (!isValidCursor(operation.cursor)) return fail('SCHEMA', 'Invalid input cursor.');
        const result=parse('followingGraphql',await graphql('Following',{userId:expectedActor,count:20,includePromotedContent:false,withGrokTranslatedBio:false,...(operation.cursor==='-1'?{}:{cursor:operation.cursor})}),{actorId:expectedActor,cursor:operation.cursor}) as FollowingPage&{relations:Relation[]};
        for(const relation of result.relations)lease!.relations.set(relation.id,relation);
        // Keep the same read-only page evidence with the controller checkpoint.
        // A paused scan reconnects with a new lease, whose local cache starts empty.
        return { ok: true, data: {users:result.users,nextCursor:result.nextCursor,relations:result.relations,...(result.unavailableCount?{unavailableCount:result.unavailableCount}:{})} };
      }
      if (operation.kind === 'relations') {
        if (operation.ids.length < 1 || operation.ids.length > 100) return fail('SCHEMA', 'Relationship lookup requires 1–100 IDs.');
        operation.ids.forEach(id);
        if(new Set(operation.ids).size!==operation.ids.length)return fail('SCHEMA','Duplicate requested relationship IDs.');
        return { ok: true, data: operation.ids.length===1?[await freshRelation(operation.ids[0])]:operation.ids.map(userId=>lease!.relations.get(userId)??{id:userId,following:null,followedBy:null}) };
      }
      if (operation.kind === 'resolve') return { ok: true, data: await resolve(operation.handle) };

      if (operation.kind === 'prepareUnfollow') {
        await verify();
        const fresh=await readUser(operation.targetId),target=fresh.person;
        if (target.id !== operation.targetId) return fail('SCHEMA', 'Target lookup returned a different user ID.');
        if (target.id === expectedActor) return fail('SKIPPED', 'The target is the signed-in account.');
        const before = fresh.relation;
        if (before.following !== true || before.followedBy !== false) return fail('SKIPPED', 'Fresh verification no longer identifies this account as a non-follower.');
        if (!lease) return fail('CANCELLED', 'The operation was cancelled.');
        const nonce = crypto.randomUUID();
        lease.proof = { nonce, actorId: expectedActor, target, at: Date.now(), used: false };
        return { ok: true, data: { target, proofId: nonce } };
      }
      let targetId: string;
      if (operation.kind === 'unfollow') {
        const proof = lease?.proof;
        if (!proof || proof.nonce !== operation.proofId || proof.used || proof.actorId !== expectedActor || proof.target.id !== operation.targetId || Date.now() - proof.at > 15_000) return fail('CANCELLED', 'Fresh verification expired or is missing. No write was sent.');
        proof.used = true;
        targetId = proof.target.id;
        writeValidUntil=proof.at+15000;
      } else {
        await verify();
        const author = await resolve('MagicalStocker');
        if (author.handle.toLowerCase() !== 'magicalstocker') return fail('SCHEMA', 'Author lookup returned another handle.');
        targetId = author.id;
        if (targetId === expectedActor) return fail('SKIPPED', 'The target is the signed-in account.');
        const before = await freshRelation(targetId);
        if (before.following === true) return { ok: true, data: { actorId: expectedActor, targetId, following: true, verified: true } };
        if(before.following!==false)return fail('SCHEMA','The author relationship could not be confirmed.');
        writeValidUntil=Date.now()+15000;
      }
      guard();
      const action=operation.kind==='unfollow'?'destroy':'create';
      await request(action,`/1.1/friendships/${action}.json`,{},targetId);
      await verify();
      const after = await freshRelation(targetId);
      const desiredFollowing = operation.kind === 'followAuthor';
      if (after.following !== desiredFollowing) return fail('UNCERTAIN', 'A fresh read did not confirm the requested relationship state. Stop and inspect before any retry.');
      return { ok: true, data: { actorId: expectedActor, targetId, following: desiredFollowing, verified: true } };
    } catch (error) {
      const message = error instanceof Error && safeErrors.has(error) ? error.message : 'NETWORK: The page adapter failed; native request details were not exported.';
      // An acknowledged write with a failed follow-up read must never be reported as a clean failure.
      if (mutationAccepted || (mutationDispatched && !/^(RATE_LIMIT|AUTH|UNCERTAIN):/.test(message))) return { ok: false, error: `UNCERTAIN: A write may have completed; verification was interrupted. ${message}` };
      return {ok:false,error:message};
    } finally { if (lease && mutationDispatched) lease.pendingWrite = false; }
  })();
}

function parsed<T>(parser: ParserKind, payload: unknown, context: Partial<Extract<RuntimeInput, { type: 'PARSE' }>> = {}): T {
  const result = xPageRuntime({ type: 'PARSE', parser, payload, ...context }) as RuntimeResult;
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}
export const parsePerson = (data: unknown): Person => parsed('person', data);
export const parseFollowingPage = (data: unknown): FollowingPage => parsed('following', data);
export const parseRelations = (data: unknown, ids: string[]): Relation[] => parsed('relations', data, { ids });
export const parseRelationship = (data: unknown, actorId: string, targetId: string): Relation => parsed('relationship', data, { actorId, targetId });

/** IDs take precedence; an unresolved handle is matched against the freshly resolved target name. */
export function isWhitelisted(data: unknown, actorId: string, target: Person): boolean {
  if (data === undefined || data === null) return false;
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('SCHEMA: Invalid local whitelist storage.');
  const whitelists = (data as Record<string, unknown>).whitelists;
  if (!whitelists || typeof whitelists !== 'object' || Array.isArray(whitelists)) throw new Error('SCHEMA: Invalid local whitelist map.');
  const entries = (whitelists as Record<string, unknown>)[actorId];
  if (entries === undefined) return false;
  if (!Array.isArray(entries)) throw new Error('SCHEMA: Invalid account whitelist.');
  let matched = false;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('SCHEMA: Invalid whitelist entry.');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.handle !== 'string' || !/^@?[A-Za-z0-9_]{1,15}$/.test(entry.handle)) throw new Error('SCHEMA: Invalid whitelist handle.');
    if (entry.id !== undefined) {
      if (typeof entry.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(entry.id)) throw new Error('SCHEMA: Invalid whitelist ID.');
      if (entry.id === target.id) matched = true;
    } else if (entry.handle.replace(/^@/, '').toLowerCase() === target.handle.toLowerCase()) matched = true;
  }
  return matched;
}
