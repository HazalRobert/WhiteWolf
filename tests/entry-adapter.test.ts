import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { ChromeAdapter } from '../src/adapter';

// Each scenario has an isolated Chrome API and cannot access a real tab or account.
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL('../src/adapter.ts', import.meta.url))],
  bundle: true, platform: 'browser', format: 'cjs', target: 'chrome120', write: false }).outputFiles[0].text;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const controlUrl = 'chrome-extension://synthetic-extension/index.html';
const xTab = (id = 11): Partial<chrome.tabs.Tab> => ({ id, url: 'https://x.com/home', title: `Synthetic X ${id}`, windowId: 1, active: true, status: 'complete' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type MockOptions = {
  tabs?: Partial<chrome.tabs.Tab>[];
  permission?: boolean;
  request?: () => Promise<boolean>;
  get?: (id: number) => Promise<Partial<chrome.tabs.Tab>>;
  query?: () => Promise<Partial<chrome.tabs.Tab>[]>;
  replyToConnect?: boolean;
  replyToHeartbeat?: boolean;
};

function mockChrome(options: MockOptions = {}) {
  const permissionRequests: unknown[] = [], queries: unknown[] = [], getIds: number[] = [], created: unknown[] = [];
  const sent: Record<string, unknown>[] = [], ports: FakePort[] = [];
  const tabs = options.tabs ?? [xTab()];
  let connections = 0, nonce = 0;
  let now = 0, timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimer = (callback: () => void, ms: number) => { const id = ++timerId; timers.set(id, { at: now + ms, callback }); return id; };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await Promise.resolve();
    }
    now = target; await Promise.resolve();
  };
  class FakePort {
    readonly messages: Array<(message: unknown) => void> = [];
    readonly disconnects: Array<() => void> = [];
    readonly onMessage = { addListener: (listener: (message: unknown) => void) => { this.messages.push(listener); } };
    readonly onDisconnect = { addListener: (listener: () => void) => { this.disconnects.push(listener); } };
    postMessage(message: Record<string, unknown>) {
      sent.push(plain(message));
      if (message.type === 'CONNECT' && options.replyToConnect !== false) queueMicrotask(() => {
        for (const listener of this.messages) listener({ id: message.id, ok: true, bootId: 'synthetic-boot', sessionId: 'synthetic-session',
          data: { id: '1', handle: 'synthetic_actor', name: 'Synthetic Actor' } });
      });
      if (message.type === 'HEARTBEAT' && options.replyToHeartbeat !== false) queueMicrotask(() => this.receive({
        id: message.id, type: 'PONG', ok: true, bootId: message.bootId, sessionId: message.sessionId,
      }));
    }
    receive(message: Record<string, unknown>) { for (const listener of this.messages) listener(message); }
    disconnect() { for (const listener of this.disconnects) listener(); }
  }
  const api = {
    permissions: { request: (value: unknown) => {
      permissionRequests.push(plain(value));
      return options.request ? options.request() : Promise.resolve(options.permission ?? true);
    } },
    tabs: {
      get: (id: number) => {
        getIds.push(id);
        if (options.get) return options.get(id);
        const tab = tabs.find(item => item.id === id);
        return tab ? Promise.resolve(tab) : Promise.reject(new Error('Synthetic tab was closed.'));
      },
      query: (value: unknown) => { queries.push(plain(value)); return options.query ? options.query() : Promise.resolve(tabs); },
      create: (value: unknown) => { created.push(plain(value)); return Promise.resolve(xTab(99)); },
    },
    runtime: {
      id: 'synthetic-extension', lastError: undefined,
      getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
      connect: () => { connections++; const port = new FakePort(); ports.push(port); return port; },
    },
  };
  const moduleValue = { exports: {} as { ChromeAdapter: typeof ChromeAdapter } };
  runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports, chrome: api, URL,
    setTimeout: setTimer, clearTimeout: (id: number) => { timers.delete(id); },
    crypto: { randomUUID: () => `synthetic-${++nonce}` }, location: { href: controlUrl } });
  return { create: (url = controlUrl) => new moduleValue.exports.ChromeAdapter(url), permissionRequests, queries, getIds, created, sent, ports,
    connections: () => connections, advance, timerCount: () => timers.size };
}

test('missing-tab preparation requests only X permission synchronously before awaiting discovery', async () => {
  const permission = deferred<boolean>(), env = mockChrome({ request: () => permission.promise }), adapter = env.create();
  const prepared = adapter.prepareConnection();
  assert.deepEqual(env.permissionRequests, [{ origins: ['https://x.com/*'] }]);
  assert.equal(env.queries.length, 0); assert.equal(env.connections(), 0);
  permission.resolve(true);
  const choices = await prepared;
  assert.deepEqual(Array.from(choices, choice => choice.id), [11]); assert.equal(env.queries.length, 1);
  assert.equal(env.connections(), 0);
});

test('denied permission neither discovers tabs nor connects', async () => {
  const env = mockChrome({ permission: false }), adapter = env.create();
  await assert.rejects(adapter.prepareConnection(), /^Error: TAB_PERMISSION:/);
  assert.equal(env.permissionRequests.length, 1); assert.equal(env.queries.length, 0); assert.equal(env.connections(), 0);
});

test('a rejected permission API request is a permission error and sends no connection', async () => {
  const env = mockChrome({ request: () => Promise.reject(new Error('Synthetic gesture rejection.')) }), adapter = env.create();
  await assert.rejects(adapter.prepareConnection(), /^Error: TAB_PERMISSION:/);
  assert.equal(env.queries.length, 0); assert.equal(env.connections(), 0);
});

test('forced discovery requests permission synchronously even with a preferred toolbar tab', async () => {
  const permission = deferred<boolean>(), env = mockChrome({ request: () => permission.promise }), adapter = env.create(`${controlUrl}?tab=11`);
  const prepared = adapter.prepareConnection(true);
  assert.equal(env.permissionRequests.length, 1); assert.equal(env.getIds.length, 0); assert.equal(env.queries.length, 0);
  permission.resolve(true);
  assert.deepEqual(Array.from(await prepared, choice => choice.id), [11]); assert.equal(env.connections(), 0);
});

test('toolbar preparation revalidates the bound tab without requesting persistent permission', async () => {
  const env = mockChrome({ permission: false }), adapter = env.create(`${controlUrl}?tab=11`);
  assert.deepEqual(Array.from(await adapter.prepareConnection(), choice => choice.id), [11]);
  assert.deepEqual(env.getIds, [11]); assert.equal(env.permissionRequests.length, 0); assert.equal(env.queries.length, 0);
  assert.equal(env.connections(), 0);
});

test('closed preferred tab clears the binding; permission is requested only on the next explicit preparation', async () => {
  const env = mockChrome({ get: () => Promise.reject(new Error('Synthetic missing tab.')) }), adapter = env.create(`${controlUrl}?tab=11`);
  await assert.rejects(adapter.prepareConnection(), /^Error: TAB_REQUIRED:/);
  assert.equal(env.permissionRequests.length, 0); assert.equal(env.queries.length, 0);
  await assert.rejects(adapter.connect(), /^Error: TAB_REQUIRED:/);
  const next = adapter.prepareConnection();
  assert.equal(env.permissionRequests.length, 1); await next; assert.equal(env.connections(), 0);
});

test('hidden preferred-tab URL clears the binding and reports permission separately from X authentication', async () => {
  const env = mockChrome({ get: () => Promise.resolve({ id: 11, title: 'Synthetic hidden page' }) }), adapter = env.create(`${controlUrl}?tab=11`);
  await assert.rejects(adapter.prepareConnection(), /^Error: TAB_PERMISSION:/);
  assert.equal(env.permissionRequests.length, 0); assert.equal(env.queries.length, 0);
  await assert.rejects(adapter.connect(), /^Error: TAB_REQUIRED:/);
  const next = adapter.prepareConnection(); assert.equal(env.permissionRequests.length, 1); await next;
});

test('a preferred tab that left X is rejected without silently selecting another X tab', async () => {
  const env = mockChrome({ get: () => Promise.resolve({ id: 11, url: 'https://example.test/' }) }), adapter = env.create(`${controlUrl}?tab=11`);
  await assert.rejects(adapter.prepareConnection(), /^Error: TAB_REQUIRED:/);
  assert.equal(env.queries.length, 0); assert.equal(env.permissionRequests.length, 0); assert.equal(env.connections(), 0);
});

test('discovery filters actual tab URLs even when Chrome ignores its query URL filter', async () => {
  const env = mockChrome({ tabs: [xTab(),
    { id: 12, url: 'http://x.com/home' }, { id: 13, url: 'https://x.com.example.test/home' },
    { id: 14, url: 'https://example.test/https://x.com/' }, { id: 15, url: 'https://api.x.com/' },
    { id: 16, url: 'https://www.x.com/' }, { id: 17, url: 'chrome://extensions/' }, { id: 18 },
    { id: 19, url: 'not a URL' }, { id: 20, url: 'https://x.com@evil.test/' },
  ] }), adapter = env.create();
  assert.deepEqual(Array.from(await adapter.prepareConnection(), choice => choice.id), [11]);
  assert.equal(env.connections(), 0);
});

test('discovery excludes missing or unsafe tab IDs before offering choices', async () => {
  const env = mockChrome({ tabs: [xTab(), { url: 'https://x.com/home' }, xTab(-1), xTab(1.5),
    xTab(Number.NaN), xTab(Number.MAX_SAFE_INTEGER + 1)] }), adapter = env.create();
  assert.deepEqual(Array.from(await adapter.prepareConnection(), choice => choice.id), [11]);
});

test('no eligible X tab is a target error after permission, with no connection attempt', async () => {
  const env = mockChrome({ tabs: [] }), adapter = env.create();
  await assert.rejects(adapter.prepareConnection(), /^Error: TAB_REQUIRED:/);
  assert.equal(env.permissionRequests.length, 1); assert.equal(env.queries.length, 1); assert.equal(env.connections(), 0);
});

test('a single discovered tab still requires explicit selection before connect', async () => {
  const env = mockChrome(), adapter = env.create();
  await adapter.prepareConnection();
  await assert.rejects(adapter.connect(), /^Error: TAB_REQUIRED:/);
  assert.equal(env.connections(), 0);
});

test('multiple candidates do not connect or choose implicitly, and explicit selection determines the target', async () => {
  const env = mockChrome({ tabs: [xTab(11), xTab(22)] }), adapter = env.create();
  const choices = await adapter.prepareConnection();
  assert.deepEqual(Array.from(choices, choice => choice.id).sort((a, b) => a - b), [11, 22]);
  assert.equal(env.connections(), 0); adapter.selectTab(22);
  const account = await adapter.connect();
  assert.equal(account.id, '1'); assert.equal(env.connections(), 1);
  assert.equal(env.sent.find(message => message.type === 'CONNECT')?.tabId, 22);
  adapter.cancel();
});

test('selection rejects IDs that were not discovered, including malformed IDs', async () => {
  const env = mockChrome(), adapter = env.create(); await adapter.prepareConnection();
  for (const id of [22, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => adapter.selectTab(id), /TAB_REQUIRED:/);
  assert.equal(env.connections(), 0);
});

test('cancellation while permission is pending rejects its late grant before querying tabs', async () => {
  const permission = deferred<boolean>(), env = mockChrome({ request: () => permission.promise }), adapter = env.create();
  const pending = adapter.prepareConnection(), rejected = assert.rejects(pending, /^Error: CANCELLED:/);
  adapter.cancel(); permission.resolve(true); await rejected;
  assert.equal(env.queries.length, 0); assert.equal(env.connections(), 0);
  assert.throws(() => adapter.selectTab(11), /TAB_REQUIRED:/);
});

test('cancellation while discovery is pending cannot restore stale candidates', async () => {
  const found = deferred<Partial<chrome.tabs.Tab>[]>(), queried = deferred<void>();
  const env = mockChrome({ query: () => { queried.resolve(); return found.promise; } }), adapter = env.create();
  const pending = adapter.prepareConnection(), rejected = assert.rejects(pending, /^Error: CANCELLED:/);
  await queried.promise; adapter.cancel(); found.resolve([xTab()]); await rejected;
  assert.throws(() => adapter.selectTab(11), /TAB_REQUIRED:/); assert.equal(env.connections(), 0);
});

test('a permission API rejection arriving after cancellation stays cancelled', async () => {
  const permission = deferred<boolean>(), env = mockChrome({ request: () => permission.promise }), adapter = env.create();
  const pending = adapter.prepareConnection(), rejected = assert.rejects(pending, /^Error: CANCELLED:/);
  adapter.cancel(); permission.reject(new Error('Synthetic stale permission error.')); await rejected;
  assert.equal(env.queries.length, 0); assert.equal(env.connections(), 0);
});

test('a discovery error arriving after cancellation stays cancelled', async () => {
  const found = deferred<Partial<chrome.tabs.Tab>[]>(), queried = deferred<void>();
  const env = mockChrome({ query: () => { queried.resolve(); return found.promise; } }), adapter = env.create();
  const pending = adapter.prepareConnection(), rejected = assert.rejects(pending, /^Error: CANCELLED:/);
  await queried.promise; adapter.cancel(); found.reject(new Error('Synthetic stale discovery error.')); await rejected;
  assert.equal(env.connections(), 0);
});

test('cancel invalidates previously discovered choices before a selection is accepted', async () => {
  const env = mockChrome(), adapter = env.create(); await adapter.prepareConnection(); adapter.cancel();
  assert.throws(() => adapter.selectTab(11), /TAB_REQUIRED:/);
});

test('openX creates only the X home tab and never grants permission or connects', async () => {
  const env = mockChrome(), adapter = env.create(); await adapter.openX();
  assert.equal(env.created.length, 1); assert.equal((env.created[0] as { url: string }).url, 'https://x.com/home');
  assert.equal(env.permissionRequests.length, 0); assert.equal(env.queries.length, 0); assert.equal(env.connections(), 0);
  await assert.rejects(adapter.connect(), /^Error: TAB_REQUIRED:/);
});

test('missing or malformed URL tab parameters produce TAB_REQUIRED without an authentication claim', async () => {
  for (const query of ['', '?tab=-1', '?tab=NaN', '?tab=1.5', '?tab=9007199254740992']) {
    const env = mockChrome(), adapter = env.create(controlUrl + query);
    await assert.rejects(adapter.connect(), /^Error: TAB_REQUIRED:/); assert.equal(env.connections(), 0);
  }
});

test('unexpected worker disconnect notifies the session-lost listener and invalidates commands', async () => {
  const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
  adapter.setSessionLostListener(message => { lost.push(message); }); await adapter.connect();
  env.ports[0].disconnect();
  assert.equal(lost.length, 1); assert.match(lost[0], /WORKER_RESTART:|TAB_PERMISSION:|CANCELLED:/);
  await assert.rejects(adapter.identity('1'), /^Error: CANCELLED:/);
});

test('intentional cancel does not produce a spurious session-lost callback', async () => {
  const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
  adapter.setSessionLostListener(message => { lost.push(message); }); await adapter.connect(); adapter.cancel();
  assert.deepEqual(lost, []); assert.equal(env.sent.filter(message => message.type === 'CANCEL').length, 1);
});

test('connected control heartbeat sends only lease messages every 20 seconds and accepts matching PONG', async () => {
  const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`);
  await adapter.connect(); await env.advance(19_999);
  assert.equal(env.sent.filter(message => message.type === 'HEARTBEAT').length, 0);
  await env.advance(40_001);
  const beats = env.sent.filter(message => message.type === 'HEARTBEAT');
  assert.equal(beats.length, 3);
  assert.ok(beats.every(message => message.bootId === 'synthetic-boot' && message.sessionId === 'synthetic-session'));
  assert.equal(new Set(beats.map(message => message.id)).size, 3);
  assert.deepEqual(env.sent.map(message => message.type), ['CONNECT', 'HEARTBEAT', 'HEARTBEAT', 'HEARTBEAT']);
  assert.equal(env.permissionRequests.length + env.queries.length + env.getIds.length + env.created.length, 0);
  assert.equal(env.connections(), 1); assert.equal(env.timerCount(), 1); adapter.cancel();
});

test('missing PONG ends the session, clears timers, and never reconnects or sends an X command', async () => {
  const env = mockChrome({ replyToHeartbeat: false }), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
  adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect();
  await env.advance(20_000); assert.equal(env.timerCount(), 1); assert.deepEqual(lost, []);
  await env.advance(10_000); assert.equal(lost.length, 1); assert.match(lost[0], /^WORKER_RESTART:.*heartbeat/);
  assert.equal(env.timerCount(), 0); await env.advance(120_000);
  assert.equal(env.connections(), 1); assert.equal(env.sent.filter(message => message.type === 'HEARTBEAT').length, 1);
  assert.equal(env.sent.filter(message => message.type === 'COMMAND').length, 0);
  await assert.rejects(adapter.identity('1'), /^Error: CANCELLED:/);
});

test('cancel clears both a scheduled heartbeat and a pending PONG deadline', async () => {
  for (const elapsed of [0, 20_000]) {
    const env = mockChrome({ replyToHeartbeat: false }), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
    adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect(); await env.advance(elapsed);
    adapter.cancel(); const count = env.sent.length;
    assert.equal(env.timerCount(), 0); await env.advance(120_000);
    assert.equal(env.sent.length, count); assert.deepEqual(lost, []);
  }
});

test('terminal operation reply preserves its error and suppresses a later port-loss callback', async () => {
  const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
  adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect();
  const request = adapter.following('1', '-1');
  const rejected = assert.rejects(request, /^Error: SCHEMA: Synthetic original Following error$/);
  const command = env.sent.find(message => message.type === 'COMMAND')!;
  env.ports[0].receive({ id: command.id, ok: false, error: 'SCHEMA: Synthetic original Following error', sessionEnded: true, bootId: 'synthetic-boot' });
  await rejected; env.ports[0].disconnect(); await env.advance(120_000);
  assert.deepEqual(lost, []); assert.equal(env.timerCount(), 0); assert.equal(env.connections(), 1);
  await assert.rejects(adapter.identity('1'), /^Error: CANCELLED:/);
});

test('a nonterminal rejected operation keeps the control heartbeat alive', async () => {
  const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`);
  await adapter.connect(); const request = adapter.resolve('1', 'tester');
  const rejected = assert.rejects(request, /^Error: SKIPPED:/);
  const command = env.sent.find(message => message.type === 'COMMAND')!;
  env.ports[0].receive({ id: command.id, ok: false, error: 'SKIPPED: Synthetic rejected target', sessionEnded: false });
  await rejected; await env.advance(20_000);
  assert.equal(env.sent.filter(message => message.type === 'HEARTBEAT').length, 1); assert.equal(env.timerCount(), 1); adapter.cancel();
});

test('explicit SESSION_ENDED preserves the known reason and ignores the following generic disconnect', async () => {
  for (const reason of ['TAB_REQUIRED: The X tab closed', 'TAB_REQUIRED: The X page reloaded', 'TAB_PERMISSION: Access was revoked', 'CANCELLED: A new session replaced this one']) {
    const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
    adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect();
    env.ports[0].receive({ type: 'SESSION_ENDED', error: reason, bootId: 'synthetic-boot', sessionId: 'synthetic-session' });
    env.ports[0].disconnect(); await env.advance(120_000);
    assert.deepEqual(lost, [reason]); assert.equal(env.timerCount(), 0); assert.equal(env.connections(), 1);
  }
});

test('stale SESSION_ENDED and PONG cannot refresh or end another control lease', async () => {
  const env = mockChrome({ replyToHeartbeat: false }), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
  adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect();
  env.ports[0].receive({ type: 'SESSION_ENDED', error: 'TAB_REQUIRED: stale', bootId: 'old-boot', sessionId: 'old-session' });
  assert.deepEqual(lost, []); await env.advance(20_000);
  const beat = env.sent.find(message => message.type === 'HEARTBEAT')!;
  env.ports[0].receive({ id: `${beat.id}-stale`, type: 'PONG', ok: true, bootId: 'synthetic-boot', sessionId: 'synthetic-session' });
  await env.advance(10_000); assert.equal(lost.length, 1); assert.equal(env.timerCount(), 0);
});

test('a heartbeat response for a different boot or session stops immediately', async () => {
  for (const mismatch of [{ bootId: 'other-boot', sessionId: 'synthetic-session' }, { bootId: 'synthetic-boot', sessionId: 'other-session' }]) {
    const env = mockChrome({ replyToHeartbeat: false }), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
    adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect(); await env.advance(20_000);
    const beat = env.sent.find(message => message.type === 'HEARTBEAT')!;
    env.ports[0].receive({ id: beat.id, type: 'PONG', ok: true, ...mismatch });
    assert.equal(lost.length, 1); assert.match(lost[0], /^WORKER_RESTART:/); assert.equal(env.timerCount(), 0);
  }
});

test('heartbeat loss while a write is pending remains UNCERTAIN with no automatic replay', async () => {
  const env = mockChrome({ replyToHeartbeat: false }), adapter = env.create(`${controlUrl}?tab=11`);
  await adapter.connect(); const write = adapter.unfollow('1', '2', true);
  const rejected = assert.rejects(write, /^Error: UNCERTAIN:.*heartbeat/);
  await env.advance(30_000); await rejected; await env.advance(180_000);
  assert.equal(env.timerCount(), 0); assert.equal(env.connections(), 1);
  assert.equal(env.sent.filter(message => message.type === 'COMMAND').length, 1);
});

test('a known tab loss during a pending write still reports UNCERTAIN', async () => {
  const env = mockChrome(), adapter = env.create(`${controlUrl}?tab=11`), lost: string[] = [];
  adapter.setSessionLostListener(message => lost.push(message)); await adapter.connect();
  const rejected = assert.rejects(adapter.followAuthor('1'), /^Error: UNCERTAIN:.*TAB_REQUIRED:/);
  env.ports[0].receive({ type: 'SESSION_ENDED', error: 'TAB_REQUIRED: The X page reloaded', bootId: 'synthetic-boot', sessionId: 'synthetic-session' });
  await rejected; assert.deepEqual(lost, ['TAB_REQUIRED: The X page reloaded']); assert.equal(env.timerCount(), 0);
});
