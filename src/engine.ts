import type { Account, Actions, Adapter, AppState, AuditEntry, Language, Mode, Row, WhiteEntry } from './types';
import { emptySaved, type Repository, type Saved } from './storage';
import { isValidCursor } from './cursor';

export const isCandidate = (row: Row) => row.relation.following === true && row.relation.followedBy === false && row.outcome === 'pending';
export const isWhitelisted = (row: Pick<Row,'id'|'handle'>, list: WhiteEntry[]) => list.some(e => e.id ? e.id===row.id : e.handle.toLowerCase()===row.handle.toLowerCase());
export const csvCell=(value:unknown)=>{
  let text=String(value??'');
  if(/^[\s\u0000-\u001f]*[=+@\-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
};
export function parseHandles(text: string): string[] {
  const tokens = text.split(/[\s,，;；]+/).filter(Boolean).map(v=>v.replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i,'').replace(/^@/,'').replace(/\/$/,''));
  if(!tokens.length || tokens.some(v=>!/^\w{1,15}$/.test(v))) throw new Error('WHITELIST: Invalid username');
  return [...new Set(tokens.map(v=>v.toLowerCase()))];
}
interface ScanCheckpoint {
  actorId: string | null;
  cursor: string;
  seenCursors: Set<string>;
  ids: Set<string>;
  rows: Row[];
  pages: number;
  followingDone: boolean;
  relationOffset: number;
  pageRelations: Map<string,Row['relation']>;
  detachedIds: Set<string>;
  paused: boolean;
}

export class Controller implements Actions {
  private state: AppState;
  private saved: Saved = emptySaved();
  private listeners = new Set<()=>void>();
  private busy = false;
  private stopped = false;
  private saveChain: Promise<void> = Promise.resolve();
  private wake: (()=>void) | null = null;
  private sessionLoss: string | null = null;
  private scanCheckpoint: ScanCheckpoint | null = null;
  constructor(private adapter:Adapter,private repository:Repository, demo=false,private readDelay=900) {
    this.state={demo,connected:false,account:null,rows:[],phase:'idle',complete:false,scannedAt:null,pages:0,checked:0,whitelist:[],settings:{...this.saved.settings},error:null,message:demo?'statusDemo':'statusIdle',currentId:null,logs:[],authorFollowed:false,activeOperation:null,pausePending:false,canResumeScan:false};
    adapter.setSessionLostListener?.(message=>{
      this.sessionLoss=message;this.stopped=true;this.scanCheckpoint=null;this.wake?.();
      // A transport closure after an already reported terminal error is secondary.
      // Preserve the actionable operation failure while still stopping all work.
      const error=!this.state.connected&&this.state.error?this.state.error:message;
      this.patch({connected:false,error,phase:this.busy?this.state.phase:'error',message:'statusPaused',canResumeScan:false});
    });
  }
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)};};
  private patch(patch:Partial<AppState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
  async initialize(){this.saved=await this.repository.read();this.patch({settings:this.saved.settings,logs:this.saved.logs});}
  private persist(){
    this.saved.settings={...this.state.settings};
    this.saved.logs=this.state.logs.slice(-500);
    if(this.state.account)this.saved.whitelists[this.state.account.id]=[...this.state.whitelist];
    const snapshot=structuredClone(this.saved);
    this.saveChain=this.saveChain.catch(()=>{}).then(()=>this.repository.write(snapshot));
    return this.saveChain;
  }
  private assertActive(){if(this.stopped)throw new Error('CANCELLED: Paused');}
  private async wait(ms:number){
    this.assertActive();
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);if(this.wake===finish)this.wake=null;resolve();};
      const timer=setTimeout(finish,ms);this.wake=finish;
    });
    this.assertActive();
  }
  private actor():Account{if(!this.state.account)throw new Error('NOT_CONNECTED: Connect X first');return this.state.account;}
  private unresolvedIds(actorId:string):Set<string>{
    return new Set(this.saved.unresolved[actorId]||[]);
  }
  private async bind(){
    const previous=this.state.account;
    await this.saveChain;this.assertActive();
    this.saved=await this.repository.read();this.assertActive();
    const account=await this.adapter.connect();this.assertActive();
    const changed=previous && previous.id!==account.id;
    this.patch({connected:true,account,logs:this.saved.logs,whitelist:this.saved.whitelists[account.id]||[],...(changed?{rows:[],complete:false,checked:0,pages:0,scannedAt:null,authorFollowed:false}:{})});
    if(changed){this.scanCheckpoint=null;this.patch({canResumeScan:false});throw new Error('ACCOUNT_CHANGED: Re-scan this account');}
    return account;
  }
  private async run(work:()=>Promise<void>,operation:AppState['activeOperation']=null){
    if(this.busy)return;
    this.busy=true;this.stopped=false;this.sessionLoss=null;this.patch({error:null,activeOperation:operation,pausePending:false,...(operation==='scan'?{canResumeScan:false}:{})});
    try{await work();if(this.sessionLoss)throw new Error(this.sessionLoss);this.assertActive();}catch(error){
      let message=error instanceof Error?error.message:String(error);
      if(message.startsWith('CANCELLED:')&&this.sessionLoss)message=this.sessionLoss;
      // Match the worker's session-invalidating errors without discarding scan results or unresolved writes.
      const sessionInvalidated=/^(RATE_LIMIT|AUTH|ACCOUNT_CHANGED|SCHEMA|NETWORK|UNCERTAIN|HTTP|API_UNAVAILABLE|WORKER_RESTART|NOT_CONNECTED|TAB_REQUIRED|TAB_PERMISSION):/.test(message);
      if(sessionInvalidated)this.adapter.cancel();
      const cancelled=message.startsWith('CANCELLED:');
      if(!(cancelled&&!this.sessionLoss&&operation==='scan'&&this.scanCheckpoint?.paused))this.scanCheckpoint=null;
      this.patch({phase:cancelled?'paused':'error',message:'statusPaused',error:cancelled&&!this.sessionLoss?null:message,connected:!sessionInvalidated&&this.state.connected});
    }finally{this.busy=false;this.patch({currentId:null,activeOperation:null,pausePending:false,canResumeScan:!!this.scanCheckpoint?.paused});}
  }
  connect=async()=>this.run(async()=>{this.patch({phase:'connecting'});await this.bind();this.patch({phase:'idle',message:'statusConnected'});});
  scan=async()=>this.run(async()=>{
    this.scanCheckpoint={actorId:null,cursor:'-1',seenCursors:new Set(),ids:new Set(),rows:[],pages:0,followingDone:false,relationOffset:0,pageRelations:new Map(),detachedIds:new Set(),paused:this.stopped};
    this.patch({phase:'connecting',rows:[],complete:false,scannedAt:null,pages:0,checked:0});
    await this.continueScan();
  },'scan');
  resumeScan=async()=>{
    if(this.busy||!this.state.canResumeScan||!this.scanCheckpoint?.paused)return;
    await this.run(async()=>{
      this.scanCheckpoint!.paused=this.stopped;
      this.scanCheckpoint!.ids.forEach(id=>this.scanCheckpoint!.detachedIds.add(id));
      this.patch({phase:'connecting'});
      await this.continueScan();
    },'scan');
  };
  private async continueScan(){
    const checkpoint=this.scanCheckpoint!;
    const actor=await this.bind();this.assertActive();
    if(checkpoint.actorId&&checkpoint.actorId!==actor.id)throw new Error('ACCOUNT_CHANGED: Re-scan this account');
    checkpoint.actorId=actor.id;
    // Reconnection is an explicit resume action; verify its actor before using saved cursors.
    await this.adapter.identity(actor.id);this.assertActive();
    this.patch({phase:'scanning',message:'statusScanning'});
    const unresolved=this.unresolvedIds(actor.id),rows=checkpoint.rows;
    while(!checkpoint.followingDone){
      this.assertActive();
      const cursor=checkpoint.cursor,page=checkpoint.pages+1;
      if(checkpoint.seenCursors.has(cursor))throw new Error('SCHEMA: Repeated cursor');
      const result=await this.adapter.following(actor.id,cursor);this.assertActive();
      if(!result||typeof result!=='object'||!Array.isArray(result.users))throw new Error('SCHEMA: Following page has no users array.');
      if(!isValidCursor(result.nextCursor))throw new Error('SCHEMA: Following page has no valid opaque pagination cursor.');
      if(result.nextCursor!=='0'&&!result.users.length)throw new Error('INCOMPLETE: Empty page before end');
      const fresh:Row[]=[],newIds=new Set<string>();
      for(const person of result.users){
        if(!/^\d+$/.test(person.id)||!/^\w{1,15}$/.test(person.handle))throw new Error('SCHEMA: Invalid account');
        if(!checkpoint.ids.has(person.id)&&!newIds.has(person.id)){newIds.add(person.id);fresh.push({...person,relation:{id:person.id,following:null,followedBy:null},outcome:unresolved.has(person.id)?'uncertain':'pending'});}
      }
      const pageRelations=new Map<string,Row['relation']>();
      if(result.relations!==undefined){
        const pageIds=new Set(result.users.map(person=>person.id));
        if(!Array.isArray(result.relations))throw new Error('SCHEMA: Following relationships must be an array');
        for(const relation of result.relations){
          if(!relation||!pageIds.has(relation.id)||pageRelations.has(relation.id)||
            ![true,false,null].includes(relation.following)||![true,false,null].includes(relation.followedBy))throw new Error('SCHEMA: Invalid following relationship evidence');
          pageRelations.set(relation.id,{...relation});
        }
        if(pageRelations.size!==pageIds.size)throw new Error('SCHEMA: Missing following relationship evidence');
      }
      if(result.users.length && fresh.length===0)throw new Error('INCOMPLETE: Duplicate page');
      if(page===2000&&result.nextCursor!=='0')throw new Error('INCOMPLETE: Pagination limit');
      // Commit only an accepted page. A cancelled pending request can safely re-read its cursor.
      checkpoint.seenCursors.add(cursor);newIds.forEach(id=>checkpoint.ids.add(id));rows.push(...fresh);
      pageRelations.forEach((relation,id)=>checkpoint.pageRelations.set(id,relation));
      checkpoint.pages=page;checkpoint.cursor=result.nextCursor;checkpoint.followingDone=result.nextCursor==='0';
      this.patch({rows:[...rows],pages:page});
      if(!checkpoint.followingDone)await this.wait(this.readDelay);
    }
    while(checkpoint.relationOffset<rows.length){
      const start=checkpoint.relationOffset;
      this.assertActive();const chunk=rows.slice(start,start+100);
      const relations=await this.adapter.relations(actor.id,chunk.map(r=>r.id));this.assertActive();
      const map=new Map(relations.map(r=>[r.id,r]));
      const duplicates=relations.length!==map.size;
      const requested=new Set(chunk.map(row=>row.id));
      const validBatch=!duplicates&&relations.length===chunk.length&&relations.every(relation=>requested.has(relation.id)&&[true,false,null].includes(relation.following)&&[true,false,null].includes(relation.followedBy));
      chunk.forEach((row,i)=>{
        let relation=duplicates?null:map.get(row.id);
        // Rebinding discards the page lease's bulk cache. Retain only same-account,
        // committed Following evidence for those rows; a fresh single-ID read never falls back.
        if(chunk.length>1&&validBatch&&checkpoint.detachedIds.has(row.id)&&relation?.following===null&&relation.followedBy===null){
          relation=checkpoint.pageRelations.get(row.id)||relation;
        }
        rows[start+i]={...row,relation:relation||{id:row.id,following:null,followedBy:null}};
      });
      checkpoint.relationOffset=Math.min(start+100,rows.length);
      this.patch({rows:[...rows],checked:checkpoint.relationOffset});
      if(checkpoint.relationOffset<rows.length)await this.wait(this.readDelay);
    }
    this.assertActive();await this.adapter.identity(actor.id);this.assertActive();
    for(const row of rows){
      this.assertActive();
      if(row.outcome==='uncertain' && row.relation.following===false){row.outcome='unfollowed';await this.audit(row,'unfollow','verified');this.assertActive();}
    }
    this.assertActive();
    const unknown=rows.some(r=>r.relation.following===null||r.relation.followedBy===null);
    this.scanCheckpoint=null;
    this.patch({rows:[...rows],complete:!unknown,phase:'ready',scannedAt:Date.now(),message:'statusReady',error:unknown?'INCOMPLETE: Some relationships could not be verified':null});
  }
  pause=()=>{
    if(this.busy&&this.state.activeOperation==='scan'&&this.scanCheckpoint)this.scanCheckpoint.paused=true;
    this.stopped=true;this.adapter.cancel();this.wake?.();
    this.patch({phase:'paused',message:'statusPaused',connected:false,pausePending:this.busy,canResumeScan:!this.busy&&!!this.scanCheckpoint?.paused});
  };
  private updateRow(id:string,patch:Partial<Row>){this.patch({rows:this.state.rows.map(row=>row.id===id?{...row,...patch}:row)});}
  private async audit(target:Pick<Row,'id'|'handle'>,action:AuditEntry['action'],result:string){
    const entry:AuditEntry={at:new Date().toISOString(),actorId:this.actor().id,targetId:target.id,handle:target.handle,action,result};
    if(action==='unfollow'){
      const unresolved=this.unresolvedIds(entry.actorId);
      if(result==='intent'||result==='uncertain')unresolved.add(target.id);
      else if(['verified','skipped','stopped'].includes(result))unresolved.delete(target.id);
      this.saved.unresolved[entry.actorId]=[...unresolved];
    }
    this.patch({logs:[...this.state.logs,entry].slice(-500)});await this.persist();
  }
  private async perform(id:string,automatic:boolean){
    this.assertActive();const actor=this.actor();const row=this.state.rows.find(r=>r.id===id);
    if(!row||!isCandidate(row))return;
    if(this.unresolvedIds(actor.id).has(id)){this.updateRow(id,{outcome:'uncertain'});return;}
    if(automatic&&isWhitelisted(row,this.state.whitelist))return;
    this.patch({currentId:id});
    await this.adapter.identity(actor.id);this.assertActive();
    const relations=await this.adapter.relations(actor.id,[id]);this.assertActive();
    const fresh=relations.length===1&&relations[0].id===id?relations[0]:null;
    if(!fresh||fresh.following===null||fresh.followedBy===null)throw new Error('SCHEMA: Current relationship unknown');
    if(!fresh.following||fresh.followedBy){this.updateRow(id,{relation:fresh,outcome:'skipped'});await this.audit(row,'unfollow','skipped');this.patch({message:'statusSkipped',currentId:null});return;}
    if(automatic&&isWhitelisted(row,this.state.whitelist)){this.patch({currentId:null});return;}
    await this.audit(row,'unfollow','intent');this.assertActive();
    try{
      await this.adapter.unfollow(actor.id,id,automatic);
      // The adapter only resolves after same-account read-back confirms following=false.
      this.updateRow(id,{relation:{...fresh,following:false},outcome:'unfollowed'});
      await this.audit(row,'unfollow','verified');this.patch({message:'statusUnfollowed'});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(message.startsWith('SKIPPED:')){this.updateRow(id,{outcome:'skipped'});await this.audit(row,'unfollow','skipped');this.patch({message:'statusSkipped'});return;}
      // A write that may have reached X is never retried, including after re-opening.
      if(message.startsWith('UNCERTAIN:'))this.updateRow(id,{outcome:'uncertain'});
      await this.audit(row,'unfollow',message.startsWith('UNCERTAIN:')?'uncertain':'stopped');throw error;
    }finally{this.patch({currentId:null});}
  }
  unfollow=async(id:string)=>{if(this.scanCheckpoint)return;await this.run(async()=>{await this.bind();this.patch({phase:'running',message:'statusRunning'});await this.perform(id,false);if(!this.stopped)this.patch({phase:'ready'});},'manual');};
  startAuto=async()=>{if(this.scanCheckpoint)return;await this.run(async()=>{
    if(!this.state.complete)throw new Error('INCOMPLETE: Complete a scan before automatic mode');
    await this.bind();await this.persist();this.assertActive();
    const queue=this.state.rows.filter(r=>isCandidate(r)&&!isWhitelisted(r,this.state.whitelist)).slice(0,this.state.settings.batchLimit).map(r=>r.id);
    this.patch({phase:'running',message:'statusRunning'});
    for(let i=0;i<queue.length;i++){
      this.assertActive();await this.perform(queue[i],true);this.assertActive();
      if(i<queue.length-1)await this.wait(this.state.settings.intervalSeconds*1000);
    }
    this.patch({phase:'ready',message:'statusDone'});
  },'auto');};
  followAuthor=async()=>{if(this.scanCheckpoint)return;await this.run(async()=>{
    await this.bind();this.patch({phase:'running'});
    const author=await this.adapter.resolve(this.actor().id,'MagicalStocker');this.assertActive();
    await this.audit(author,'follow-author','intent');this.assertActive();
    try{await this.adapter.followAuthor(this.actor().id);await this.audit(author,'follow-author','verified');this.patch({authorFollowed:true,phase:'ready',message:'statusAuthorFollowed'});}catch(e){await this.audit(author,'follow-author','unconfirmed');throw e;}
  },'author');};
  setLanguage=(language:Language)=>{this.patch({settings:{...this.state.settings,language}});void this.persist().catch(e=>this.patch({error:String(e)}));};
  setMode=(mode:Mode)=>{if(this.busy)return;this.patch({settings:{...this.state.settings,mode}});void this.persist().catch(e=>this.patch({error:String(e)}));};
  setPacing=(seconds:number,limit:number)=>{if(this.busy)return;this.patch({settings:{...this.state.settings,intervalSeconds:Math.min(300,Math.max(5,Math.round(seconds)||15)),batchLimit:Math.min(200,Math.max(1,Math.round(limit)||20))}});void this.persist().catch(e=>this.patch({error:String(e)}));};
  addWhitelist=async(text:string)=>this.run(async()=>{
    const handles=parseHandles(text);const previousPhase=this.state.phase;
    const actor=await this.bind();const entries=[...this.state.whitelist];
    for(const handle of handles){this.assertActive();const user=await this.adapter.resolve(actor.id,handle);if(!entries.some(e=>e.id===user.id))entries.push({id:user.id,handle:user.handle});}
    this.patch({whitelist:entries,message:'statusWhitelistSaved',phase:previousPhase==='error'?'idle':previousPhase});await this.persist();
  });
  removeWhitelist=(handle:string)=>{if(this.busy)return;this.patch({whitelist:this.state.whitelist.filter(e=>e.handle.toLowerCase()!==handle.toLowerCase())});void this.persist().catch(e=>this.patch({error:String(e)}));};
  toggleWhitelist=(id:string)=>{if(this.busy)return;const row=this.state.rows.find(r=>r.id===id);if(!row)return;const exists=isWhitelisted(row,this.state.whitelist);this.patch({whitelist:exists?this.state.whitelist.filter(e=>e.id?e.id!==id:e.handle.toLowerCase()!==row.handle.toLowerCase()):[...this.state.whitelist,{id,handle:row.handle}]});void this.persist().catch(e=>this.patch({error:String(e)}));};
  exportCsv=()=>{
    const lines=[['id','handle','name','following','followed_by','outcome','whitelisted','scan_complete','scanned_at'],...this.state.rows.map(r=>[r.id,r.handle,r.name,r.relation.following,r.relation.followedBy,r.outcome,isWhitelisted(r,this.state.whitelist),this.state.complete,this.state.scannedAt?new Date(this.state.scannedAt).toISOString():''])];
    const url=URL.createObjectURL(new Blob(['\uFEFF'+lines.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='whitewolf-scan.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  clearLocalData=async()=>{if(this.busy)return;this.adapter.cancel();this.scanCheckpoint=null;await this.saveChain;this.saved=emptySaved();this.patch({settings:{...this.saved.settings},connected:false,account:null,rows:[],complete:false,scannedAt:null,pages:0,checked:0,whitelist:[],logs:[],authorFollowed:false,phase:'idle',error:null,message:'statusDataCleared',activeOperation:null,pausePending:false,canResumeScan:false});if(this.repository.clear)await this.repository.clear(this.saved);else await this.persist();};
}
