import { isWhitelisted, type PageOperation, type RuntimeInput, type RuntimeResult } from './x-api';
import type { Account, Person } from './types';

const bootId = crypto.randomUUID();
type Owner = { port: chrome.runtime.Port; sessionId: string; tabId: number; actorId: string | null; cancelled: boolean; busy: boolean; requiresHostPermission: boolean; pageStarted: boolean };
let owner: Owner | null = null;
let windowId: number | null = null;
let opening: Promise<void> = Promise.resolve();
const isX = (url: string | undefined): boolean => { try { return new URL(url ?? '').origin === 'https://x.com'; } catch { return false; } };
const xOrigin = 'https://x.com/*';

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function execute(session: Owner, operation: PageOperation): Promise<unknown> {
  const isWrite = operation.kind === 'unfollow' || operation.kind === 'followAuthor';
  const checkLease = (dispatched = false): void => {
    if (operation.kind !== 'cancel' && (owner !== session || session.cancelled)) throw new Error(dispatched && isWrite
      ? 'UNCERTAIN: The control session closed during an action.' : 'CANCELLED: This control session is no longer active.');
  };
  checkLease();
  if (session.requiresHostPermission) {
    const granted = await chrome.permissions.contains({ origins: [xOrigin] }).catch(() => false);
    checkLease();
    if (!granted) throw new Error(isWrite
      ? 'UNCERTAIN: X access was revoked before the action could be confirmed. Verify the relationship before retrying.'
      : 'TAB_PERMISSION: Allow access to x.com, or click the extension icon from the X tab to reconnect.');
  }
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  checkLease();
  if (!tab) throw new Error('TAB_REQUIRED: The selected X tab was closed. Select an open X tab.');
  if (typeof tab.url !== 'string' || !tab.url) throw new Error('TAB_PERMISSION: The selected tab URL is not visible. Allow access to x.com, or click the extension icon from that tab.');
  if (!isX(tab.url)) throw new Error('TAB_REQUIRED: The selected tab is no longer on https://x.com. Select an X tab.');
  const inject = async (details: Parameters<typeof chrome.scripting.executeScript>[0]) => {
    try { return await chrome.scripting.executeScript(details); }
    catch {
      if (isWrite) throw new Error('UNCERTAIN: The X page connection ended during an action. Verify the relationship before trying again.');
      checkLease();
      throw new Error('TAB_PERMISSION: Cannot access the selected X tab. Allow access to x.com, or click the extension icon from that tab.');
    }
  };
  let result: RuntimeResult | undefined;
  if(operation.kind==='connect'){
    await inject({target:{tabId:session.tabId,frameIds:[0]},world:'MAIN',files:['x-page.js']});
    checkLease();
  }
  if (operation.kind === 'connect') session.pageStarted = true;
  const injections = await inject({
      target: { tabId: session.tabId, frameIds: [0] }, world: 'MAIN',
      func: (input:RuntimeInput) => {
        const runtime=(window as typeof window & {__reciprocalXRuntimeV2?:(input:RuntimeInput)=>RuntimeResult|Promise<RuntimeResult>}).__reciprocalXRuntimeV2;
        return runtime?runtime(input):{ok:false,error:'API_UNAVAILABLE: Reload the X page and reopen the extension.'};
      },
      args: [{ type: 'PAGE', sessionId: session.sessionId, bootId, operation }],
  });
  checkLease(true);
  result = injections[0]?.result as RuntimeResult | undefined;
  if (!result || typeof result.ok !== 'boolean') throw new Error('SCHEMA: The X adapter returned no valid result.');
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function stop(session: Owner): void {
  if (session.cancelled) return;
  session.cancelled = true;
  if (owner === session) owner = null;
  // Cancellation is best effort after a page command started. Revoking access cannot
  // retract an in-flight request, and may prevent this cancellation injection too.
  if (session.pageStarted) void execute(session, { kind: 'cancel' }).catch(() => {});
}

function endSession(session: Owner, error: string): void {
  stop(session);
  try { session.port.postMessage({ type: 'SESSION_ENDED', error, bootId, sessionId: session.sessionId }); } catch { /* UI closed */ }
  try { session.port.disconnect(); } catch { /* UI closed */ }
}

function operationFrom(value: unknown, actorId: string): Exclude<PageOperation, { kind: 'connect' | 'cancel' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCHEMA: Invalid command.');
  const op = value as Record<string, unknown>;
  if (op.actorId !== actorId) throw new Error('ACCOUNT_CHANGED: Command does not match the connected account.');
  switch (op.kind) {
    case 'identity': return { kind: 'identity', actorId };
    case 'following':
      if (typeof op.cursor === 'string') return { kind: 'following', actorId, cursor: op.cursor };
      break;
    case 'relations':
      if (Array.isArray(op.ids) && op.ids.length <= 100 && op.ids.every(v => typeof v === 'string')) return { kind: 'relations', actorId, ids: op.ids };
      break;
    case 'resolve':
      if (typeof op.handle === 'string') return { kind: 'resolve', actorId, handle: op.handle };
      break;
    case 'unfollow':
      if (typeof op.targetId === 'string' && (op.automatic === undefined || typeof op.automatic === 'boolean')) return { kind: 'unfollow', actorId, targetId: op.targetId, automatic: op.automatic === true };
      break;
    case 'followAuthor': return { kind: 'followAuthor', actorId };
  }
  throw new Error('SCHEMA: Unsupported command; arbitrary URLs and operations are not accepted.');
}

chrome.runtime.onConnect.addListener(port => {
  const expectedPage = chrome.runtime.getURL('index.html');
  if (port.name !== 'reciprocal-x-control-v1' || port.sender?.id !== chrome.runtime.id || !port.sender?.url || port.sender.url.split('?')[0].split('#')[0] !== expectedPage) {
    port.disconnect(); return;
  }
  let session: Owner | null = null;
  const respond = (id: string, payload: Record<string, unknown>): void => { try { port.postMessage({ id, ...payload }); } catch { /* UI closed */ } };
  port.onDisconnect.addListener(() => { if (session) stop(session); });
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'CANCEL') { if (session) stop(session); return; }
    if (typeof msg.id !== 'string') return;
    const requestId = msg.id;
    void (async () => {
      try {
        if (msg.type === 'CONNECT') {
          if (session) throw new Error('CANCELLED: Open a new control session to reconnect.');
          const tabId = msg.tabId;
          const declaredTab = new URL(port.sender!.url!).searchParams.get('tab');
          if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) throw new Error('TAB_REQUIRED: Select an open https://x.com tab before connecting.');
          if (owner) endSession(owner, 'CANCELLED: This control session was replaced by another connection. Reconnect explicitly.');
          session = { port, sessionId: crypto.randomUUID(), tabId, actorId: null, cancelled: false, busy: true,
            requiresHostPermission: declaredTab !== String(tabId), pageStarted: false };
          owner = session;
          const account = await execute(session, { kind: 'connect' }) as Account;
          if (owner !== session || session.cancelled) throw new Error('CANCELLED: Connection was replaced.');
          session.actorId = account.id;
          session.busy = false;
          respond(requestId, { ok: true, data: account, bootId, sessionId: session.sessionId });
          return;
        }
        if (msg.type !== 'COMMAND' && msg.type !== 'HEARTBEAT') throw new Error('SCHEMA: Unknown command envelope.');
        if (msg.bootId !== bootId) throw new Error('WORKER_RESTART: The worker restarted. Reconnect explicitly.');
        const current = session;
        if (!current || owner !== current || current.cancelled || msg.sessionId !== current.sessionId || !current.actorId) throw new Error('CANCELLED: No active session. Reconnect explicitly.');
        if (msg.type === 'HEARTBEAT') {
          respond(requestId, { type: 'PONG', ok: true, bootId, sessionId: current.sessionId });
          return;
        }
        if (current.busy) throw new Error('BUSY: Another operation is still in progress.');
        const operation = operationFrom(msg.operation, current.actorId);
        current.busy = true;
        try {
          let data: unknown;
          if (operation.kind === 'unfollow') {
            const prepared = await execute(current, { kind: 'prepareUnfollow', actorId: operation.actorId, targetId: operation.targetId }) as { target: Person; proofId: string };
            if (operation.automatic) {
              const stored = await chrome.storage.local.get('reciprocal_data');
              if (isWhitelisted(stored.reciprocal_data, operation.actorId, prepared.target)) throw new Error('SKIPPED: This account is on the latest whitelist.');
            }
            if (owner !== current || current.cancelled) throw new Error('CANCELLED: Paused before the write was sent.');
            data = await execute(current, { ...operation, proofId: prepared.proofId });
          } else data = await execute(current, operation);
          respond(requestId, { ok: true, data, bootId, sessionId: current.sessionId });
        } finally { current.busy = false; }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'NETWORK: Extension operation failed.';
        // A rejected relationship (SKIPPED) is not a transport failure and does not invalidate the session.
        if (session && (msg.type === 'HEARTBEAT' || /^(RATE_LIMIT|AUTH|ACCOUNT_CHANGED|SCHEMA|NETWORK|UNCERTAIN|HTTP|API_UNAVAILABLE|WORKER_RESTART|TAB_REQUIRED|TAB_PERMISSION):/.test(message))) stop(session);
        respond(requestId, { ok: false, error: message, bootId, sessionEnded: session?.cancelled === true });
      }
    })();
  });
});

function disconnectOwner(error: string): void {
  if (!owner) return;
  endSession(owner, error);
}
chrome.tabs.onRemoved.addListener(tabId => { if (owner?.tabId === tabId) disconnectOwner('TAB_REQUIRED: The selected X tab was closed. Select an open X tab.'); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // A full navigation invalidates the page lease, even when it remains on x.com.
  if (owner?.tabId === tabId && (change.status === 'loading' || (change.url !== undefined && !isX(change.url)))) disconnectOwner('TAB_REQUIRED: The selected X page reloaded or navigated. Reconnect after it finishes loading.');
});
chrome.permissions.onRemoved.addListener(permissions => {
  if (permissions.origins?.includes(xOrigin) && owner) {
    disconnectOwner('TAB_PERMISSION: Access to x.com was revoked. Allow access and reconnect explicitly.');
  }
});
chrome.windows.onRemoved.addListener(id => { if (id === windowId) { windowId = null; disconnectOwner('CANCELLED: The control window was closed. Reconnect explicitly.'); } });
chrome.action.onClicked.addListener(tab => {
  opening = opening.catch(() => {}).then(async () => {
    if (owner) endSession(owner, 'CANCELLED: A new control window replaced this connection. Reconnect explicitly.');
    // Worker restarts lose windowId. Discover all surviving control pages, including tabs moved into normal windows.
    const expectedPage = chrome.runtime.getURL('index.html');
    const contexts = await chrome.runtime.getContexts({});
    const controlTabs = [...new Set(contexts.filter(context =>
      context.tabId >= 0 && context.documentUrl?.split('?')[0].split('#')[0] === expectedPage,
    ).map(context => context.tabId))];
    windowId = null;
    // Remove only our own control tabs; never close a browser window that may contain unrelated sites.
    await Promise.all(controlTabs.map(id => chrome.tabs.remove(id).catch(() => {})));
    const page = new URL(chrome.runtime.getURL('index.html'));
    if (typeof tab.id === 'number' && isX(tab.url)) page.searchParams.set('tab', String(tab.id));
    else page.searchParams.set('reason', 'open-from-x');
    const created = await chrome.windows.create({ url: page.href, type: 'popup', width: 1160, height: 820, focused: true });
    windowId = created?.id ?? null;
  });
  void opening.catch(() => {});
});
