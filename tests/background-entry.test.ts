import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

const compiled = buildSync({ entryPoints: [fileURLToPath(new URL('../src/background.ts', import.meta.url))],
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', write: false }).outputFiles[0].text;
const page = 'chrome-extension://synthetic-extension/index.html';
const account = { id: '1', handle: 'synthetic_actor', name: 'Synthetic Actor' };
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function event<T extends unknown[]>() {
  const listeners: ((...args: T) => void)[] = [];
  return { addListener: (listener: (...args: T) => void) => { listeners.push(listener); },
    emit: (...args: T) => { for (const listener of listeners) listener(...args); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Message = Record<string, unknown>;
type Injection = { target: { tabId: number }; files?: string[]; args?: [{ operation: { kind: string } }] };
function worker(options: { granted?: boolean; url?: string | null; closed?: boolean; storedData?: unknown } = {}) {
  const onConnect = event<[MockPort]>(), onRemoved = event<[number]>();
  const onUpdated = event<[number, { status?: string; url?: string }]>();
  const permissionRemoved = event<[{ origins?: string[] }]>();
  const injections: Injection[] = [];
  const permissionChecks: unknown[] = [];
  const tabReads: number[] = [];
  let sequence = 0;
  let getTab: (tabId: number) => Promise<{ id: number; url?: string }> = async tabId => {
    if (options.closed) throw new Error('Synthetic closed tab');
    return { id: tabId, ...(options.url === null ? {} : { url: options.url ?? 'https://x.com/home' }) };
  };
  let permission: () => Promise<boolean> = async () => options.granted === true;
  let script: (details: Injection) => Promise<unknown[]> = async details => details.files ? []
    : [{ result: { ok: true, data: details.args?.[0].operation.kind === 'connect' ? account : null } }];
  const chrome = {
    runtime: { id: 'synthetic-extension', getURL: (file: string) => `chrome-extension://synthetic-extension/${file}`,
      onConnect, getContexts: async () => [] },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ reciprocal_data: options.storedData }) }, session: { setAccessLevel: async () => {} } },
    permissions: { contains: async (details: unknown) => { permissionChecks.push(details); return permission(); }, onRemoved: permissionRemoved },
    tabs: { get: (tabId: number) => { tabReads.push(tabId); return getTab(tabId); }, remove: async () => {}, onRemoved, onUpdated },
    scripting: { executeScript: async (details: Injection) => { injections.push(details); return script(details); } },
    windows: { onRemoved: event<[number]>(), create: async () => ({ id: 99 }) },
    action: { onClicked: event<[unknown]>() },
  };
  runInNewContext(compiled, { chrome, URL, crypto: { randomUUID: () => `synthetic-${++sequence}` } });
  class MockPort {
    name = 'reciprocal-x-control-v1';
    sender: { id: string; url: string };
    onMessage = event<[Message]>();
    onDisconnect = event<[]>();
    messages: Message[] = [];
    messagesAtDisconnect: Message[] | null = null;
    disconnected = false;
    constructor(url: string) { this.sender = { id: 'synthetic-extension', url }; }
    postMessage(message: Message) { if (this.disconnected) throw new Error('Closed synthetic port'); this.messages.push(message); }
    disconnect() { if (!this.disconnected) { this.messagesAtDisconnect = [...this.messages]; this.disconnected = true; this.onDisconnect.emit(); } }
    send(message: Message) { this.onMessage.emit(message); }
    async reply(id: string) {
      for (let i = 0; i < 12; i++) { await tick(); const reply = this.messages.find(message => message.id === id); if (reply) return reply; }
      throw new Error(`No synthetic worker reply for ${id}`);
    }
  }
  return { injections, permissionChecks, tabReads, permissionRemoved, onRemoved, onUpdated,
    permission: (callback: typeof permission) => { permission = callback; },
    getTab: (callback: typeof getTab) => { getTab = callback; },
    script: (callback: typeof script) => { script = callback; },
    port: (url = page, mutate?: (port: MockPort) => void) => { const port = new MockPort(url); mutate?.(port); onConnect.emit(port); return port; } };
}

test('optional X grant connects a selected tab without a declared toolbar tab', async () => {
  const w = worker({ granted: true }), port = w.port();
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const reply = await port.reply('connect');
  assert.equal(reply.ok, true);
  assert.equal((reply.data as typeof account).id, account.id);
  assert.equal(w.permissionChecks.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(w.permissionChecks[0])), { origins: ['https://x.com/*'] });
  assert.equal(w.injections.length, 2);
  assert.ok(w.injections.every(injection => injection.target.tabId === 41));
});
test('a selected tab different from the toolbar declaration requires the optional X grant', async () => {
  const denied = worker(), deniedPort = denied.port(`${page}?tab=10`);
  deniedPort.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  assert.match(String((await deniedPort.reply('connect')).error), /^TAB_PERMISSION:/);
  assert.equal(denied.injections.length, 0);
  const allowed = worker({ granted: true }), allowedPort = allowed.port(`${page}?tab=10`);
  allowedPort.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  assert.equal((await allowedPort.reply('connect')).ok, true);
  assert.ok(allowed.injections.every(injection => injection.target.tabId === 41));
});
test('no toolbar declaration and no grant produces TAB_PERMISSION with zero injections', async () => {
  const w = worker(), port = w.port();
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  assert.match(String((await port.reply('connect')).error), /^TAB_PERMISSION:/);
  await tick();
  assert.equal(w.injections.length, 0);
});
test('the matching toolbar activeTab path does not require an optional host grant', async () => {
  const w = worker(), port = w.port(`${page}?tab=41`);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  assert.equal((await port.reply('connect')).ok, true);
  assert.equal(w.permissionChecks.length, 0);
  assert.equal(w.injections.length, 2);
});
test('missing, invalid, closed, and non-X tabs are TAB_REQUIRED without injection', async () => {
  for (const tabId of [undefined, null, -1, 1.5, '41']) {
    const w = worker({ granted: true }), port = w.port();
    port.send({ type: 'CONNECT', id: 'connect', tabId });
    assert.match(String((await port.reply('connect')).error), /^TAB_REQUIRED:/);
    assert.equal(w.injections.length, 0);
  }
  for (const options of [{ closed: true }, { url: 'https://example.test/' }, { url: 'http://x.com/' }, { url: 'https://x.com.example.test/' }]) {
    const w = worker({ granted: true, ...options }), port = w.port();
    port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
    assert.match(String((await port.reply('connect')).error), /^TAB_REQUIRED:/);
    assert.equal(w.injections.length, 0);
  }
});
test('an existing tab with an invisible URL is TAB_PERMISSION', async () => {
  const w = worker({ url: null }), port = w.port(`${page}?tab=41`);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  assert.match(String((await port.reply('connect')).error), /^TAB_PERMISSION:/);
  assert.equal(w.injections.length, 0);
});
test('untrusted extension ports are disconnected before accepting commands', async () => {
  for (const mutate of [(port: { name: string }) => { port.name = 'wrong'; },
    (port: { sender: { id: string } }) => { port.sender.id = 'other-extension'; },
    (port: { sender: { url: string } }) => { port.sender.url = `${page}/other`; },
    (port: { sender: { url: string } }) => { port.sender.url = 'https://x.com/'; }]) {
    const w = worker({ granted: true }), port = w.port(page, mutate);
    assert.equal(port.disconnected, true);
    port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
    await tick();
    assert.equal(w.injections.length, 0);
    assert.equal(w.permissionChecks.length, 0);
  }
});
test('permission revocation during CONNECT prevents a late grant result from injecting', async () => {
  const gate = deferred<boolean>(), w = worker(), port = w.port();
  w.permission(() => gate.promise);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  w.permissionRemoved.emit({ origins: ['https://x.com/*'] });
  assert.equal(port.disconnected, true);
  gate.resolve(true);
  await tick(); await tick();
  assert.equal(w.injections.length, 0);
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].type, 'SESSION_ENDED');
  assert.match(String(port.messages[0].error), /^TAB_PERMISSION:/);
  assert.deepEqual(port.messagesAtDisconnect, port.messages);
});
test('navigation during CONNECT prevents injection after the pending tab lookup resolves', async () => {
  const gate = deferred<{ id: number; url: string }>(), w = worker(), port = w.port(`${page}?tab=41`);
  w.getTab(() => gate.promise);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  w.onUpdated.emit(41, { status: 'loading' });
  gate.resolve({ id: 41, url: 'https://x.com/home' });
  await tick(); await tick();
  assert.equal(port.disconnected, true);
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].type, 'SESSION_ENDED');
  assert.match(String(port.messages[0].error), /^TAB_REQUIRED:/);
  assert.deepEqual(port.messagesAtDisconnect, port.messages);
  assert.equal(w.injections.length, 0);
});
test('a new owner replaces a pending CONNECT and the old one cannot resume', async () => {
  const gate = deferred<boolean>(), w = worker(), oldPort = w.port();
  w.permission(() => gate.promise);
  oldPort.send({ type: 'CONNECT', id: 'old', tabId: 41 });
  const newPort = w.port(`${page}?tab=42`);
  newPort.send({ type: 'CONNECT', id: 'new', tabId: 42 });
  assert.equal((await newPort.reply('new')).ok, true);
  gate.resolve(true);
  await tick(); await tick();
  assert.equal(oldPort.disconnected, true);
  assert.ok(w.injections.every(injection => injection.target.tabId === 42));
});
test('revocation after connect disconnects the port and blocks subsequent commands', async () => {
  const w = worker({ granted: true }), port = w.port();
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const connected = await port.reply('connect');
  w.permission(async () => false);
  w.permissionRemoved.emit({ origins: ['https://x.com/*'] });
  assert.equal(port.disconnected, true);
  const before = w.injections.length;
  port.send({ type: 'COMMAND', id: 'command', bootId: connected.bootId, sessionId: connected.sessionId,
    operation: { kind: 'identity', actorId: '1' } });
  await tick(); await tick();
  assert.equal(w.injections.length, before);
});
test('executeScript access failure is TAB_PERMISSION and does not initialize a page lease', async () => {
  const w = worker(), port = w.port(`${page}?tab=41`);
  w.script(async () => { throw new Error('Synthetic private browser permission error'); });
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const reply = await port.reply('connect');
  assert.match(String(reply.error), /^TAB_PERMISSION:/);
  assert.equal(reply.sessionEnded, true);
  assert.doesNotMatch(String(reply.error), /private browser/);
  await tick();
  assert.equal(w.injections.length, 1);
});
test('access failure during a write remains UNCERTAIN', async () => {
  const w = worker(), port = w.port(`${page}?tab=41`);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const connected = await port.reply('connect');
  w.script(async details => {
    if (details.args?.[0].operation.kind === 'followAuthor') throw new Error('Synthetic access revoked');
    return [{ result: { ok: true, data: null } }];
  });
  port.send({ type: 'COMMAND', id: 'write', bootId: connected.bootId, sessionId: connected.sessionId,
    operation: { kind: 'followAuthor', actorId: '1' } });
  const reply = await port.reply('write');
  assert.match(String(reply.error), /^UNCERTAIN:/);
  assert.equal(reply.sessionEnded, true);
});

test('a live heartbeat returns the same lease without any tab, permission, or page operation', async () => {
  const w = worker({ granted: true }), port = w.port();
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const connected = await port.reply('connect');
  const before = [w.tabReads.length, w.permissionChecks.length, w.injections.length];
  port.send({ type: 'HEARTBEAT', id: 'heartbeat', bootId: connected.bootId, sessionId: connected.sessionId });
  assert.deepEqual(JSON.parse(JSON.stringify(await port.reply('heartbeat'))), {
    id: 'heartbeat', ok: true, type: 'PONG', bootId: connected.bootId, sessionId: connected.sessionId,
  });
  await tick();
  assert.deepEqual([w.tabReads.length, w.permissionChecks.length, w.injections.length], before);
  assert.equal(port.disconnected, false);
});

test('heartbeat stays responsive during a pending command and BUSY does not end the lease', async () => {
  const gate = deferred<unknown[]>(), w = worker({ granted: true }), port = w.port();
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const connected = await port.reply('connect');
  w.script(async details => details.args?.[0].operation.kind === 'following' ? gate.promise : [{ result: { ok: true, data: null } }]);
  const lease = { bootId: connected.bootId, sessionId: connected.sessionId };
  port.send({ type: 'COMMAND', id: 'following', ...lease, operation: { kind: 'following', actorId: account.id, cursor: '' } });
  await tick();
  assert.equal(w.injections.at(-1)?.args?.[0].operation.kind, 'following');
  assert.equal(port.messages.some(message => message.id === 'following'), false);
  const before = [w.tabReads.length, w.permissionChecks.length, w.injections.length];
  port.send({ type: 'HEARTBEAT', id: 'while-busy', ...lease });
  assert.equal((await port.reply('while-busy')).type, 'PONG');
  assert.deepEqual([w.tabReads.length, w.permissionChecks.length, w.injections.length], before);
  port.send({ type: 'COMMAND', id: 'second-command', ...lease, operation: { kind: 'identity', actorId: account.id } });
  const busy = await port.reply('second-command');
  assert.match(String(busy.error), /^BUSY:/);
  assert.notEqual(busy.sessionEnded, true);
  gate.resolve([{ result: { ok: true, data: { people: [], nextCursor: null } } }]);
  assert.equal((await port.reply('following')).ok, true);
  port.send({ type: 'HEARTBEAT', id: 'after-busy', ...lease });
  assert.equal((await port.reply('after-busy')).type, 'PONG');
});

test('heartbeat cannot establish a lease before CONNECT has established an actor', async () => {
  const gate = deferred<boolean>(), w = worker(), port = w.port();
  w.permission(() => gate.promise);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  // UUIDs are deterministic in this isolated worker: boot first, then the pending session.
  port.send({ type: 'HEARTBEAT', id: 'premature', bootId: 'synthetic-1', sessionId: 'synthetic-2' });
  const reply = await port.reply('premature');
  assert.match(String(reply.error), /^CANCELLED:/);
  assert.equal(reply.sessionEnded, true);
  gate.resolve(true);
  assert.equal((await port.reply('connect')).ok, false);
  assert.equal(w.injections.length, 0);
});

for (const [field, code] of [['bootId', 'WORKER_RESTART'], ['sessionId', 'CANCELLED']] as const) {
  test(`a heartbeat with stale ${field} ends only its current lease with ${code}`, async () => {
    const w = worker({ granted: true }), port = w.port();
    port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
    const connected = await port.reply('connect');
    const lease = { bootId: connected.bootId, sessionId: connected.sessionId };
    port.send({ type: 'HEARTBEAT', id: 'stale', ...lease, [field]: 'obsolete' });
    const stale = await port.reply('stale');
    assert.match(String(stale.error), new RegExp(`^${code}:`));
    assert.equal(stale.sessionEnded, true);
    port.send({ type: 'HEARTBEAT', id: 'original-lease', ...lease });
    const ended = await port.reply('original-lease');
    assert.match(String(ended.error), /^CANCELLED:/);
    assert.equal(ended.sessionEnded, true);
    assert.equal(w.injections.filter(injection => injection.args && injection.args[0].operation.kind !== 'cancel').length, 1);
  });
}

test('a queued heartbeat from a replaced port cannot invalidate the replacement owner', async () => {
  const w = worker({ granted: true }), oldPort = w.port();
  oldPort.send({ type: 'CONNECT', id: 'old', tabId: 41 });
  const oldLease = await oldPort.reply('old');
  const replacement = w.port();
  replacement.send({ type: 'CONNECT', id: 'replacement', tabId: 42 });
  const connected = await replacement.reply('replacement');
  const notification = oldPort.messages.find(message => message.type === 'SESSION_ENDED');
  assert.ok(notification);
  assert.match(String(notification.error), /^CANCELLED:/);
  assert.equal(notification.bootId, oldLease.bootId);
  assert.equal(notification.sessionId, oldLease.sessionId);
  assert.ok(oldPort.messagesAtDisconnect?.includes(notification));
  oldPort.send({ type: 'HEARTBEAT', id: 'queued-old-heartbeat', bootId: 'obsolete', sessionId: oldLease.sessionId });
  await tick(); await tick();
  replacement.send({ type: 'HEARTBEAT', id: 'replacement-heartbeat', bootId: connected.bootId, sessionId: connected.sessionId });
  assert.equal((await replacement.reply('replacement-heartbeat')).type, 'PONG');
  replacement.send({ type: 'COMMAND', id: 'replacement-command', bootId: connected.bootId, sessionId: connected.sessionId,
    operation: { kind: 'identity', actorId: account.id } });
  assert.equal((await replacement.reply('replacement-command')).ok, true);
  assert.equal(replacement.disconnected, false);
  assert.equal(w.injections.some(injection => injection.target.tabId === 42 && injection.args?.[0].operation.kind === 'cancel'), false);
});

for (const code of ['RATE_LIMIT', 'AUTH', 'ACCOUNT_CHANGED', 'SCHEMA', 'NETWORK', 'UNCERTAIN', 'HTTP', 'API_UNAVAILABLE', 'TAB_REQUIRED', 'TAB_PERMISSION']) {
  test(`${code} command failure explicitly marks the session ended`, async () => {
    const w = worker(), port = w.port(`${page}?tab=41`);
    port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
    const connected = await port.reply('connect');
    w.script(async details => [{ result: details.args?.[0].operation.kind === 'cancel'
      ? { ok: true, data: null } : { ok: false, error: `${code}: Synthetic failure.` } }]);
    port.send({ type: 'COMMAND', id: 'command', bootId: connected.bootId, sessionId: connected.sessionId,
      operation: { kind: 'identity', actorId: account.id } });
    const reply = await port.reply('command');
    assert.match(String(reply.error), new RegExp(`^${code}:`));
    assert.equal(reply.sessionEnded, true);
    port.send({ type: 'HEARTBEAT', id: 'after-failure', bootId: connected.bootId, sessionId: connected.sessionId });
    const ended = await port.reply('after-failure');
    assert.match(String(ended.error), /^CANCELLED:/);
    assert.equal(ended.sessionEnded, true);
  });
}

test('whitelist SKIPPED does not end the session or dispatch the prepared unfollow', async () => {
  const w = worker({ storedData: { whitelists: { '1': [{ id: '2', handle: 'synthetic_peer' }] } } });
  const port = w.port(`${page}?tab=41`);
  port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
  const connected = await port.reply('connect');
  w.script(async details => [{ result: { ok: true, data: details.args?.[0].operation.kind === 'prepareUnfollow'
    ? { target: { id: '2', handle: 'synthetic_peer' }, proofId: 'synthetic-proof' } : null } }]);
  port.send({ type: 'COMMAND', id: 'whitelisted', bootId: connected.bootId, sessionId: connected.sessionId,
    operation: { kind: 'unfollow', actorId: account.id, targetId: '2', automatic: true } });
  const reply = await port.reply('whitelisted');
  assert.match(String(reply.error), /^SKIPPED:/);
  assert.notEqual(reply.sessionEnded, true);
  assert.equal(w.injections.some(injection => injection.args?.[0].operation.kind === 'unfollow'), false);
  port.send({ type: 'HEARTBEAT', id: 'after-skipped', bootId: connected.bootId, sessionId: connected.sessionId });
  assert.equal((await port.reply('after-skipped')).type, 'PONG');
});

for (const [trigger, code] of [['closed', 'TAB_REQUIRED'], ['loading', 'TAB_REQUIRED'], ['left-x', 'TAB_REQUIRED'], ['permission', 'TAB_PERMISSION']] as const) {
  test(`${trigger} tear-down reports SESSION_ENDED before disconnecting its owner`, async () => {
    const w = worker({ granted: true }), port = w.port();
    port.send({ type: 'CONNECT', id: 'connect', tabId: 41 });
    const connected = await port.reply('connect');
    if (trigger === 'closed') w.onRemoved.emit(41);
    else if (trigger === 'loading') w.onUpdated.emit(41, { status: 'loading' });
    else if (trigger === 'left-x') w.onUpdated.emit(41, { url: 'https://example.test/' });
    else w.permissionRemoved.emit({ origins: ['https://x.com/*'] });
    assert.equal(port.disconnected, true);
    const notification = port.messages.find(message => message.type === 'SESSION_ENDED');
    assert.ok(notification);
    assert.match(String(notification.error), new RegExp(`^${code}:`));
    assert.equal(notification.id, undefined);
    assert.equal(notification.bootId, connected.bootId);
    assert.equal(notification.sessionId, connected.sessionId);
    assert.ok(port.messagesAtDisconnect?.includes(notification));
    await tick();
    assert.equal(port.messages.filter(message => message.type === 'SESSION_ENDED').length, 1);
  });
}
