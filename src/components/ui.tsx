import { useEffect, useRef, type ReactNode } from 'react';
import { CircleCheck, CircleX, Info, Loader, Minus, Plus, TriangleAlert, X } from 'lucide-react';
import type { DownloadView, Severity } from '../../shared/types';
import { t } from '../../shared/i18n';

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'accent';

const TONE_ICON = {
  ok: CircleCheck,
  warn: TriangleAlert,
  err: CircleX,
  info: Info,
} as const;

export function sevTone(s: Severity): Tone {
  return s === 'error' ? 'err' : s === 'warning' ? 'warn' : 'info';
}

/** Status is always icon + word, never colour alone. */
export function StatusChip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  const Icon = tone in TONE_ICON ? TONE_ICON[tone as keyof typeof TONE_ICON] : null;
  return (
    <span className={`chip ${tone === 'muted' ? '' : tone}`} title={title} aria-label={title}>
      {Icon && <Icon size={13} strokeWidth={2.4} aria-hidden />}
      {children}
    </span>
  );
}

export function SevIcon({ s, size = 16 }: { s: Severity; size?: number }) {
  const tone = sevTone(s);
  const Icon = TONE_ICON[tone as 'err' | 'warn' | 'info'];
  return <Icon size={size} className={`sev-${tone}`} aria-label={s === 'error' ? t('Ошибка') : s === 'warning' ? t('Предупреждение') : t('Совет')} />;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader size={size} className="spin" aria-label={t("Загрузка")} />;
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

export function ModIcon({ url, title, size }: { url?: string; title: string; size?: 'lg' }) {
  const initials = title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  if (url) return <img className={`mod-icon ${size ?? ''}`} src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  return (
    <span className={`mod-icon ${size ?? ''}`} aria-hidden>
      {initials}
    </span>
  );
}

/** 0–100 ring; colour by threshold, and the number is always printed. */
export function HealthRing({ score, size = 32 }: { score: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const tone = score >= 90 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--err)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('Совместимость {0} из 100', score)}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={4} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={tone}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${(c * score) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray var(--dur) var(--ease)' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.32} fontWeight={800} fill="var(--text-1)" fontFamily="var(--font-mono)">
        {score}
      </text>
    </svg>
  );
}

/** Progress bar split into the real byte ranges each connection is fetching. */
export function SegmentBar({ d }: { d: DownloadView }) {
  const size = d.size || 1;
  if (d.segments.length === 0 || !d.size) {
    const pct = d.state === 'done' ? 100 : 0;
    return (
      <div className="segbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`seg-fill ${d.state === 'done' ? 'done' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    );
  }
  const pct = Math.round((d.received / size) * 100);
  return (
    <div className="segbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('Загружено {0}%', pct)}>
      {d.segments.map((s, i) => {
        const left = (s.start / size) * 100;
        const width = ((s.end - s.start + 1) / size) * 100;
        const filled = Math.min(1, Math.max(0, (s.pos - s.start) / (s.end - s.start + 1)));
        return (
          <div key={i} className="seg-track" style={{ left: `${left}%`, width: `${width}%` }}>
            <div className={`seg-fill ${d.state === 'done' ? 'done' : s.active ? 'active' : ''}`} style={{ width: `${filled * 100}%` }} />
            {i > 0 && <div className="seg-gap" style={{ left: 0 }} />}
          </div>
        );
      })}
    </div>
  );
}

export function Stepper({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <span className="stepper">
      <button type="button" aria-label={t("Меньше")} onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}>
        <Minus size={14} />
      </button>
      <span className="mono">
        {value}
        {suffix}
      </span>
      <button type="button" aria-label={t("Больше")} onClick={() => onChange(Math.min(max, +(value + step).toFixed(2)))}>
        <Plus size={14} />
      </button>
    </span>
  );
}

export function Modal({ title, sub, onClose, children, foot, size }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; size?: 'sm' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // only the topmost dialog reacts when dialogs are stacked
      const all = document.querySelectorAll('.modal');
      if (all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {sub && <div className="muted">{sub}</div>}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label={t("Закрыть")}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
