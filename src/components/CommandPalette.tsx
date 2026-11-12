import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Compass, CornerDownLeft, Download, FileText, Gamepad2, History, Home, Layers, Library, Moon, Network, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, User } from 'lucide-react';
import { api } from '../api';
import { useActive, useUI, type Route } from '../store';
import { ModIcon } from './ui';
import { t } from '../../shared/i18n';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void | Promise<unknown>;
}

/** Ctrl+K: every screen, action, profile, game and mod, one line of typing away. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { state, game, profile } = useActive();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);

  const commands = useMemo<Command[]>(() => {
    const ui = useUI.getState();
    const go = (r: Route) => () => ui.go(r);
    const out: Command[] = [];
    const screen = (r: Route, label: string, icon: React.ReactNode) => out.push({ id: `go:${r}`, label, hint: t('экран'), icon, run: go(r) });
    if (game) {
      screen('home', t('Главная'), <Home size={15} />);
      screen('mods', t('Моды'), <Layers size={15} />);
      screen('discover', t('Обзор'), <Compass size={15} />);
      screen('graph', t('Граф связей'), <Network size={15} />);
      screen('collections', t('Коллекции'), <Library size={15} />);
      screen('snapshots', t('Снимки'), <History size={15} />);
    }
    screen('downloads', t('Загрузки'), <Download size={15} />);
    screen('settings', t('Настройки'), <Settings size={15} />);
    const act = (id: string, label: string, icon: React.ReactNode, run: Command['run']) => out.push({ id, label, hint: t('действие'), icon, run });
    if (game && profile) {
      act('play', t('Играть'), <Play size={15} />, async () => {
        const r = await ui.run(() => api.launchGame(game.id));
        if (r) ui.toast('info', r.note);
      });
      act('apply', t('Применить к игре'), <RefreshCw size={15} />, () => ui.run(() => api.deploy(profile.id), t('Моды применены к игре')));
      act('update', t('Обновить безопасно'), <RefreshCw size={15} />, () => ui.openPlan(t('Безопасное обновление модов'), () => api.planUpdates(profile.id)));
    }
    act('health', t('Проверить целостность'), <ShieldCheck size={15} />, () => ui.checkHealth(true));
    act('journal', t('Журнал Lattice'), <ClipboardList size={15} />, () => useUI.setState({ journalOpen: true }));
    act('report', t('Скопировать отчёт о проблеме'), <FileText size={15} />, async () => {
      const text = await ui.run(() => api.problemReport());
      if (text) {
        await navigator.clipboard.writeText(text);
        ui.toast('ok', t('Отчёт о проблеме скопирован: вставьте его в сообщение.'));
      }
    });
    act('add-game', t('Добавить игру'), <Plus size={15} />, () => ui.setAddGame(true));
    act('theme', t('Сменить тему: светлая или тёмная'), <Moon size={15} />, () => ui.run(() => api.updateSettings({ theme: state?.settings.theme === 'light' ? 'dark' : 'light' })));
    for (const g of state?.games ?? []) {
      if (g.id !== game?.id) out.push({ id: `game:${g.id}`, label: g.name, hint: t('игра'), icon: <Gamepad2 size={15} />, run: () => ui.run(() => api.setActiveGame(g.id)) });
    }
    for (const p of state?.profiles.filter((x) => x.gameId === game?.id) ?? []) {
      if (p.id !== profile?.id) out.push({ id: `profile:${p.id}`, label: p.name, hint: t('профиль'), icon: <User size={15} />, run: () => ui.run(() => api.switchProfile(game!.id, p.id)) });
    }
    for (const m of Object.values(profile?.mods ?? {})) {
      out.push({
        id: `mod:${m.key}`,
        label: m.title,
        hint: m.enabled ? t('мод') : t('мод, выключен'),
        icon: <ModIcon url={m.iconUrl} title={m.title} />,
        run: () => {
          ui.select(m.key);
          ui.go('mods');
        },
      });
    }
    return out;
  }, [state, game, profile]);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (words.length ? commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w))) : commands.filter((c) => !c.id.startsWith('mod:'))).slice(0, 40);
  const cur = Math.min(at, Math.max(0, shown.length - 1));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const fire = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    void c.run();
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Команды')}>
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={input}
            value={q}
            placeholder={t('Мод, экран или действие…')}
            aria-label={t('Найти мод, экран или действие')}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAt(Math.min(shown.length - 1, cur + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAt(Math.max(0, cur - 1));
              } else if (e.key === 'Enter') fire(shown[cur]);
              else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <p className="muted palette-empty">{t('Ничего не нашлось.')}</p>}
          {shown.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === cur} className="palette-item" onMouseEnter={() => setAt(i)} onClick={() => fire(c)}>
              <span className="palette-icon">{c.icon}</span>
              <span className="grow ellipsis">{c.label}</span>
              {c.hint && <span className="faint">{c.hint}</span>}
              {i === cur && <CornerDownLeft size={13} className="faint" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
