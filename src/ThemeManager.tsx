import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Check, ChevronRight, ImagePlus, LoaderCircle, Move, Palette, Plus, RotateCcw, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { Language } from './types';
import { MAX_CUSTOM_SKINS, type CustomSkin, type ThemeState } from './theme-store';
import { computeCover, prepareThemeImage, suggestImageFocalPoint } from './theme-image';
import { themeT, type ThemeMessageKey } from './theme-i18n';
import './theme-manager.css';

export interface ThemeManagerProps {
  language: Language;
  state: ThemeState;
  onChange: (next: ThemeState) => Promise<void>;
  onPreview?: (draft: ThemeState | null) => void;
  onClose: () => void;
  previewAspectRatio?: number;
}

const WOLF_IMAGE = 'themes/whitewolf-mascot.png';
const MAX_NAME = 40;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const copySkin = (skin: CustomSkin | undefined): CustomSkin | null => skin ? { ...skin } : null;

/** Drafts only leave this component through preview; persistence is owned by the caller. */
export function ThemeManager({ language, state, onChange, onPreview, onClose, previewAspectRatio = 4 }: ThemeManagerProps) {
  const tr = (key: ThemeMessageKey, vars?: Record<string, string | number>) => themeT(language, key, vars);
  const titleId = useId(), descriptionId = useId(), nameId = useId(), hintId = useId();
  const dialog = useRef<HTMLDialogElement>(null), fileInput = useRef<HTMLInputElement>(null), preview = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), callbacks = useRef({ onPreview, onClose });
  callbacks.current = { onPreview, onClose };
  const [selection, setSelection] = useState(state.active);
  const [skin, setSkin] = useState<CustomSkin | null>(() => copySkin(state.custom.find(item => item.id === state.active)));
  const [busy, setBusy] = useState<'upload' | 'crop' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [size, setSize] = useState({ width: 600, height: 150 });
  const [dragging, setDragging] = useState(false);
  const uploadMode = useRef<'new' | 'replace'>('new');
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number; overflowX: number; overflowY: number } | null>(null);
  const isCustom = skin !== null && skin.id === selection;
  const savedSkin = state.custom.find(item => item.id === selection);
  const isNew = isCustom && !savedSkin;
  const atLimit = state.custom.length >= MAX_CUSTOM_SKINS;
  const changed = selection !== state.active || !!(isCustom && (!savedSkin || Object.keys(skin).some(key => skin[key as keyof CustomSkin] !== savedSkin[key as keyof CustomSkin])));
  const aspect = Number.isFinite(previewAspectRatio) && previewAspectRatio > 0 ? previewAspectRatio : 4;
  const cover = isCustom ? computeCover(skin.width, skin.height, size.width, size.height, skin.x, skin.y, skin.zoom) : null;

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      mounted.current = false;
      callbacks.current.onPreview?.(null);
      if (element?.open) element.close();
    };
  }, []);

  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    const update = () => { const rect = element.getBoundingClientRect(); if (rect.width && rect.height) setSize({ width: rect.width, height: rect.height }); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const workingState = (active: string, edited: CustomSkin | null): ThemeState => {
    if (!edited || edited.id !== active) return { active, custom: state.custom.map(item => ({ ...item })) };
    const exists = state.custom.some(item => item.id === edited.id);
    return { active, custom: exists ? state.custom.map(item => item.id === edited.id ? { ...edited } : { ...item }) : [...state.custom.map(item => ({ ...item })), { ...edited }] };
  };

  const choose = (id: string) => {
    if (busy) return;
    const next = copySkin(state.custom.find(item => item.id === id));
    setSelection(id); setSkin(next); setError(null); setConfirmDelete(false);
    onPreview?.(workingState(id, next));
  };
  const updateSkin = (patch: Partial<CustomSkin>) => {
    if (!skin || busy) return;
    const next = { ...skin, ...patch };
    setSkin(next); setError(null); setConfirmDelete(false);
    onPreview?.(workingState(selection, next));
  };
  const close = () => {
    if (busy) return;
    callbacks.current.onPreview?.(null);
    callbacks.current.onClose();
  };
  const displayError = (caught: unknown, saving = false) => {
    const code = caught && typeof caught === 'object' && 'code' in caught ? String(caught.code) : '';
    if (code === 'THEME_CONFLICT') return tr('errorConflict');
    if (code === 'THEME_LIMIT') return tr('errorMaxThemes', { max: MAX_CUSTOM_SKINS });
    if (code === 'THEME_IMAGE_TYPE') return tr('errorFileType', { formats: 'JPEG / PNG / WebP' });
    if (code === 'THEME_IMAGE_SIZE') return tr('errorFileSize', { max: '12 MiB' });
    if (code.startsWith('THEME_IMAGE_')) return tr('errorImageLoad');
    if (saving || code.startsWith('THEME_STORAGE_')) return tr('errorStorage');
    return tr('errorGeneric');
  };

  const openUpload = (mode: 'new' | 'replace') => {
    if (busy) return;
    if (mode === 'new' && atLimit) { setError(tr('errorMaxThemes', { max: MAX_CUSTOM_SKINS })); return; }
    uploadMode.current = mode;
    fileInput.current?.click();
  };
  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    const replacing = uploadMode.current === 'replace' && skin !== null;
    if (!replacing && atLimit) { setError(tr('errorMaxThemes', { max: MAX_CUSTOM_SKINS })); return; }
    setBusy('upload'); setError(null); setConfirmDelete(false);
    try {
      const image = await prepareThemeImage(file);
      if (!mounted.current) return;
      const next = { ...image, name: (replacing ? skin!.name : image.name).slice(0, MAX_NAME), ...(replacing ? { id: skin!.id } : {}) };
      setSkin(next); setSelection(next.id);
      onPreview?.(workingState(next.id, next));
    } catch (caught) { if (mounted.current) setError(displayError(caught)); }
    finally { if (mounted.current) setBusy(null); }
  };
  const autoCrop = async (reset = false) => {
    if (!skin || busy) return;
    setBusy('crop'); setError(null);
    try {
      const focal = await suggestImageFocalPoint(skin.dataUrl);
      if (!mounted.current) return;
      const next = { ...skin, ...focal, ...(reset ? { zoom: 1, opacity: 60 } : {}) };
      setSkin(next); onPreview?.(workingState(selection, next));
    } catch (caught) { if (mounted.current) setError(displayError(caught)); }
    finally { if (mounted.current) setBusy(null); }
  };
  const save = async (asNew = false) => {
    if (busy) return;
    let edited = skin;
    if (isCustom) {
      const name = skin.name.trim();
      if (!name) { setError(tr('errorNameRequired')); document.getElementById(nameId)?.focus(); return; }
      if (name.length > MAX_NAME) { setError(tr('errorNameTooLong', { max: MAX_NAME })); return; }
      if ((asNew || isNew) && atLimit) { setError(tr('errorMaxThemes', { max: MAX_CUSTOM_SKINS })); return; }
      edited = { ...skin, name, ...(asNew ? { id: `custom-${crypto.randomUUID()}` } : {}) };
    }
    const next = workingState(edited?.id ?? selection, edited);
    setBusy('save'); setError(null);
    try {
      await onChange(next);
      if (!mounted.current) return;
      onPreview?.(null); onClose();
    } catch (caught) { if (mounted.current) setError(displayError(caught, true)); }
    finally { if (mounted.current) setBusy(null); }
  };
  const deleteSkin = async () => {
    if (!savedSkin || busy) return;
    const next: ThemeState = { active: state.active === selection ? 'minimal' : state.active, custom: state.custom.filter(item => item.id !== selection).map(item => ({ ...item })) };
    setBusy('save'); setError(null);
    try {
      await onChange(next);
      if (!mounted.current) return;
      setSelection(next.active); setSkin(copySkin(next.custom.find(item => item.id === next.active))); setConfirmDelete(false);
      onPreview?.(null);
    } catch (caught) { if (mounted.current) setError(displayError(caught, true)); }
    finally { if (mounted.current) setBusy(null); }
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!isCustom || busy || !cover || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: skin.x, y: skin.y, overflowX: cover.width - size.width, overflowY: cover.height - size.height };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    updateSkin({
      x: current.overflowX > 0.5 ? clamp(current.x - (event.clientX - current.startX) / current.overflowX * 100, 0, 100) : current.x,
      y: current.overflowY > 0.5 ? clamp(current.y - (event.clientY - current.startY) / current.overflowY * 100, 0, 100) : current.y,
    });
  };
  const endDrag = () => { drag.current = null; setDragging(false); };
  const slider = (key: 'x' | 'y' | 'zoom' | 'opacity', label: ThemeMessageKey, min: number, max: number, step: number, format: (value: number) => string) => skin && (
    <label className="tm-slider" htmlFor={`${nameId}-${key}`}>
      <span>{tr(label)}<output htmlFor={`${nameId}-${key}`} dir="ltr">{format(skin[key])}</output></span>
      <input id={`${nameId}-${key}`} data-testid={`theme-${key}`} type="range" min={min} max={max} step={step} value={skin[key]} dir="ltr" disabled={!!busy}
        onChange={event => updateSkin({ [key]: Number(event.target.value) })} />
    </label>
  );
  const currentName = isCustom ? skin.name || tr('newTheme') : tr(selection === 'wolf' ? 'wolf' : 'minimal');

  return <dialog className="tm-dialog" data-testid="theme-dialog" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} dir={language === 'ar' ? 'rtl' : 'ltr'}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="tm-shell">
      <header className="tm-header">
        <span className="tm-header-symbol"><Palette size={22} /></span>
        <div><h2 id={titleId}>{tr('appearance')}</h2><p id={descriptionId}>{tr('themeIntro')}</p></div>
        <button type="button" className="tm-icon-button tm-close" data-testid="theme-close" aria-label={tr('close')} onClick={close} disabled={!!busy}><X size={20} /></button>
      </header>
      <div className="tm-body">
        <aside className="tm-library" aria-label={tr('presets')}>
          <span className="tm-section-label">{tr('presets')}</span>
          <div className="tm-presets">
            {(['minimal', 'wolf'] as const).map(id => <button type="button" key={id} data-testid={`theme-preset-${id}`} className={`tm-preset ${selection === id ? 'is-selected' : ''}`}
              aria-pressed={selection === id} onClick={() => choose(id)} disabled={!!busy}>
              <span className={`tm-preset-art tm-preset-art-${id}`} aria-hidden="true">{id === 'wolf' ? <img src={WOLF_IMAGE} alt="" /> : <><i /><i /><i /></>}</span>
              <span className="tm-preset-copy"><strong>{tr(id)}</strong><small>{tr(id === 'wolf' ? 'wolfDescription' : 'minimalDescription')}</small></span>
              <span className="tm-radio-mark" aria-hidden="true">{selection === id && <Check size={13} />}</span>
            </button>)}
            <button type="button" data-testid="theme-custom" className={`tm-preset tm-preset-custom ${isCustom ? 'is-selected' : ''}`} aria-pressed={isCustom}
              disabled={!!busy} onClick={() => openUpload('new')}>
              <span className="tm-preset-art tm-preset-art-custom" aria-hidden="true"><ImagePlus size={25} /></span>
              <span className="tm-preset-copy"><strong>{tr('custom')}</strong><small>{tr('customDescription')}</small></span><Plus size={15} />
            </button>
          </div>
          <div className="tm-saved-heading"><span className="tm-section-label">{tr('savedThemes')}</span><span>{tr('savedCount', { count: state.custom.length, max: MAX_CUSTOM_SKINS })}</span></div>
          <div className="tm-saved-list">
            {state.custom.map(item => <button key={item.id} type="button" data-testid="theme-saved-item" data-skin-id={item.id} className={`tm-saved-item ${selection === item.id ? 'is-selected' : ''}`}
              aria-pressed={selection === item.id} onClick={() => choose(item.id)} disabled={!!busy}>
              <img src={item.dataUrl} alt="" style={{ objectPosition: `${item.x}% ${item.y}%` }} />
              <span><strong>{item.name}</strong>{state.active === item.id && <small>{tr('current')}</small>}</span>
              {selection === item.id ? <Check size={15} /> : <ChevronRight size={15} />}
            </button>)}
            {!state.custom.length && <p className="tm-empty-library">{tr('noSavedThemes')}</p>}
          </div>
          <button type="button" className="tm-new-button" data-testid="theme-new" onClick={() => openUpload('new')} disabled={!!busy || atLimit} title={atLimit ? tr('errorMaxThemes', { max: MAX_CUSTOM_SKINS }) : undefined}><Plus size={16} />{tr('newTheme')}</button>
        </aside>
        <section className="tm-editor" aria-label={tr('livePreview')}>
          <div className="tm-preview-heading"><div><span className="tm-section-label">{tr('livePreview')}</span><h3>{currentName}</h3></div><span className={`tm-preview-badge ${changed ? 'is-draft' : ''}`}><span />{tr(changed ? 'unsavedPreview' : 'current')}</span></div>
          <div className="tm-preview-card">
            <div className={`tm-preview-image ${isCustom ? 'is-adjustable' : ''} ${dragging ? 'is-dragging' : ''}`} data-testid="theme-preview" ref={preview}
              data-theme={isCustom ? 'custom' : selection} style={{ aspectRatio: aspect } as CSSProperties}
              aria-label={tr('imageLabel')} aria-describedby={isCustom ? hintId : undefined} tabIndex={isCustom ? 0 : undefined}
              onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
              onKeyDown={event => {
                if (!isCustom || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault(); const delta = event.shiftKey ? 10 : 1;
                updateSkin(event.key === 'ArrowLeft' ? { x: clamp(skin.x - delta, 0, 100) } : event.key === 'ArrowRight' ? { x: clamp(skin.x + delta, 0, 100) } : event.key === 'ArrowUp' ? { y: clamp(skin.y - delta, 0, 100) } : { y: clamp(skin.y + delta, 0, 100) });
              }}>
              {isCustom && cover && <img className="tm-custom-art" alt="" draggable={false} src={skin.dataUrl} style={{ width: cover.width, height: cover.height, left: cover.left, top: cover.top, opacity: skin.opacity / 100 }} />}
              {selection === 'wolf' && <img className="tm-wolf-art" alt="" draggable={false} src={WOLF_IMAGE} />}
              <div className="tm-preview-wash" />
              <div className="tm-preview-copy" aria-hidden="true"><span className="tm-preview-wordmark">WhiteWolf<span>· X</span></span><span>{tr('brandDescriptor')}</span><i /></div>
              {isCustom && <span className="tm-drag-indicator" aria-hidden="true"><Move size={17} /></span>}
            </div>
            <div className="tm-preview-stats" aria-hidden="true"><span><i /><b /></span><span><i /><b /></span><span><i /><b /></span><span><i /><b /></span></div>
          </div>
          {isCustom ? <>
            <p className="tm-preview-hint" id={hintId}><Move size={14} />{tr('previewHint')}</p>
            <div className="tm-editor-tools"><button type="button" data-testid="theme-auto-crop" onClick={() => void autoCrop()} disabled={!!busy}><Sparkles size={15} />{tr('autoCrop')}</button><button type="button" data-testid="theme-replace" onClick={() => openUpload('replace')} disabled={!!busy}><Upload size={15} />{tr('replaceImage')}</button></div>
            <label className="tm-name-field" htmlFor={nameId}><span>{tr('name')}</span><input id={nameId} data-testid="theme-name" type="text" value={skin.name} maxLength={MAX_NAME} placeholder={tr('namePlaceholder')} disabled={!!busy} onChange={event => updateSkin({ name: event.target.value })} /></label>
            <div className="tm-adjustments"><div className="tm-adjustments-heading"><span><SlidersHorizontal size={15} />{tr('custom')}</span><button type="button" data-testid="theme-reset" onClick={() => void autoCrop(true)} disabled={!!busy} title={tr('resetImage')}><RotateCcw size={14} />{tr('reset')}</button></div>
              <div className="tm-sliders">{slider('x', 'positionX', 0, 100, 1, value => `${Math.round(value)}%`)}{slider('y', 'positionY', 0, 100, 1, value => `${Math.round(value)}%`)}{slider('zoom', 'zoom', 1, 2, 0.01, value => `${value.toFixed(2)}×`)}{slider('opacity', 'opacity', 0, 100, 1, value => `${Math.round(value)}%`)}</div>
            </div>
            {savedSkin && <div className="tm-delete-area">{confirmDelete ? <div className="tm-delete-confirm"><span>{tr('confirmDelete')}</span><button type="button" className="tm-text-danger" data-testid="theme-delete-confirm" onClick={() => void deleteSkin()} disabled={!!busy}>{tr('delete')}</button><button type="button" data-testid="theme-delete-cancel" onClick={() => setConfirmDelete(false)} disabled={!!busy}>{tr('cancel')}</button></div> : <button type="button" className="tm-delete-button" data-testid="theme-delete" onClick={() => setConfirmDelete(true)} disabled={!!busy}><Trash2 size={14} />{tr('deleteTheme')}</button>}</div>}
          </> : <div className="tm-preset-description"><span>{selection === 'wolf' ? <Sparkles size={18} /> : <Palette size={18} />}</span><div><strong>{tr(selection === 'wolf' ? 'wolfDescription' : 'minimalDescription')}</strong><p>{tr('customDescription')}</p></div><button type="button" className="tm-small-upload" data-testid="theme-upload" onClick={() => openUpload('new')} disabled={!!busy || atLimit}><ImagePlus size={16} />{tr('upload')}</button></div>}
          <p className="tm-upload-hint">{tr('uploadHint', { formats: 'JPEG / PNG / WebP', max: '12 MiB' })}</p>
          {error && <p className="tm-error" data-testid="theme-error" role="alert">{error}</p>}
          {busy && <p className="tm-working" role="status"><LoaderCircle size={15} className="tm-spinner" />{tr(busy === 'save' ? 'saving' : busy === 'upload' ? 'uploading' : 'loading')}</p>}
        </section>
      </div>
      <footer className="tm-footer"><button type="button" className="tm-button tm-button-secondary" data-testid="theme-cancel" onClick={close} disabled={!!busy}>{tr('cancel')}</button><div>{savedSkin && <button type="button" className="tm-button tm-button-secondary" data-testid="theme-save-as" onClick={() => void save(true)} disabled={!!busy || atLimit}>{tr('saveAs')}</button>}<button type="button" className="tm-button tm-button-primary" data-testid="theme-apply" onClick={() => void save()} disabled={!!busy}>{busy === 'save' ? <LoaderCircle size={16} className="tm-spinner" /> : <Check size={16} />}{tr(busy === 'save' ? 'saving' : isCustom ? 'saveApply' : 'applyTheme')}</button></div></footer>
      <input className="tm-file-input" data-testid="theme-file" ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label={tr('upload')} tabIndex={-1}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} />
    </div>
  </dialog>;
}
