import { useEffect, useRef, useState } from 'react';
import type { CustomSkin } from './theme-store';
import { computeCover } from './theme-image';

export function WolfMark() {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M9 6 20 15h8L39 6l-2 23-13 13L11 29 9 6Z" fill="currentColor"/><path d="m13 13 3 12 8 11 8-11 3-12-9 9h-4l-9-9Z" fill="var(--logo-face, #fff)"/><path d="m14 25 6 2m14-2-6 2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><path d="m21 31 3 3 3-3h-6Z" fill="currentColor"/></svg>;
}

export function ThemeArtwork({ mode, skin }: { mode: 'minimal'|'wolf'|'custom'; skin?: CustomSkin }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 150 });
  useEffect(() => {
    if (!frame.current || mode !== 'custom') return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0].contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [mode]);
  if (mode === 'minimal') return null;
  if (mode === 'wolf') return <div className="wolf-artwork" aria-hidden="true"><span className="wolf-orbit"/><img src="./themes/whitewolf-mascot.png" alt="" draggable={false} /></div>;
  if (!skin) return null;
  const cover = computeCover(skin.width, skin.height, size.width, size.height, skin.x, skin.y, skin.zoom);
  return <div className="custom-artwork" ref={frame} aria-hidden="true"><img src={skin.dataUrl} alt="" draggable={false} style={{ width: cover.width, height: cover.height, left: cover.left, top: cover.top, opacity: skin.opacity / 100 }} /></div>;
}
