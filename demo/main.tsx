// The product demo for a landing page or README: an authored animation of the
// Lattice window (Stageshow kit), not the app itself. Run with `npm run demo`.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import LatticeInstall from './lattice-install'

function Page() {
  // the kit has no imperative replay: remounting restarts the story
  const [take, setTake] = useState(0)
  return (
    <main>
      <h1>Ставите один мод — связи подтягиваются сами</h1>
      <p>Lattice строит план установки, качает файлы в несколько потоков, проверяет совместимость и даёт откатить изменение одним нажатием.</p>
      <LatticeInstall key={take} />
      <button className="replay" type="button" onClick={() => setTake((t) => t + 1)}>
        Повторить
      </button>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
