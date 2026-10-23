import type { Account, Adapter, Person, Relation } from './types';
const people = [
  ['101','alex_morgan','Alex Morgan','Design systems, good coffee, and slow weekends.'],
  ['102','studio_nora','Nora Studio','Independent design & illustration.'],
  ['103','chen_codes','陈一','Build things. Share what you learn.'],
  ['104','theo_reads','Théo Laurent','Books, architecture, quiet places.'],
  ['105','maria_creates','María García','Creative work in progress.'],
  ['106','north_journal','North Journal','Notes from the everyday.'],
  ['107','pixel_jun','Jun Park','Making small things for the web.'],
  ['108','sofia_notes','Sofia Costa','Science, culture, and conversations.'],
  ['109','rami_design','Rami','Design with intention.'],
  ['110','lena_builds','Lena Weber','Learning in public.'],
  ['111','hana_daily','Hana','日々の小さな発見。'],
  ['112','max_field','Max Field','Technology and ideas.'],
];
export class DemoAdapter implements Adapter {
  private actor:Account={id:'9000001',handle:'demo_account',name:'Demo account',followingCount:people.length};
  private cancelled=false;
  private removed=new Set<string>();
  async connect(){this.cancelled=false;return this.actor;}
  private active(){if(this.cancelled)throw new Error('CANCELLED: Demo paused');}
  async identity(expected?:string){this.active();if(expected&&expected!==this.actor.id)throw new Error('ACCOUNT_CHANGED: Demo');return this.actor;}
  async following(actorId:string,cursor:string){await this.identity(actorId);return {users:cursor==='-1'?people.filter(p=>!this.removed.has(p[0])).map(([id,handle,name,bio])=>({id,handle,name,bio})):[],nextCursor:'0'};}
  async relations(actorId:string,ids:string[]):Promise<Relation[]>{await this.identity(actorId);return ids.map(id=>({id,following:!this.removed.has(id),followedBy:Number(id)%4===0}));}
  async resolve(actorId:string,handle:string):Promise<Person>{await this.identity(actorId);const p=people.find(p=>p[1].toLowerCase()===handle.toLowerCase());if(p)return {id:p[0],handle:p[1],name:p[2]};if(handle.toLowerCase()==='magicalstocker')return {id:'99999',handle:'MagicalStocker',name:'MagicalStocker'};throw new Error(`NOT_FOUND: @${handle} is unavailable or does not exist on X.`);}
  async unfollow(actorId:string,targetId:string){await this.identity(actorId);this.removed.add(targetId);}
  async followAuthor(actorId:string){await this.identity(actorId);}
  cancel(){this.cancelled=true;}
}
