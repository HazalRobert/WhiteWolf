import type { AuditEntry, Settings, WhiteEntry } from './types';
export const STORAGE_KEY = 'reciprocal_data';
export interface Saved { settings: Settings; whitelists: Record<string, WhiteEntry[]>; logs: AuditEntry[]; unresolved: Record<string, string[]>; }
export const defaultSettings: Settings = {language:'zh-CN',mode:'manual',intervalSeconds:15,batchLimit:20};
export interface Repository { read(): Promise<Saved>; write(data: Saved): Promise<void>; clear?(data: Saved): Promise<void>; }
export function emptySaved(): Saved { return {settings:{...defaultSettings},whitelists:{},logs:[],unresolved:{}}; }

const whitelistKey = (entry: WhiteEntry): string => entry.id ? `id:${entry.id}` : `handle:${entry.handle.replace(/^@/, '').toLowerCase()}`;
const auditKey = (entry: AuditEntry): string => JSON.stringify([entry.at, entry.actorId, entry.targetId, entry.handle, entry.action, entry.result]);
const sameEntry = (left: WhiteEntry, right: WhiteEntry): boolean => left.id === right.id && left.handle === right.handle;

/** One-time migration for older saves; the separate unresolved set survives audit-history truncation. */
export function unresolvedFromLogs(logs: AuditEntry[]): Record<string, string[]> {
  const last = new Map<string, AuditEntry>();
  for (const entry of logs) {
    if (entry?.action === 'unfollow' && typeof entry.actorId === 'string' && typeof entry.targetId === 'string') {
      last.set(`${entry.actorId}:${entry.targetId}`, entry);
    }
  }
  const result: Record<string, string[]> = {};
  for (const entry of last.values()) {
    if (entry.result === 'intent' || entry.result === 'uncertain') (result[entry.actorId] ??= []).push(entry.targetId);
  }
  return result;
}

/** Apply only changes the caller made to its own observed snapshot. Remote changes remain intact. */
export function mergeSaved(baseline: Saved, incoming: Saved, latest: Saved): Saved {
  const settings = { ...latest.settings };
  if (incoming.settings.language !== baseline.settings.language) settings.language = incoming.settings.language;
  if (incoming.settings.mode !== baseline.settings.mode) settings.mode = incoming.settings.mode;
  if (incoming.settings.intervalSeconds !== baseline.settings.intervalSeconds) settings.intervalSeconds = incoming.settings.intervalSeconds;
  if (incoming.settings.batchLimit !== baseline.settings.batchLimit) settings.batchLimit = incoming.settings.batchLimit;

  const whitelists = structuredClone(latest.whitelists);
  for (const actorId of new Set([...Object.keys(baseline.whitelists), ...Object.keys(incoming.whitelists)])) {
    const before = new Map((baseline.whitelists[actorId] ?? []).map(entry => [whitelistKey(entry), entry]));
    const after = new Map((incoming.whitelists[actorId] ?? []).map(entry => [whitelistKey(entry), entry]));
    const current = new Map((whitelists[actorId] ?? []).map(entry => [whitelistKey(entry), entry]));
    let changed = false;
    for (const key of before.keys()) {
      if (!after.has(key)) { current.delete(key); changed = true; }
    }
    for (const [key, entry] of after) {
      const previous = before.get(key);
      if (!previous || !sameEntry(previous, entry)) { current.set(key, { ...entry }); changed = true; }
    }
    if (changed) whitelists[actorId] = [...current.values()];
  }

  // History is append-only outside clear(). A stale or truncated local view cannot erase remote events.
  const knownLogs = new Set(baseline.logs.map(auditKey));
  const logs = new Map(latest.logs.map(entry => [auditKey(entry), { ...entry }]));
  for (const entry of incoming.logs) {
    const key = auditKey(entry);
    if (!knownLogs.has(key) && !logs.has(key)) logs.set(key, { ...entry });
  }
  const unresolved = structuredClone(latest.unresolved);
  for (const actorId of new Set([...Object.keys(baseline.unresolved), ...Object.keys(incoming.unresolved)])) {
    const before = new Set(baseline.unresolved[actorId] ?? []);
    const after = new Set(incoming.unresolved[actorId] ?? []);
    const current = new Set(unresolved[actorId] ?? []);
    let changed = false;
    for (const targetId of before) {
      if (!after.has(targetId)) { current.delete(targetId); changed = true; }
    }
    for (const targetId of after) {
      if (!before.has(targetId)) { current.add(targetId); changed = true; }
    }
    if (changed) unresolved[actorId] = [...current];
  }
  return { settings, whitelists, logs: [...logs.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-500), unresolved };
}

export class LocalRepository implements Repository {
  private baseline: Saved = emptySaved();

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request('reciprocal-storage-v1', work);
    return work();
  }

  private async readCurrent(): Promise<Saved> {
    try {
      const raw = typeof chrome !== 'undefined' && chrome.storage ? (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return emptySaved();
      const languages = ['zh-CN','en','fr','es','ru','de','pt','ja','ko','ar'];
      const logs: AuditEntry[] = Array.isArray(raw.logs) ? raw.logs : [];
      const unresolved = raw.unresolved && typeof raw.unresolved === 'object' && !Array.isArray(raw.unresolved) ? raw.unresolved : unresolvedFromLogs(logs);
      return { settings: {language:languages.includes(raw.settings?.language) ? raw.settings.language : 'zh-CN', mode:raw.settings?.mode === 'auto' ? 'auto':'manual', intervalSeconds:Math.min(300,Math.max(5,Number(raw.settings?.intervalSeconds)||15)),batchLimit:Math.min(200,Math.max(1,Number(raw.settings?.batchLimit)||20))}, whitelists:raw.whitelists && typeof raw.whitelists==='object' ? raw.whitelists:{}, logs:logs.slice(-500), unresolved };
    } catch { return emptySaved(); }
  }

  private async writeCurrent(data: Saved): Promise<void> {
    if(typeof chrome!=='undefined' && chrome.storage) await chrome.storage.local.set({[STORAGE_KEY]:data});
    else localStorage.setItem(STORAGE_KEY,JSON.stringify(data));
  }

  async read(): Promise<Saved> {
    return this.locked(async () => {
      const data = await this.readCurrent();
      this.baseline = structuredClone(data);
      return data;
    });
  }

  async write(data: Saved): Promise<void> {
    const incoming = structuredClone(data);
    await this.locked(async () => {
      const latest = await this.readCurrent();
      await this.writeCurrent(mergeSaved(this.baseline, incoming, latest));
      // The caller has not observed remote additions in the merged value. Never treat them as deletions later.
      this.baseline = incoming;
    });
  }

  async clear(data: Saved): Promise<void> {
    const incoming = structuredClone(data);
    await this.locked(async () => {
      await this.writeCurrent(incoming);
      this.baseline = incoming;
    });
  }
}
