import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowLeftRight, ArrowUpRight, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, ExternalLink, Globe2,
  Heart, LoaderCircle, Palette, Pause, Play, Plus, RefreshCw, RotateCcw, ScanLine, Search,
  ShieldCheck, SlidersHorizontal, Star, Trash2, UserMinus, Users, X,
} from 'lucide-react';
import type { Actions, AppState, Language, Row } from './types';
import type { ConnectionAccess, XTabChoice } from './adapter';
import { isAutoReady, isWhitelisted } from './engine';
import { languages, t } from './i18n';
import { ThemeManager } from './ThemeManager';
import { defaultThemes, loadThemes, saveThemes, type ThemeState } from './theme-store';
import { themeT } from './theme-i18n';
import { ThemeArtwork, WolfMark } from './ThemeArtwork';
import { avatarSources, immediateSetting, normalizeSetting, percent, rateLimitReset, readingEstimate } from './ui-helpers';
import './styles.css';
import './whitewolf.css';

const PAGE_SIZE = 12;
type Filter = 'all' | 'pending' | 'unfollowed' | 'uncertain';
type Confirmation = { type: 'auto' } | { type: 'clear' } | { type: 'unfollow'; row: Row } | null;
type Translate = (key: string, vars?: Record<string, string | number>) => string;

function isNonMutual(row: Row) {
  return row.relation.following === true && row.relation.followedBy === false;
}
const bareHandle = (handle: string) => handle.replace(/^@/, '');

function Modal({ children, title, onClose, closeLabel, tone = 'default', icon }: {
  children: ReactNode; title: string; onClose: () => void; closeLabel: string; tone?: 'default' | 'danger'; icon?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  return (
    <dialog ref={dialog} className={`confirm-dialog tone-${tone}`} onCancel={event => { event.preventDefault(); onClose(); }}
      aria-labelledby="confirm-title" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-body">
        <button type="button" className="icon-button dialog-close" onClick={onClose} aria-label={closeLabel}><X size={18} /></button>
        <div className="dialog-symbol">{icon ?? <ShieldCheck size={24} />}</div>
        <h2 id="confirm-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

/** Keeps a draft while typing; valid values apply at once, anything else is clamped on blur or Enter. */
function NumberSetting({ label, value, min, max, disabled, onCommit }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const next = normalizeSetting(draft, min, max, value);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <label><span>{label}</span>
    <input type="number" inputMode="numeric" min={min} max={max} step={1} value={draft} disabled={disabled}
      onChange={event => { setDraft(event.target.value); const next = immediateSetting(event.target.value, min, max); if (next !== null && next !== value) onCommit(next); }}
      onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
  </label>;
}

function Avatar({ row, label }: { row: Row; label: string }) {
  const sources = useMemo(() => avatarSources(row.avatar), [row.avatar]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setAttempt(0); }, [row.avatar]);
  const handle = bareHandle(row.handle);
  const source = sources[attempt];
  return <a className="person-avatar" href={`https://x.com/${encodeURIComponent(handle)}`} target="_blank" rel="noreferrer" aria-label={label}>
    {source ? <img key={source} src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setAttempt(value => value + 1)} /> : null}
    <span>{(row.name || row.handle).slice(0, 1).toUpperCase()}</span>
  </a>;
}

function ProgressTrack({ value, label }: { value: number; label: string }) {
  return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
    <span style={{ width: `${value}%` }} />
  </div>;
}

function SkeletonRows() {
  return <div className="skeleton-list" aria-hidden="true">
    {Array.from({ length: 4 }, (_, index) => <div className="skeleton-row" key={index}><i className="skeleton-avatar" /><span><i /><i /></span><i className="skeleton-action" /></div>)}
  </div>;
}

function Stat({ icon, label, value, language, testId, highlight, children }: {
  icon: ReactNode; label: string; value: number; language: Language; testId?: string; highlight?: boolean; children?: ReactNode;
}) {
  return <div className={`stat ${highlight ? 'stat-highlight' : ''}`}>
    <span className="stat-label"><span className="stat-icon">{icon}</span>{label}</span>
    <strong data-testid={testId}>{value.toLocaleString(language)}</strong>
    {children}
  </div>;
}

export default function App({ state, actions, connection }: { state: AppState; actions: Actions; connection?: ConnectionAccess }) {
  const { language, mode, intervalSeconds, batchLimit } = state.settings;
  const tr: Translate = (key, vars) => t(language, key, vars);
  const [themes, setThemes] = useState<ThemeState>(defaultThemes);
  const [themePreview, setThemePreview] = useState<ThemeState | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [themeReady, setThemeReady] = useState(false);
  const [themeError, setThemeError] = useState(false);
  const overviewHeading = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [previewAspectRatio, setPreviewAspectRatio] = useState(4);
  const activeThemes = themePreview || themes;
  const activeSkin = activeThemes.custom.find(skin => skin.id === activeThemes.active);
  const skinMode = activeThemes.active === 'wolf' ? 'wolf' : activeSkin ? 'custom' : 'minimal';
  useEffect(() => {
    if (!overviewHeading.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].target.getBoundingClientRect();
      if (rect.width && rect.height) setPreviewAspectRatio(rect.width / rect.height);
    });
    observer.observe(overviewHeading.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let current = true;
    void loadThemes().then(value => { if (current) { setThemes(value); setThemeReady(true); } }).catch(() => { if (current) setThemeError(true); });
    return () => { current = false; };
  }, []);
  const applyTheme = async (next: ThemeState) => {
    if (!themeReady) throw new Error('Themes must be loaded before saving.');
    try { await saveThemes(next, themes); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'THEME_CONFLICT') {
        try { setThemes(await loadThemes()); setThemePreview(null); }
        catch { setThemeReady(false); setThemeError(true); }
      }
      throw error;
    }
    setThemes(next); setThemeError(false); setThemePreview(null);
  };
  const retryThemes = async () => {
    setThemeError(false);
    try { setThemes(await loadThemes()); setThemeReady(true); }
    catch { setThemeReady(false); setThemeError(true); }
  };
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [whitelistInput, setWhitelistInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [tabChoices, setTabChoices] = useState<XTabChoice[]>([]);
  const [selectedTab, setSelectedTab] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const entryGeneration = useRef(0);
  const entryPending = useRef(false);
  const pausing = state.pausePending === true;
  const busy = entryBusy || adding || tabChoices.length > 0 || pausing || !!state.activeOperation || ['connecting', 'scanning', 'running'].includes(state.phase);
  const scanning = state.phase === 'scanning';
  const running = state.phase === 'running';
  const scanActive = state.activeOperation === 'scan' || scanning;
  const scanPaused = state.canResumeScan === true && !scanActive && !pausing;
  const autoActive = state.activeOperation === 'auto' || (!state.activeOperation && running && mode === 'auto');
  const operationActive = !!state.activeOperation || running;
  const protectedRow = (row: Row) => isWhitelisted(row, state.whitelist);
  const confirmed = state.rows.filter(row => isNonMutual(row) || row.outcome === 'unfollowed' || row.outcome === 'uncertain');
  const nonMutual = state.rows.filter(row => isNonMutual(row) && row.outcome !== 'unfollowed');
  const unknown = state.rows.filter(row => row.outcome !== 'unfollowed' && (row.relation.following === null || row.relation.followedBy === null));
  const uncertainRows = state.rows.filter(row => row.outcome === 'uncertain');
  const eligible = nonMutual.filter(row => row.outcome === 'pending' && !row.manualOnly && !protectedRow(row));
  const completed = state.rows.filter(row => row.outcome === 'unfollowed').length;
  const isAuthorAccount = state.account?.handle.replace(/^@/, '').toLowerCase() === 'magicalstocker';
  const autoReady = isAutoReady(state);
  const canReconnectPausedRun = state.phase === 'paused' && !state.error && !!state.account && autoReady;
  const canStart = (state.connected || canReconnectPausedRun) && autoReady && eligible.length > 0 && !busy && !scanPaused;
  const previewCount = Math.min(eligible.length, batchLimit);
  const share = percent(nonMutual.length, state.rows.length);

  const filtered = useMemo(() => {
    const query = search.trim().replace(/^@/, '').toLowerCase();
    return state.rows.filter(row => {
      if (!isNonMutual(row) && row.outcome !== 'unfollowed' && row.outcome !== 'uncertain') return false;
      if (filter === 'pending' && row.outcome !== 'pending') return false;
      if (filter === 'unfollowed' && row.outcome !== 'unfollowed') return false;
      if (filter === 'uncertain' && row.outcome !== 'uncertain') return false;
      return !query || row.handle.toLowerCase().includes(query) || row.name.toLowerCase().includes(query);
    });
  }, [state.rows, search, filter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [search, filter, mode]);
  useEffect(() => { if (confirmation?.type === 'auto' && running) setConfirmation(null); }, [confirmation, running]);
  useEffect(() => {
    const cancel = () => { ++entryGeneration.current; entryPending.current = false; connection?.cancel(); };
    window.addEventListener('pagehide', cancel);
    return () => { window.removeEventListener('pagehide', cancel); cancel(); };
  }, [connection]);
  // "/" focuses the account search unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')
        || (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))) return;
      event.preventDefault(); searchInput.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const displayedError = entryError || state.error;
  const resetAt = rateLimitReset(displayedError);
  const nextAt = state.runProgress?.nextAt ?? null;
  // A one-second clock only while a countdown is visible.
  useEffect(() => {
    if (!(nextAt && nextAt > Date.now()) && !(resetAt && resetAt > Date.now())) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nextAt, resetAt]);

  const connectFromClick = (forcePermission = false) => {
    if (entryPending.current) return;
    if (!connection) { void actions.connect(); return; }
    const generation = ++entryGeneration.current;
    entryPending.current = true;
    setEntryBusy(true); setEntryError(null); setTabChoices([]); setSelectedTab(null);
    // This call must stay synchronous in the user's click handler.
    const pending = connection.prepareConnection(forcePermission || /^(TAB_REQUIRED|TAB_PERMISSION):/.test(state.error || ''));
    void pending.then(async choices => {
      if (generation !== entryGeneration.current) return;
      if (choices.length === 1) { connection.selectTab(choices[0].id); await actions.connect(); }
      else { setTabChoices(choices); setSelectedTab(null); }
    }).catch(error => {
      if (generation === entryGeneration.current && !String(error).includes('CANCELLED:')) setEntryError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (generation === entryGeneration.current) { entryPending.current = false; setEntryBusy(false); }
    });
  };
  const cancelSelection = () => {
    ++entryGeneration.current; entryPending.current = false; connection?.cancel();
    setTabChoices([]); setSelectedTab(null); setEntryBusy(false);
  };
  const connectSelected = () => {
    if (!connection || selectedTab === null || entryPending.current) return;
    try { connection.selectTab(selectedTab); }
    catch (error) { setEntryError(error instanceof Error ? error.message : String(error)); cancelSelection(); return; }
    setTabChoices([]); setSelectedTab(null); setEntryError(null);
    void actions.connect();
  };
  const openX = () => {
    if (!connection) return;
    void connection.openX().catch(() => setEntryError('TAB_REQUIRED: Open https://x.com in a Chrome tab, then click Connect.'));
  };

  const submittedWhitelist = useRef<string | null>(null);
  const submitWhitelist = async (event: FormEvent) => {
    event.preventDefault();
    if (!whitelistInput.trim() || adding || busy) return;
    submittedWhitelist.current = whitelistInput.trim();
    setAdding(true);
    try { await actions.addWhitelist(whitelistInput.trim()); }
    finally { setAdding(false); }
  };
  // Clear the field only after a confirmed save; a failed lookup keeps the text for correction.
  useEffect(() => {
    if (adding || submittedWhitelist.current === null) return;
    const submitted = submittedWhitelist.current;
    submittedWhitelist.current = null;
    if (!state.error && state.message === 'statusWhitelistSaved') setWhitelistInput(current => current.trim() === submitted ? '' : current);
  }, [adding, state.error, state.message]);

  const phaseKey = pausing ? 'statusPausing' : scanPaused ? 'statusScanPaused' : state.connected && state.phase === 'idle' ? 'statusConnectedIdle' : `status${state.phase[0].toUpperCase()}${state.phase.slice(1)}`;
  const errorMessages: Record<string, string> = {
    AUTH: 'errorAuth', HTTP: 'errorHttp', API_UNAVAILABLE: 'errorApiUnavailable', RATE_LIMIT: 'errorRateLimit', RATE: 'errorRateLimit',
    TAB_REQUIRED: 'errorTabRequired', TAB_PERMISSION: 'errorTabPermission',
    ACCOUNT_CHANGED: 'errorAccountChanged', SCHEMA: 'errorSchema', NETWORK: 'errorNetwork',
    UNCERTAIN: 'errorUncertain', WORKER_RESTART: 'errorWorkerRestart', CANCELLED: 'errorCancelled',
    INCOMPLETE: 'errorIncomplete', WHITELIST: 'errorWhitelist', BUSY: 'errorBusy', NOT_CONNECTED: 'errorNotConnected', NOT_FOUND: 'errorNotFound',
  };
  const errorKey = errorMessages[displayedError?.split(':')[0] || ''] || 'error';
  const clock = (value: number, seconds = false) => new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(value);
  const formattedScanTime = state.scannedAt ? clock(state.scannedAt) : '';

  const showStatus = !!(state.scannedAt || scanActive || scanPaused || pausing || state.rows.length > 0);
  const verifying = state.checked > 0;
  const readCount = state.rows.length + (state.unavailableCount ?? 0);
  const followingCount = state.account?.followingCount;
  const progressValue = verifying ? percent(state.checked, state.rows.length) : readingEstimate(readCount, followingCount);
  const progressText = verifying ? `${state.checked.toLocaleString(language)} / ${state.rows.length.toLocaleString(language)}`
    : progressValue !== null && followingCount !== undefined ? tr('progressEstimate', { percent: progressValue, total: followingCount.toLocaleString(language) })
      : tr('scanningProgress', { pages: state.pages, checked: state.checked });
  const showProgress = scanActive || pausing || scanPaused;
  const runProgress = state.runProgress;
  const secondsLeft = nextAt ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : 0;
  const initial = (state.account?.name || state.account?.handle || '?').slice(0, 1).toUpperCase();

  return (
    <main className="app-shell" data-theme={skinMode} dir={language === 'ar' ? 'rtl' : 'ltr'}>
      <header className="app-header">
        <div className="brand">
          <WolfMark />
          <div className="brand-text"><strong dir="ltr">WhiteWolf</strong><span className="brand-caption">{themeT(language, 'brandDescriptor')}</span></div>
          <span className="free-badge">{tr('free')}</span>
        </div>
      <section className={`connection-card ${state.connected ? 'is-connected' : ''}`}>
        <div className="connection-avatar" aria-hidden="true">{state.account ? <span className="connection-initial">{initial}</span> : <Users size={20} />}{state.connected && <i className={`presence ${operationActive || pausing ? 'is-busy' : ''}`} />}</div>
        <div className="connection-copy">
          <span className="eyebrow">{tr(state.connected ? 'connectedAs' : 'connect')}</span>
          <strong dir={state.account ? 'ltr' : undefined}>{state.account ? `@${bareHandle(state.account.handle)}` : tr('connectionHint')}</strong>
        </div>
        {state.connected ? <span className="connected-indicator" data-busy={operationActive || pausing || undefined}><span />{tr(phaseKey)}</span> :
          <button className="button button-primary button-small" onClick={() => connectFromClick()} disabled={busy}>
            {entryBusy || state.phase === 'connecting' ? <LoaderCircle className="spin" size={15} /> : <ArrowUpRight size={15} />}
            {tr(entryBusy || state.phase === 'connecting' ? 'connecting' : 'connect')}
          </button>}
      </section>
        <div className="header-tools"><button className="button button-neutral appearance-button" aria-label={themeT(language, 'appearance')} onClick={() => setThemeOpen(true)} disabled={!themeReady || busy}><Palette size={18} /><span>{themeT(language, 'appearance')}</span></button>
        <div className="language-picker"><Globe2 size={15} aria-hidden="true" />
          <select value={language} onChange={event => actions.setLanguage(event.target.value as Language)} aria-label={tr('language')}>
            {languages.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
          </select><ChevronDown size={12} aria-hidden="true" />
        </div></div>
      </header>

      {themeError && <div className="theme-load-error" role="status"><span>{themeT(language, 'errorStorage')}</span><button className="button button-neutral button-small" onClick={() => void retryThemes()}>{themeT(language, 'retry')}</button></div>}

      {!state.connected && connection && !scanPaused && !state.activeOperation && !pausing && <div className="connection-help"><span className="help-icon"><ShieldCheck size={18} /></span><p>{tr('accessHint')}</p><button className="button button-neutral button-small" onClick={openX} disabled={entryBusy}><ExternalLink size={15} />{tr('openX')}</button></div>}

      {state.demo && <div className="demo-banner"><ScanLine size={15} /><span>{tr('demoBanner')}</span></div>}

      <section className="overview-section" aria-labelledby="overview-title">
        <div className="section-heading" ref={overviewHeading}><ThemeArtwork mode={skinMode} skin={activeSkin} />
          <div className="overview-title"><h1 id="overview-title">{tr('workspaceTitle')}</h1>
            {showStatus ? <div className={`scan-status ${!state.complete ? 'scan-incomplete' : ''}`} aria-live="polite">
              {scanActive || pausing ? <LoaderCircle className="spin" size={14} /> : scanPaused ? <Pause size={14} /> : state.complete ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
              <span data-testid="scan-progress" data-phase={state.phase} data-complete={state.complete} data-auto-ready={autoReady} data-pages={state.pages} data-checked={state.checked} data-paused={scanPaused}>{pausing ? tr('pausing') : scanPaused ? tr('scanPausedProgress', { pages: state.pages, checked: state.checked }) : scanActive ? tr('scanningProgress', { pages: state.pages, checked: state.checked }) : tr(state.complete ? 'completeScan' : state.scannedAt && (state.unavailableCount ?? 0) > 0 ? 'scanFinishedPartial' : 'incompleteScan')}</span>
              {state.scannedAt && !scanning && <time>{tr('scanTime', { time: formattedScanTime })}</time>}
            </div> : <p className="overview-description">{tr('workspaceDescription')}</p>}
          </div>
          {scanActive ? <button className="button button-dark button-pause" data-testid="scan-pause" onClick={() => actions.pause()} disabled={pausing}>
            {pausing ? <LoaderCircle className="spin" size={16} /> : <Pause size={17} />}{tr(pausing ? 'pausing' : 'pauseScan')}
          </button> : operationActive || pausing ? <button className="button button-dark button-pause" data-testid="operation-pause" onClick={() => actions.pause()} disabled={pausing}>
            {pausing ? <LoaderCircle className="spin" size={16} /> : <Pause size={17} />}{tr(pausing ? 'pausing' : autoActive ? 'pauseAuto' : 'pause')}
          </button> : scanPaused ? <button className="button button-dark" data-testid="scan-resume" onClick={() => void actions.resumeScan()} disabled={busy}>
            <Play size={16} />{tr('resumeScan')}
          </button> : <button className="button button-dark" data-testid="scan-start" onClick={() => void actions.scan()} disabled={!state.connected || busy}>
            {state.scannedAt ? <RefreshCw size={15} /> : <ScanLine size={17} />}{tr(state.scannedAt ? 'scanAgain' : 'scan')}
          </button>}
        </div>
        {showProgress && <div className="scan-meter" data-state={scanActive ? 'active' : 'paused'}>
          <div className="scan-meter-head"><span>{tr(verifying ? 'scanPhaseVerifying' : 'scanPhaseReading')}</span><span dir="auto">{progressText}</span></div>
          {progressValue !== null && <ProgressTrack value={progressValue} label={tr(verifying ? 'scanPhaseVerifying' : 'scanPhaseReading')} />}
          {scanActive && connection && <p className="scan-tip">{tr('scanTip')}</p>}
        </div>}
        <div className="stats-grid">
          <Stat language={language} icon={<Users size={16} />} label={tr('following')} value={state.rows.length} testId="scan-total" />
          <Stat language={language} icon={<CheckCircle2 size={16} />} label={tr('checked')} value={state.checked} testId="scan-checked">
            <div className="stat-bar"><span style={{ width: `${state.rows.length ? Math.min(100, state.checked / state.rows.length * 100) : 0}%` }} /></div>
          </Stat>
          <Stat language={language} icon={<UserMinus size={16} />} label={tr('nonMutual')} value={nonMutual.length} highlight>
            {share !== null && <><span className="stat-ring" style={{ '--ratio': `${share}%` } as CSSProperties} aria-hidden="true" /><span className="stat-foot">{tr('shareOfFollowing', { percent: share })}</span></>}
          </Stat>
          <Stat language={language} icon={<AlertCircle size={16} />} label={tr('unknown')} value={unknown.length} />
        </div>
        {(state.unavailableCount ?? 0) > 0 && <p className="scan-status scan-incomplete unavailable-note" data-testid="scan-unavailable" role="status"><AlertCircle size={16} /><span>{tr('unavailableHelp', { count: state.unavailableCount! })}</span></p>}
        {scanPaused && <div className="scan-paused-note"><p>{tr(state.error ? 'scanInterruptedHint' : 'scanPausedHint')}</p><button className="button button-neutral button-small" data-testid="scan-restart" onClick={() => void actions.scan()} disabled={busy}><RefreshCw size={15} />{tr('restartScan')}</button></div>}
      </section>

      {displayedError && <section className="error-panel" role="alert"><span className="error-icon"><AlertCircle size={18} /></span><div><strong>{tr(errorKey)}</strong>
        {resetAt !== null && resetAt > now && <p className="error-extra"><Clock3 size={15} />{tr('rateLimitUntil', { time: clock(resetAt), minutes: Math.max(1, Math.ceil((resetAt - now) / 60_000)) })}</p>}
        <details open={/^(API_UNAVAILABLE|SCHEMA):/.test(displayedError)}><summary>{tr('diagnosticDetails')}</summary><code>{displayedError}</code></details></div></section>}

      <div className="workspace-heading"><div className="mode-tabs" role="tablist" aria-label={tr('automatic')} data-mode={mode}
        onKeyDown={event => { if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !busy) { event.preventDefault(); const next = mode === 'manual' ? 'auto' : 'manual'; actions.setMode(next); document.getElementById(`tab-${next}`)?.focus(); } }}>
        <button id="tab-manual" role="tab" aria-selected={mode === 'manual'} aria-controls="mode-panel" tabIndex={mode === 'manual' ? 0 : -1} className={mode === 'manual' ? 'active' : ''} onClick={() => actions.setMode('manual')} disabled={busy}><UserMinus size={16} />{tr('manual')}</button>
        <button id="tab-auto" role="tab" aria-selected={mode === 'auto'} aria-controls="mode-panel" tabIndex={mode === 'auto' ? 0 : -1} className={mode === 'auto' ? 'active' : ''} onClick={() => actions.setMode('auto')} disabled={busy}><SlidersHorizontal size={16} />{tr('automatic')}</button>
      </div><button className="button button-neutral export-button" onClick={() => actions.exportCsv()} disabled={!state.rows.length}><Download size={18} />{tr('exportCsv')}</button></div>

      <section id="mode-panel" role="tabpanel" aria-labelledby={mode === 'manual' ? 'tab-manual' : 'tab-auto'} className="mode-panel">
        {mode === 'auto' && <p className="mode-description"><AlertCircle size={16} /><span>{tr('autoDescription')}</span></p>}
        <div className={`workspace-grid ${mode === 'auto' ? 'with-sidebar' : ''}`}>
        {mode === 'auto' && <div className="auto-layout">
          <section className="whitelist-card">
            <div className="card-heading"><span><ShieldCheck size={16} />{tr('whitelist')}</span><span className="count-badge">{state.whitelist.length}</span></div>
            <p>{tr('whitelistDescription')}</p>
            <form className="whitelist-form" onSubmit={event => void submitWhitelist(event)}>
              <input value={whitelistInput} onChange={event => setWhitelistInput(event.target.value)} placeholder={tr('whitelistPlaceholder')} aria-label={tr('whitelistPlaceholder')} disabled={busy} autoComplete="off" spellCheck={false} />
              <button className="button button-soft button-small" type="submit" disabled={!whitelistInput.trim() || busy}>{adding ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{tr('add')}</button>
            </form>
            <div className="whitelist-chips">{state.whitelist.length ? state.whitelist.map(entry => <span className="whitelist-chip" key={entry.id || entry.handle}><Star size={11} fill="currentColor" />@{bareHandle(entry.handle)}<button className="chip-remove" onClick={() => actions.removeWhitelist(entry.handle)} disabled={busy} aria-label={`${tr('removeWhitelist')} @${bareHandle(entry.handle)}`}><X size={12} /></button></span>) : <span className="empty-whitelist">{tr('whitelistEmpty')}</span>}</div>
          </section>
          <section className="pacing-card">
            <div className="card-heading"><span><SlidersHorizontal size={18} />{tr('pacingTitle')}</span></div>
            <div className="pacing-fields">
              <NumberSetting label={tr('intervalSeconds')} value={intervalSeconds} min={5} max={300} disabled={busy} onCommit={value => actions.setPacing(value, batchLimit)} />
              <NumberSetting label={tr('batchLimit')} value={batchLimit} min={1} max={200} disabled={busy} onCommit={value => actions.setPacing(intervalSeconds, value)} />
            </div>
            <p>{tr('pacingHint')}</p>
            <div className="auto-control"><div className={`auto-readiness ${canStart || running ? 'ready' : ''}`}><span />{tr(canStart || running ? 'autoReady' : 'autoBlocked')}<small>{tr('selectedCount', { count: previewCount })}</small></div>
              {runProgress && runProgress.total > 0 && <div className="run-progress" role="status">
                <div className="run-progress-head"><span>{tr('runProgress', { done: runProgress.processed, total: runProgress.total })}</span>{nextAt && secondsLeft > 0 && <span className="run-next"><Clock3 size={14} />{tr('nextIn', { seconds: secondsLeft })}</span>}</div>
                <ProgressTrack value={percent(runProgress.processed, runProgress.total) ?? 0} label={tr('runProgress', { done: runProgress.processed, total: runProgress.total })} />
              </div>}
              {autoActive ? <button className="button button-dark button-pause" onClick={() => actions.pause()} disabled={pausing}>{pausing ? <LoaderCircle size={15} className="spin" /> : <Pause size={15} />}{tr(pausing ? 'pausing' : 'pauseAuto')}</button> : <button className="button button-primary" disabled={!canStart} onClick={() => setConfirmation({ type: 'auto' })}><Play size={14} fill="currentColor" />{tr(state.phase === 'paused' && !scanPaused ? 'resume' : 'previewAuto')}</button>}
            </div>
          </section>
        </div>}

        <section className="results-panel" aria-labelledby="results-title">
        <div className="results-heading"><div><h2 id="results-title">{tr('resultsTitle')}<span className="count-badge">{confirmed.length}</span></h2><p>{tr(mode === 'manual' ? 'manualDescription' : 'listDescription')}</p></div></div>
        {uncertainRows.length > 0 && <div className="uncertain-notice" role="status"><AlertCircle size={17} /><div><button className="uncertain-count" onClick={() => { setFilter('uncertain'); setSearch(''); }}>{tr('uncertainCount', { count: uncertainRows.length })}</button><p>{tr('uncertainHelp')}</p></div></div>}

        <div className="list-toolbar"><div className="search-box"><Search size={16} /><input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={tr('searchPlaceholder')} aria-label={tr('searchPlaceholder')} aria-keyshortcuts="/" /><kbd aria-hidden="true">/</kbd></div>
          <div className="filter-select"><select value={filter} onChange={event => setFilter(event.target.value as Filter)} aria-label={tr('allResults')}><option value="all">{tr('allResults')}</option><option value="pending">{tr('pending')}</option><option value="unfollowed">{tr('unfollowed')}</option><option value="uncertain">{tr('uncertain')}</option></select><ChevronDown size={13} /></div>
        </div>

        <div className="results-list" aria-busy={scanning}>
          {visibleRows.length ? visibleRows.map(row => {
            const white = protectedRow(row);
            const active = state.currentId === row.id;
            const done = row.outcome === 'unfollowed';
            const uncertain = row.outcome === 'uncertain';
            const handle = bareHandle(row.handle);
            const actionable = isNonMutual(row) && row.outcome === 'pending' && state.connected && !busy && !scanPaused && !active;
            // Recheck only reads; like Resume scan, it reconnects to the selected tab itself.
            const recheckable = uncertain && !busy && !scanPaused && !active;
            return <article className={`person-row ${done ? 'person-done' : ''} ${uncertain ? 'person-uncertain' : ''} ${active ? 'person-active' : ''} ${white && mode === 'auto' ? 'person-protected' : ''}`} key={row.id}>
              <Avatar row={row} label={`${tr('profile')} @${handle}`} />
              <div className="person-copy"><div className="person-name"><a href={`https://x.com/${encodeURIComponent(handle)}`} target="_blank" rel="noreferrer"><span>{row.name || row.handle}</span><ExternalLink size={14} /></a>{white && mode === 'auto' && <span className="protected-mark" title={tr('whitelisted')}><ShieldCheck size={17} /></span>}</div><span className="person-handle" dir="ltr">@{handle}</span></div>
              {mode === 'manual' && !done && !uncertain && <span className="relationship-badge">{tr('notFollowingBack')}</span>}
              <div className="row-actions">
                {mode === 'auto' && !done && !uncertain && <button className={`icon-button star-button ${white ? 'is-starred' : ''}`} onClick={() => actions.toggleWhitelist(row.id)} disabled={busy} aria-label={`${tr(white ? 'removeWhitelist' : 'addWhitelist')} @${handle}`} title={tr(white ? 'removeWhitelist' : 'addWhitelist')}><Star size={16} fill={white ? 'currentColor' : 'none'} /></button>}
                {done ? <span className="row-status success"><Check size={14} />{tr('unfollowed')}</span> : uncertain ? <><span className="row-status uncertain"><AlertCircle size={13} />{tr('uncertain')}</span>
                  <button className="button button-recheck" disabled={!recheckable} onClick={() => void actions.recheck(row.id)}>{active ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}{tr(active ? 'rechecking' : 'recheck')}</button></> : row.outcome === 'skipped' ? <span className="row-status">{tr('skip')}</span> :
                  <button className="button button-unfollow" disabled={!actionable} onClick={() => setConfirmation({ type: 'unfollow', row })}>{active ? <LoaderCircle size={13} className="spin" /> : <UserMinus size={13} />}{tr(active ? 'unfollowing' : 'unfollow')}</button>}
              </div>
            </article>;
          }) : scanActive && !confirmed.length ? <><SkeletonRows /><p className="skeleton-caption" role="status"><LoaderCircle size={15} className="spin" />{tr(verifying ? 'scanPhaseVerifying' : 'scanPhaseReading')}</p></>
            : <div className="empty-state"><span className="empty-icon">{scanPaused ? <Pause size={28} /> : confirmed.length ? <Search size={27} /> : state.scannedAt ? <CheckCircle2 size={28} /> : <ArrowLeftRight size={28} />}</span><h2>{tr(scanPaused ? 'statusScanPaused' : scanActive ? 'scanning' : state.scannedAt || confirmed.length ? 'noResults' : 'emptyTitle')}</h2><p>{tr(scanPaused ? 'scanPausedHint' : scanActive ? 'scanningProgress' : state.scannedAt ? state.complete ? 'completeScan' : 'unknownHelp' : 'emptyDescription', { pages: state.pages, checked: state.checked })}</p>{!state.scannedAt && !scanActive && !scanPaused && <button className="button button-soft button-small" disabled={!state.connected || busy} onClick={() => void actions.scan()}><ScanLine size={14} />{tr('startScan')}</button>}</div>}
        </div>

        {filtered.length > 0 && <div className="pagination"><span>{tr('pagination', { from: (safePage - 1) * PAGE_SIZE + 1, to: Math.min(safePage * PAGE_SIZE, filtered.length), total: filtered.length })}</span><div><button className="icon-button" onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage === 1} aria-label={tr('previous')}><ChevronLeft size={17} /></button><span className="page-number">{safePage} <span>/ {totalPages}</span></span><button className="icon-button" onClick={() => setPage(Math.min(totalPages, safePage + 1))} disabled={safePage === totalPages} aria-label={tr('next')}><ChevronRight size={17} /></button></div></div>}

        {unknown.length > 0 && !scanActive && <div className="unknown-note"><AlertCircle size={14} /><span>{tr('unknownHelp')}</span></div>}
        {state.message && <p className="engine-message" aria-live="polite"><span />{tr(state.message)}</p>}
        </section>
        </div>
      </section>

      <section className="utilities">
        <details className="activity-panel"><summary><span><Activity size={15} />{tr('activity')}<span className="count-badge">{state.logs.length}</span></span><ChevronDown size={14} /></summary>
          <div className="activity-content"><div className="activity-toolbar"><span>{tr('completedCount', { count: completed })}</span><button className="text-button" onClick={() => actions.exportCsv()} disabled={!state.rows.length}><Download size={13} />{tr('exportCsv')}</button></div>
            {state.logs.length ? <div className="audit-scroll"><table className="audit-table"><thead><tr><th>{tr('logsTime')}</th><th>{tr('logsAccount')}</th><th>{tr('logsAction')}</th><th>{tr('logsResult')}</th></tr></thead><tbody>{state.logs.slice().reverse().slice(0, 100).map((entry, index) => <tr key={`${entry.at}-${entry.targetId}-${index}`}><td>{clock(Date.parse(entry.at), true)}</td><td dir="ltr">@{bareHandle(entry.handle)}</td><td>{tr(entry.action === 'unfollow' ? 'unfollow' : 'followAuthor')}</td><td><span className={`log-result result-${entry.result}`}>{tr(entry.result)}</span></td></tr>)}</tbody></table></div> : <p className="no-activity">{tr('noActivity')}</p>}
          </div>
        </details>
        <button className="clear-data text-button" onClick={() => setConfirmation({ type: 'clear' })} disabled={busy}><Trash2 size={13} />{tr('clearData')}</button>
      </section>

      <footer className="app-footer"><div className="author-credit"><span className="author-avatar">M<span /></span><div><span className="author-label">{tr('authorBy')}</span><a href="https://x.com/MagicalStocker" target="_blank" rel="noreferrer" dir="ltr">@MagicalStocker<ArrowUpRight size={12} /></a></div></div>
        <button className={`button button-author ${state.authorFollowed || isAuthorAccount ? 'author-followed' : ''}`} onClick={() => void actions.followAuthor()} disabled={!state.connected || state.authorFollowed || isAuthorAccount || busy || scanPaused}>{state.authorFollowed || isAuthorAccount ? <Check size={14} /> : <Heart size={14} />}{tr(isAuthorAccount ? 'authorSelf' : state.authorFollowed ? 'authorFollowed' : 'followAuthor')}</button>
        <p className="footer-note">{tr('freeFooter')}<span className="footer-version" dir="ltr">WhiteWolf · v1.3</span></p>
      </footer>

      {tabChoices.length > 0 && <Modal title={tr('chooseXTab')} onClose={cancelSelection} closeLabel={tr('close')}>
        <p>{tr('chooseXTabHint')}</p>
        <div className="tab-choice-list" role="radiogroup" aria-label={tr('chooseXTab')}>
          {tabChoices.map(tab => <label className={`tab-choice ${selectedTab === tab.id ? 'selected' : ''}`} key={tab.id}>
            <input type="radio" name="x-tab" checked={selectedTab === tab.id} onChange={() => setSelectedTab(tab.id)} />
            <span><strong>{tab.title || tr('tabTitleFallback')}</strong><small dir="ltr">{tab.url}</small></span>
          </label>)}
        </div>
        <div className="dialog-actions"><button className="button button-neutral" onClick={() => connectFromClick(true)}>{tr('refreshTabs')}</button><button className="button button-primary" disabled={selectedTab === null} onClick={connectSelected}>{tr('connectSelected')}</button></div>
      </Modal>}
      {confirmation && <Modal title={tr(confirmation.type === 'auto' ? 'previewTitle' : confirmation.type === 'clear' ? 'clearTitle' : 'manualConfirmTitle')} onClose={() => setConfirmation(null)} closeLabel={tr('close')} tone={confirmation.type === 'auto' ? 'default' : 'danger'}
        icon={confirmation.type === 'clear' ? <Trash2 size={24} /> : confirmation.type === 'unfollow' ? <UserMinus size={24} /> : undefined}>
        {confirmation.type === 'auto' ? <><p>{tr('previewDescription', { count: previewCount })}</p><div className="preview-stat"><span>{tr('selectedCount', { count: previewCount })}</span><strong>{previewCount}</strong></div><p className="dialog-hint"><Clock3 size={14} />{tr('previewDetails', { interval: intervalSeconds, limit: batchLimit })}</p><p className="dialog-hint"><ShieldCheck size={14} />{tr('blockedUnknown')}</p><div className="dialog-actions"><button className="button button-neutral" onClick={() => setConfirmation(null)}>{tr('cancel')}</button><button className="button button-primary" disabled={!canStart} onClick={() => { setConfirmation(null); void actions.startAuto(); }}><Play size={14} />{tr('confirmStart')}</button></div></> :
          confirmation.type === 'clear' ? <><p>{tr('clearDescription')}</p><div className="dialog-actions"><button className="button button-neutral" onClick={() => setConfirmation(null)}>{tr('cancel')}</button><button className="button button-danger" onClick={() => { setConfirmation(null); void actions.clearLocalData(); }}><Trash2 size={14} />{tr('confirmClear')}</button></div></> :
            <><p>{tr('manualConfirmDescription', { handle: bareHandle(confirmation.row.handle) })}</p><div className="dialog-actions"><button className="button button-neutral" onClick={() => setConfirmation(null)}>{tr('cancel')}</button><button className="button button-danger" disabled={busy || scanPaused || !state.connected || !state.rows.some(row => row.id === confirmation.row.id && isNonMutual(row) && row.outcome === 'pending')} onClick={() => { const id = confirmation.row.id; setConfirmation(null); void actions.unfollow(id); }}><UserMinus size={14} />{tr('confirmUnfollow')}</button></div></>}
      </Modal>}
      {themeOpen && <ThemeManager language={language} state={themes} onChange={applyTheme} onPreview={setThemePreview} previewAspectRatio={previewAspectRatio} onClose={() => { setThemePreview(null); setThemeOpen(false); }} />}
    </main>
  );
}
