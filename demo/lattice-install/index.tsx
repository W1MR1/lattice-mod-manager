import type { CSSProperties, ReactNode } from 'react'
import { Check, CornerDownRight, CornerLeftUp } from 'lucide-react'
import { Badge, Bar, Collapse, Count, Stage, States, Toast, Window, type Act } from '../kit'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import '@fontsource/manrope/700.css'
import '@fontsource/manrope/800.css'
import '@fontsource/jetbrains-mono/500.css'
import './lattice.css'

// Lattice, the mod manager: installing one mod brings its dependency along.
// Started from the dark-hero gold (stage size, corner bleed, rows that open
// at the top and carry the list down, one status changing on its own pill),
// with a satellite card straddling the window's left edge over the game rail.
//
// Beats: the cursor presses Install on Iris Shaders; the same card opens into
// the install plan (Iris asked for, Sodium needed by it, links resolve); Apply
// turns the card into "in profile" while both rows open at the top, each
// downloading on its own segmented bar; the bars settle into Compatible and the
// mod count rolls 4 → 6; a toast offers Undo. After the hold the cursor presses
// Undo: the rows leave together and the card is back to Install — the reset has
// a cause, the rollback Lattice really performs from its automatic snapshot.
//
// Real strings: the game, the context, the two mods and their versions, the plan
// lines, the statuses, the toast. Everything else is placeholder at row pitch.

type Card = 'result' | 'plan' | 'done'
type S = { card: Card; rows: boolean; p: number; ready: boolean; toast: boolean }

const initial: S = { card: 'result', rows: false, p: 0, ready: false, toast: false }
const POSTER: S = { card: 'done', rows: true, p: 1, ready: true, toast: true }
const REST = { wide: { x: 250, y: 400 }, compact: { x: 300, y: 300 } }

async function script(a: Act<S>) {
  await a.wait(900)
  if (a.layout === 'wide') {
    a.mark('install')
    await a.move({ at: 'install', x: 0.78, y: 0.62 })
    await a.click()
    await a.set({ card: 'plan' })
    await a.wait(1900)
  } else {
    // the phone design shows the plan from the first frame: one press less
    await a.wait(1200)
  }
  a.mark('apply')
  await a.move({ at: 'apply', x: 0.78, y: 0.62 })
  await a.click()
  await a.set({ card: 'done', rows: true })
  for (let i = 1; i <= 7; i++) {
    await a.wait(240)
    a.put({ p: i / 7 })
  }
  await a.wait(200)
  a.mark('ready')
  await a.set({ ready: true })
  await a.wait(500)
  await a.set({ toast: true })
  await a.wait(2300)
  a.mark('undo')
  await a.move({ at: 'undo', x: 0.7, y: 0.6 })
  await a.click()
  // the rollback takes back what the loop added, as one motion
  await a.set({ toast: false, rows: false, card: 'result' })
  await a.wait(900)
  await a.snap({ p: 0, ready: false })
  await a.move(a.layout === 'compact' ? REST.compact : REST.wide)
}

const NEW = [
  { name: 'Sodium', sub: 'нужен для Iris', ver: '0.8.13', req: 0, need: 1, rates: [1] },
  { name: 'Iris Shaders', sub: 'установлен вами', ver: '1.8.14', req: 1, need: 0, rates: [1.2, 0.92] },
]

export default function LatticeInstall() {
  return (
    <Stage<S>
      width={760}
      height={440}
      compact={{ below: 760, width: 358, height: 580 }}
      theme="dark"
      initial={initial}
      poster={POSTER}
      script={script}
      cursor={{ at: REST }}
      className="lt"
    >
      {(s, _rect, layout) => {
        const list = (
      <div className="lt-body">
        <header className="lt-head">
          <span className="lt-ctx">Основной</span>
          <span className="lt-ctx">
            <span className="lt-mono">1.21.1</span> · Fabric
          </span>
          <span className="lt-grow" />
          <span className="lt-health">
            <Ring />
            {layout === 'wide' && (
              <span className="lt-health__text">
                Сборка цела
                <small>
                  <span>модов:</span>
                  <Count value={s.rows ? 6 : 4} />
                </small>
              </span>
            )}
          </span>
        </header>
        <div className="lt-cols">
          <span />
          <span>Мод</span>
          <span className="lt-wide">Версия</span>
          <span className="lt-wide">Связи</span>
          <span>Статус</span>
        </div>
        <div className="lt-list">
          <Collapse open={s.rows} reveal="drop">
            {NEW.map((m) => (
              <ModRow key={m.name} name={m.name} sub={m.sub} ver={m.ver} req={m.req} need={m.need} status={<Status ready={s.ready} p={s.p} rates={m.rates} />} />
            ))}
          </Collapse>
          <ModRow name="Fabric API" sub="зависимость" ver="0.116.17" req={0} need={1} status={<Compatible quiet />} />
          {(layout === 'compact' ? [104, 84, 112] : [132, 104, 148]).map((w, i) => (
            <div key={i} className="lt-row lt-row--filler">
              <span className="lt-switch lt-switch--filler" />
              <span className="lt-name">
                <Bar w={24} h={24} r={6} tone={2} />
                <span className="lt-lines">
                  <Bar w={w} h={8} r={4} tone={2} />
                  <Bar w={w - 46} h={6} r={3} tone={1} />
                </span>
              </span>
              <span className="lt-wide">
                <Bar w={58} h={7} r={3.5} tone={1} />
              </span>
              <span className="lt-wide">
                <Bar w={56} h={18} r={6} tone={1} />
              </span>
              <span>
                <Bar w={86} h={20} r={10} tone={1} />
              </span>
            </div>
          ))}
        </div>
      </div>
        )
        const win =
          layout === 'compact' ? (
            // on a phone the list is a panel of the app, stacked under the plan
            <section className="lt-panel">
              <div className="lt-panel__title">Minecraft: Java Edition</div>
              {list}
            </section>
          ) : (
            <Window className="lt-win" title="Minecraft: Java Edition" sidebarWidth={96} sidebar={<Rail />}>
              {list}
            </Window>
          )
        const card = <PlanCard card={s.card} compact={layout === 'compact'} />
        const toast = (
    <Toast
      show={s.toast}
      className="lt-toast"
      icon={<Check size={15} strokeWidth={2.6} className="lt-ok" />}
      action={
        <span className="lt-undo" data-target="undo">
          Откатить
        </span>
      }
    >
      Установлено 2 мода
    </Toast>
        )
        // On a phone the card and the window are one stack: one width, 12px apart,
        // the window running off the bottom. Wide, the card straddles the window.
        return layout === 'compact' ? (
          <>
            <div className="lt-stack">
              {card}
              {win}
            </div>
            {toast}
          </>
        ) : (
          <>
            {win}
            {card}
            {toast}
          </>
        )
      }}
    </Stage>
  )
}

// One card for the whole story: the search hit, its plan, then "in profile".
// The plan opens inside the card (its height carries the footer down), and the
// footer's button and badge share one slot, so the card never swaps for another.
function PlanCard({ card, compact }: { card: Card; compact: boolean }) {
  // on a phone the plan is always open, so the card keeps one height above the window
  const step: Card = compact && card === 'result' ? 'plan' : card
  return (
    <div className="lt-card">
      <div className="lt-card__top">
        <Bar w={34} h={34} r={8} tone={3} />
        <span className="lt-lines">
          <span className="lt-card__title">Iris Shaders</span>
          <span className="lt-card__sub">Modrinth · шейдеры</span>
        </span>
      </div>
      <Collapse open={step === 'plan' || compact}>
        <div className="lt-plan">
          <div className="lt-plan__label">План установки</div>
          <div className="lt-plan__row">
            <span className="lt-plan__name">Iris Shaders</span>
            <span className="lt-plan__why">по запросу</span>
          </div>
          <div className="lt-plan__row">
            <span className="lt-plan__name">
              <CornerDownRight size={12} strokeWidth={2.2} className="lt-faint-icon" />
              Sodium
            </span>
            <span className="lt-plan__why">нужен для Iris</span>
          </div>
          <Badge tone="success" icon={<Check size={12} strokeWidth={3} />} className="lt-plan__ok">
            Связи сходятся
          </Badge>
        </div>
      </Collapse>
      <div className="lt-card__foot">
        <States
          value={step}
          align="end"
          states={{
            result: (
              <span className="lt-btn" data-target="install">
                Установить
              </span>
            ),
            plan: (
              <span className="lt-btn" data-target="apply">
                Применить
              </span>
            ),
            done: (
              <Badge tone="success" icon={<Check size={12} strokeWidth={3} />} className="lt-badge-even">
                В профиле
              </Badge>
            ),
          }}
        />
      </div>
    </div>
  )
}

function ModRow({ name, sub, ver, req, need, status }: { name: string; sub: string; ver: string; req: number; need: number; status: ReactNode }) {
  return (
    <div className="lt-row">
      <span className="lt-switch" />
      <span className="lt-name">
        <Bar w={24} h={24} r={6} tone={3} />
        <span className="lt-lines">
          <span className="lt-mod">{name}</span>
          <span className="lt-sub">{sub}</span>
        </span>
      </span>
      <span className="lt-wide lt-mono lt-ver">{ver}</span>
      <span className="lt-wide lt-links">
        <span className="lt-pill" data-zero={req === 0 || undefined}>
          <CornerDownRight size={12} strokeWidth={2.2} />
          {req}
        </span>
        <span className="lt-pill" data-zero={need === 0 || undefined}>
          <CornerLeftUp size={12} strokeWidth={2.2} />
          {need}
        </span>
      </span>
      {status}
    </div>
  )
}

function Compatible({ quiet }: { quiet?: boolean }) {
  return (
    <Badge tone="success" icon={<Check size={12} strokeWidth={3} />} className={`lt-badge-even${quiet ? ' lt-badge--quiet' : ''}`}>
      Совместим
    </Badge>
  )
}

// The download and the result share one slot: segments fill, then the pill
function Status({ ready, p, rates }: { ready: boolean; p: number; rates: number[] }) {
  return (
    <States
      value={ready ? 'ok' : 'dl'}
      align="start"
      states={{
        dl: (
          <span className="lt-seg" aria-label="Загрузка">
            {rates.map((r, i) => (
              <span key={i} className="lt-seg__track">
                <span className="lt-seg__fill" style={{ '--p': Math.min(1, p * r) } as CSSProperties} />
              </span>
            ))}
          </span>
        ),
        ok: <Compatible />,
      }}
    />
  )
}

function Ring() {
  const r = 11
  const c = 2 * Math.PI * r
  return (
    <svg width={28} height={28} viewBox="0 0 28 28" className="lt-ring" aria-label="Совместимость 100 из 100">
      <circle cx={14} cy={14} r={r} fill="none" stroke="var(--ss-raised)" strokeWidth={3} />
      <circle cx={14} cy={14} r={r} fill="none" stroke="var(--ss-success)" strokeWidth={3} strokeDasharray={`${c} ${c}`} transform="rotate(-90 14 14)" />
      <text x="14" y="14.5" dominantBaseline="central" textAnchor="middle">
        100
      </text>
    </svg>
  )
}

function Rail() {
  return (
    <nav className="lt-rail">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <span key={i} className="lt-tile" data-active={i === 0 || undefined}>
          <Bar w={16} h={16} r={4} tone={i === 0 ? 4 : 2} />
        </span>
      ))}
    </nav>
  )
}
