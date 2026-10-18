export type Language = 'zh-CN' | 'en' | 'fr' | 'es' | 'ru' | 'de' | 'pt' | 'ja' | 'ko' | 'ar';
export type Mode = 'manual' | 'auto';
export interface Account { id: string; handle: string; name: string; }
export interface Person extends Account { avatar?: string; bio?: string; }
export interface Relation { id: string; following: boolean | null; followedBy: boolean | null; }
export interface FollowingPage { users: Person[]; nextCursor: string; relations?: Relation[]; }
export type Outcome = 'pending' | 'unfollowed' | 'skipped' | 'uncertain';
export interface Row extends Person { relation: Relation; outcome: Outcome; }
export interface WhiteEntry { id?: string; handle: string; }
export interface Settings { language: Language; mode: Mode; intervalSeconds: number; batchLimit: number; }
export interface AuditEntry { at: string; actorId: string; targetId: string; handle: string; action: 'unfollow' | 'follow-author'; result: string; }
export interface AppState {
  demo: boolean; connected: boolean; account: Account | null; rows: Row[];
  phase: 'idle' | 'connecting' | 'scanning' | 'ready' | 'running' | 'paused' | 'error';
  complete: boolean; scannedAt: number | null; pages: number; checked: number;
  whitelist: WhiteEntry[]; settings: Settings; error: string | null; message: string;
  currentId: string | null; logs: AuditEntry[]; authorFollowed: boolean;
  activeOperation?: 'scan' | 'auto' | 'manual' | 'author' | null;
  pausePending?: boolean; canResumeScan?: boolean;
}
export interface Adapter {
  setSessionLostListener?(listener: (message: string) => void): void;
  connect(): Promise<Account>;
  identity(expectedId?: string): Promise<Account>;
  following(actorId: string, cursor: string): Promise<FollowingPage>;
  relations(actorId: string, ids: string[]): Promise<Relation[]>;
  resolve(actorId: string, handle: string): Promise<Person>;
  unfollow(actorId: string, targetId: string, automatic?: boolean): Promise<void>;
  followAuthor(actorId: string): Promise<void>;
  cancel(): void;
}
export interface Actions {
  connect(): Promise<void>; scan(): Promise<void>; resumeScan(): Promise<void>; pause(): void;
  unfollow(id: string): Promise<void>; startAuto(): Promise<void>; followAuthor(): Promise<void>;
  setLanguage(language: Language): void; setMode(mode: Mode): void;
  setPacing(seconds: number, limit: number): void;
  addWhitelist(text: string): Promise<void>; removeWhitelist(handle: string): void;
  toggleWhitelist(id: string): void; exportCsv(): void; clearLocalData(): Promise<void>;
}
