import { useEffect, useState } from 'react';
import { bridge } from '../api';
import { useUI } from '../store';

const cache = new Map<string, Promise<string | null>>();

function iconOf(file: string): Promise<string | null> {
  let p = cache.get(file.toLowerCase());
  if (!p) {
    p = bridge.fileIcon(file).catch(() => null);
    cache.set(file.toLowerCase(), p);
  }
  return p;
}

/**
 * The game's own icon, taken from its executable (for Minecraft, from the
 * launcher that runs it). Until it loads, or when there is none, a tile with
 * the game's letters.
 */
export function GameIcon({ defId, exe, gamePath, size = 32, bare }: { defId: string; exe?: string; gamePath?: string; size?: number; bare?: boolean }) {
  const def = useUI((s) => s.defs.find((d) => d.id === defId));
  const file = exe ?? (gamePath && def?.exe?.[0] ? `${gamePath.replace(/[\\/]+$/, '')}\\${def.exe[0].replace(/\//g, '\\')}` : undefined);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (file) void iconOf(file).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [file]);
  if (src) return <img className="game-icon" src={src} width={size} height={size} alt="" draggable={false} />;
  // inside a tile that is already styled (the game rail)
  if (bare) return <span>{def?.short ?? '?'}</span>;
  return (
    <span className="game-tile" style={{ ['--hue' as string]: def?.hue ?? 260, width: size + 8, height: size + 8, pointerEvents: 'none' }} aria-hidden>
      <span>{def?.short ?? '?'}</span>
    </span>
  );
}
