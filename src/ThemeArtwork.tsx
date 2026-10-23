import { useEffect, useRef, useState } from 'react';
import type { CustomSkin } from './theme-store';
import { computeCover } from './theme-image';
import { brandIconSvg } from './brand-mark';

// Static markup from brand-mark.ts, the same drawing as the extension icons.
const brandIcon = { __html: brandIconSvg(46, 'large', 'ww-brand') };

export function WolfMark() {
  return <span className="brand-icon" aria-hidden="true" dangerouslySetInnerHTML={brandIcon} />;
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
