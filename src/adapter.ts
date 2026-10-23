import type { Account, Adapter, FollowingPage, Person, Relation } from './types';
import type { PageOperation } from './x-api';

type Reply = { id?: string; type?: string; ok?: boolean; data?: unknown; error?: string; bootId?: string; sessionId?: string; sessionEnded?: boolean };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; write: boolean };
export interface XTabChoice { id: number; title: string; url: string; }
export interface ConnectionAccess {
  prepareConnection(forcePermission?: boolean): Promise<XTabChoice[]>;
  selectTab(id: number): void;
  openX(): Promise<void>;
  cancel(): void;
}
const X_ORIGIN = 'https://x.com/*';
function xTab(tab: chrome.tabs.Tab): XTabChoice | null {
  try {
    if (!Number.isSafeInteger(tab.id) || tab.id! < 0 || !tab.url || new URL(tab.url).origin !== 'https://x.com') return null;
    return { id: tab.id!, title: tab.title || '', url: tab.url };
  } catch { return null; }
}

export class ChromeAdapter implements Adapter {
  private tabId: number | null;
  private port: chrome.runtime.Port | null = null;
  private bootId: string | null = null;
  private sessionId: string | null = null;
  private actorId: string | null = null;
  private cancelled = true;
  private pending = new Map<string, Pending>();
  private entryGeneration = 0;
  private choices = new Set<number>();
  private sessionLost: ((message: string) => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  private heartbeatId: string | null = null;

  constructor(url = typeof location === 'undefined' ? '' : location.href) {
    const raw = url ? new URL(url).searchParams.get('tab') : null;
    this.tabId = raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  }

  // Called directly by the button handler, before any storage or worker await.
  // Do not move permission requests into connect(): controller.bind() is asynchronous.
  prepareConnection(forcePermission = false): Promise<XTabChoice[]> {
    const generation = ++this.entryGeneration;
    this.choices.clear();
    const discover = forcePermission || this.tabId === null;
    const assertCurrent = () => {
      if (generation !== this.entryGeneration) throw new Error('CANCELLED: Connection selection was cancelled.');
    };
    let grant: Promise<boolean>;
    try {
      grant = discover ? chrome.permissions.request({ origins: [X_ORIGIN] }) : Promise.resolve(true);
    } catch { return Promise.reject(new Error('TAB_PERMISSION: Allow access to x.com from the Connect button.')); }
    return grant.catch(() => { assertCurrent(); throw new Error('TAB_PERMISSION: Access to x.com was not granted.'); }).then(async allowed => {
      assertCurrent();
      if (!allowed) throw new Error('TAB_PERMISSION: Access to x.com was not granted.');
      if (!discover) {
        let tab: chrome.tabs.Tab;
        try { tab = await chrome.tabs.get(this.tabId!); }
        catch { assertCurrent(); this.tabId = null; throw new Error('TAB_REQUIRED: The selected X tab has closed. Click Connect to select another.'); }
        assertCurrent();
        const candidate = xTab(tab);
        if (!candidate) {
          this.tabId = null;
          throw new Error(tab.url ? 'TAB_REQUIRED: The selected tab is no longer on x.com.' : 'TAB_PERMISSION: Access to the selected X tab has expired. Click Connect again.');
        }
        this.choices.add(candidate.id);
        return [candidate];
      }
      let tabs: chrome.tabs.Tab[];
      try { tabs = await chrome.tabs.query({ url: X_ORIGIN }); }
      catch { assertCurrent(); throw new Error('TAB_PERMISSION: X tabs could not be read.'); }
      assertCurrent();
      // Without permission, Chrome may ignore the query filter. Always check each URL.
      const candidates = tabs.map(xTab).filter((tab): tab is XTabChoice => tab !== null);
      candidates.forEach(tab => this.choices.add(tab.id));
      if (!candidates.length) { this.tabId = null; throw new Error('TAB_REQUIRED: Open an X tab, then click Connect again.'); }
      return candidates;
    });
  }
  selectTab(id: number): void {
    if (!Number.isSafeInteger(id) || id < 0 || !this.choices.has(id)) throw new Error('TAB_REQUIRED: Select an available X tab.');
    this.tabId = id;
    this.choices.clear();
  }
  async openX(): Promise<void> { await chrome.tabs.create({ url: 'https://x.com/home' }); }
  setSessionLostListener(listener: (message: string) => void): void { this.sessionLost = listener; }

  async connect(): Promise<Account> {
    this.cancel();
    if (this.tabId === null) throw new Error('TAB_REQUIRED: Select an X tab with the Connect button.');
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) throw new Error('TAB_REQUIRED: Open the installed extension to connect to X.');
    this.cancelled = false;
    const port = chrome.runtime.connect({ name: 'reciprocal-x-control-v1' });
    this.port = port;
    this.bootId = null;
    this.sessionId = null;
    this.actorId = null;
    port.onMessage.addListener((reply: Reply) => {
      if (this.port !== port || !reply) return;
      if (reply.type === 'SESSION_ENDED') {
        if ((this.bootId && reply.bootId !== this.bootId) || (this.sessionId && reply.sessionId !== this.sessionId)) return;
        this.closeConnection(reply.error || 'WORKER_RESTART: The control connection stopped. Reconnect explicitly.', true);
        return;
      }
      if (typeof reply.id !== 'string') return;
      if (reply.id === this.heartbeatId) {
        if (reply.ok === true && reply.type === 'PONG' && reply.bootId === this.bootId && reply.sessionId === this.sessionId) this.scheduleHeartbeat(port);
        else this.closeConnection(reply.error || 'WORKER_RESTART: The control heartbeat no longer matches this session. Reconnect explicitly.', true);
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) {
        if (reply.bootId && reply.sessionId) { this.bootId = reply.bootId; this.sessionId = reply.sessionId; }
        pending.resolve(reply.data);
      } else {
        const message = reply.error || 'NETWORK: No valid response from the extension worker.';
        // Keep the operation's original failure. A later idle port closure must not replace it.
        if (reply.sessionEnded === true) this.closeConnection(message);
        pending.reject(new Error(message));
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      // Reading lastError prevents Chrome's unchecked-port-error warning without exposing its text.
      void chrome.runtime.lastError;
      const message = 'WORKER_RESTART: The worker or control connection stopped. Reconnect; execution will not resume automatically.';
      this.closeConnection(message, true);
    });
    try {
      const account = await this.send<Account>('CONNECT', { tabId: this.tabId });
      if (this.port !== port || this.cancelled) throw new Error('CANCELLED: This connection ended before it became ready.');
      this.actorId = account.id;
      this.scheduleHeartbeat(port);
      return account;
    } catch (error) { this.cancel(); throw error; }
  }

  async identity(expectedId?: string): Promise<Account> {
    return this.command({ kind: 'identity', actorId: expectedId ?? this.requireActor() });
  }
  following(actorId: string, cursor: string): Promise<FollowingPage> { return this.command({ kind: 'following', actorId, cursor }); }
  relations(actorId: string, ids: string[]): Promise<Relation[]> { return this.command({ kind: 'relations', actorId, ids }); }
  resolve(actorId: string, handle: string): Promise<Person> { return this.command({ kind: 'resolve', actorId, handle }); }
  async unfollow(actorId: string, targetId: string, automatic = false): Promise<void> { await this.command({ kind: 'unfollow', actorId, targetId, automatic }); }
  async followAuthor(actorId: string): Promise<void> { await this.command({ kind: 'followAuthor', actorId }); }

  cancel(): void {
    this.closeConnection('CANCELLED: Paused. Reconnect before starting another operation.');
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatDeadline !== null) clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = null;
    this.heartbeatDeadline = null;
    this.heartbeatId = null;
  }

  private scheduleHeartbeat(port: chrome.runtime.Port): void {
    this.clearHeartbeat();
    if (this.port !== port || this.cancelled || !this.bootId || !this.sessionId) return;
    // An open MV3 Port alone does not keep its worker alive. This message only
    // checks the control lease; it never calls X or resumes an operation.
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.port !== port || this.cancelled || !this.bootId || !this.sessionId) return;
      const id = crypto.randomUUID();
      this.heartbeatId = id;
      this.heartbeatDeadline = setTimeout(() => {
        if (this.port === port && this.heartbeatId === id) this.closeConnection('WORKER_RESTART: The control heartbeat stopped. Reconnect; execution will not resume automatically.', true);
      }, 10_000);
      try { port.postMessage({ type: 'HEARTBEAT', id, bootId: this.bootId, sessionId: this.sessionId }); }
      catch { this.closeConnection('WORKER_RESTART: The control heartbeat could not reach the worker. Reconnect explicitly.', true); }
    }, 20_000);
  }

  private closeConnection(message: string, notify = false): void {
    ++this.entryGeneration;
    this.choices.clear();
    this.cancelled = true;
    const previous = this.port;
    this.port = null;
    this.clearHeartbeat();
    if (previous) {
      try { previous.postMessage({ type: 'CANCEL', bootId: this.bootId, sessionId: this.sessionId }); } catch { /* disconnected */ }
      try { previous.disconnect(); } catch { /* disconnected */ }
    }
    this.rejectPending(message);
    this.bootId = null;
    this.sessionId = null;
    this.actorId = null;
    if (notify) this.sessionLost?.(message);
  }

  private requireActor(): string {
    if (!this.actorId) throw new Error('CANCELLED: Connect to X before continuing.');
    return this.actorId;
  }
  private command<T>(operation: Exclude<PageOperation, { kind: 'connect' | 'cancel' | 'probe' }>): Promise<T> {
    if (this.cancelled || !this.bootId || !this.sessionId) return Promise.reject(new Error('CANCELLED: Reconnect before continuing.'));
    if (operation.actorId !== this.actorId) return Promise.reject(new Error('ACCOUNT_CHANGED: This command belongs to another account.'));
    return this.send('COMMAND', { bootId: this.bootId, sessionId: this.sessionId, operation }, operation.kind === 'unfollow' || operation.kind === 'followAuthor');
  }
  private send<T>(type: string, payload: Record<string, unknown>, write = false): Promise<T> {
    const port = this.port;
    if (!port || this.cancelled) return Promise.reject(new Error('CANCELLED: No active control session.'));
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiting = this.pending.get(requestId);
        if (!waiting) return;
        this.pending.delete(requestId);
        reject(new Error(write ? 'UNCERTAIN: A write may have completed but its verified result was not received.' : 'NETWORK: The extension command timed out.'));
        this.cancel();
      }, write ? 150_000 : 30_000);
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, timer, write });
      try { port.postMessage({ type, id: requestId, ...payload }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        const message = 'WORKER_RESTART: The extension worker is unavailable. Reconnect.';
        this.closeConnection(message);
        reject(new Error(write ? `UNCERTAIN: A requested write may have completed. ${message}` : message));
      }
    });
  }
  private rejectPending(message: string): void {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error(value.write ? `UNCERTAIN: A requested write may have completed. ${message}` : message));
    }
    this.pending.clear();
  }
}

export const createAdapter = (): Adapter => new ChromeAdapter();
