import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySaved, LocalRepository, mergeSaved, STORAGE_KEY, unresolvedFromLogs } from '../src/storage';
import type { AuditEntry } from '../src/types';

const entry = (id: string, handle = `user_${id}`) => ({ id, handle });
const event = (second: number, result = 'intent'): AuditEntry => ({
  at: `2026-10-18T01:00:${String(second).padStart(2, '0')}.000Z`,
  actorId: '99', targetId: '1', handle: 'alice', action: 'unfollow', result,
});

test('a stale settings writer preserves remote whitelist, settings, and audit history', () => {
  const baseline = emptySaved();
  const incoming = structuredClone(baseline);
  incoming.settings.language = 'en';
  const latest = emptySaved();
  latest.settings.intervalSeconds = 42;
  latest.whitelists['99'] = [entry('1')];
  latest.logs = [event(1)];
  latest.unresolved['99'] = ['1'];
  const result = mergeSaved(baseline, incoming, latest);
  assert.equal(result.settings.language, 'en');
  assert.equal(result.settings.intervalSeconds, 42);
  assert.deepEqual(result.whitelists, latest.whitelists);
  assert.deepEqual(result.logs, latest.logs);
  assert.deepEqual(result.unresolved, latest.unresolved);
});

test('unresolved targets merge independent additions and explicit removals by actor and ID', () => {
  const baseline = emptySaved();
  baseline.unresolved['99'] = ['1', '2'];
  const incoming = structuredClone(baseline);
  incoming.unresolved['99'] = ['2', '4'];
  const latest = structuredClone(baseline);
  latest.unresolved['99'] = ['1', '3'];
  latest.unresolved['88'] = ['8'];
  const result = mergeSaved(baseline, incoming, latest);
  assert.deepEqual(result.unresolved, { '99': ['3', '4'], '88': ['8'] });
});

test('unresolved targets survive truncation of the original intent from the 500-event log', () => {
  const baseline = emptySaved();
  baseline.unresolved['99'] = ['1'];
  baseline.logs = [event(0)];
  const incoming = structuredClone(baseline);
  incoming.logs = Array.from({ length: 510 }, (_, index) => ({ ...event(1, 'verified'), at: new Date(Date.UTC(2026, 9, 18, 2, 0, index)).toISOString(), targetId: String(index + 2) }));
  const result = mergeSaved(baseline, incoming, baseline);
  assert.equal(result.logs.length, 500);
  assert.equal(result.logs.some(log => log.targetId === '1'), false);
  assert.deepEqual(result.unresolved['99'], ['1']);
});

test('legacy unresolved migration uses each actor-target pair last unfollow outcome', () => {
  const logs: AuditEntry[] = [
    event(1), event(2, 'verified'),
    { ...event(3), targetId: '2' },
    { ...event(4, 'uncertain'), targetId: '2' },
    { ...event(5), actorId: '88' },
    { ...event(6), action: 'follow-author', targetId: '3' },
  ];
  assert.deepEqual(unresolvedFromLogs(logs), { '99': ['2'], '88': ['1'] });
});

test('independent whitelist adds and removals merge without resurrecting remotely removed IDs', () => {
  const baseline = emptySaved();
  baseline.whitelists['99'] = [entry('1'), entry('2')];
  const incoming = structuredClone(baseline);
  incoming.whitelists['99'] = [entry('2'), entry('4')];
  const latest = structuredClone(baseline);
  latest.whitelists['99'] = [entry('1'), entry('3')];
  latest.whitelists['88'] = [entry('8')];
  const result = mergeSaved(baseline, incoming, latest);
  assert.deepEqual(result.whitelists['99'], [entry('3'), entry('4')]);
  assert.deepEqual(result.whitelists['88'], [entry('8')]);
});

test('whitelist deletion follows stable IDs when names change or are reassigned', () => {
  const baseline = emptySaved();
  baseline.whitelists['99'] = [entry('1', 'oldname')];
  const incoming = structuredClone(baseline);
  incoming.whitelists['99'] = [];
  const latest = structuredClone(baseline);
  latest.whitelists['99'] = [entry('1', 'newname'), entry('2', 'oldname')];
  assert.deepEqual(mergeSaved(baseline, incoming, latest).whitelists['99'], [entry('2', 'oldname')]);
});

test('unresolved whitelist handles match case-insensitively without an at sign', () => {
  const baseline = emptySaved();
  baseline.whitelists['99'] = [{ handle: '@Alice' }];
  const incoming = structuredClone(baseline);
  incoming.whitelists['99'] = [];
  const latest = structuredClone(baseline);
  latest.whitelists['99'] = [{ handle: 'alice' }, entry('3')];
  assert.deepEqual(mergeSaved(baseline, incoming, latest).whitelists['99'], [entry('3')]);
});

test('audit merge appends new events, de-duplicates them, and ignores local history deletion', () => {
  const baseline = emptySaved();
  baseline.logs = [event(1)];
  const incoming = structuredClone(baseline);
  incoming.logs = [event(3, 'verified'), event(3, 'verified')];
  const latest = structuredClone(baseline);
  latest.logs.push(event(2, 'uncertain'));
  assert.deepEqual(mergeSaved(baseline, incoming, latest).logs, [event(1), event(2, 'uncertain'), event(3, 'verified')]);
});

test('an unchanged stale history does not resurrect logs absent from latest', () => {
  const baseline = emptySaved();
  baseline.logs = [event(1)];
  const incoming = structuredClone(baseline);
  incoming.settings.language = 'en';
  const latest = emptySaved();
  latest.logs = [event(2, 'verified')];
  assert.deepEqual(mergeSaved(baseline, incoming, latest).logs, latest.logs);
});

test('merge does not mutate any input or share mutable entry objects', () => {
  const baseline = emptySaved(), incoming = emptySaved(), latest = emptySaved();
  incoming.whitelists['99'] = [entry('1')];
  incoming.logs = [event(1)];
  const snapshots = [baseline, incoming, latest].map(value => structuredClone(value));
  const result = mergeSaved(baseline, incoming, latest);
  result.whitelists['99'][0].handle = 'modified';
  result.logs[0].result = 'modified';
  assert.deepEqual([baseline, incoming, latest], snapshots);
});

test('LocalRepository serializes cross-instance updates and keeps the callers own baseline', async () => {
  const descriptors = new Map(['navigator', 'chrome', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map<string, string>();
  const lockNames: string[] = [];
  let tail = Promise.resolve();
  const locks = { request<T>(name: string, work: () => Promise<T>): Promise<T> {
    lockNames.push(name);
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    const first = new LocalRepository(), second = new LocalRepository();
    const firstView = await first.read(), secondView = await second.read();
    firstView.whitelists['99'] = [entry('1')];
    firstView.logs = [event(1)];
    firstView.unresolved['99'] = ['1'];
    secondView.settings.language = 'en';
    await Promise.all([first.write(firstView), second.write(secondView)]);
    let stored = JSON.parse(values.get(STORAGE_KEY)!);
    assert.deepEqual(stored.whitelists['99'], [entry('1')]);
    assert.deepEqual(stored.logs, [event(1)]);
    assert.equal(stored.settings.language, 'en');
    assert.deepEqual(stored.unresolved['99'], ['1']);

    // The second writer never saw the first writer's whitelist. A later write must not delete it.
    secondView.settings.batchLimit = 7;
    await second.write(secondView);
    stored = JSON.parse(values.get(STORAGE_KEY)!);
    assert.deepEqual(stored.whitelists['99'], [entry('1')]);
    assert.deepEqual(stored.logs, [event(1)]);
    assert.equal(stored.settings.batchLimit, 7);
    assert.deepEqual(stored.unresolved['99'], ['1']);

    // read() establishes an observed baseline, so removal of that observed entry is intentional.
    const refreshed = await second.read();
    refreshed.whitelists['99'] = [];
    await second.write(refreshed);
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEY)!).whitelists['99'], []);

    await second.clear(emptySaved());
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEY)!), emptySaved());
    assert.ok(lockNames.length >= 8);
    assert.ok(lockNames.every(name => name === 'reciprocal-storage-v1'));

    // Missing field is migrated once; an explicit empty map must not revive resolved old history.
    const legacy = emptySaved() as Partial<ReturnType<typeof emptySaved>>;
    delete legacy.unresolved;
    legacy.logs = [event(1, 'uncertain')];
    values.set(STORAGE_KEY, JSON.stringify(legacy));
    assert.deepEqual((await new LocalRepository().read()).unresolved, { '99': ['1'] });
    values.set(STORAGE_KEY, JSON.stringify({ ...legacy, unresolved: {} }));
    assert.deepEqual((await new LocalRepository().read()).unresolved, {});

    // Browsers without Web Locks still have a functional explicit fallback.
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const fallback = new LocalRepository();
    const data = await fallback.read();
    data.settings.mode = 'auto';
    await fallback.write(data);
    assert.equal(JSON.parse(values.get(STORAGE_KEY)!).settings.mode, 'auto');
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
