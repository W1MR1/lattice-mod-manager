import { Gauge, Network, ShieldCheck } from 'lucide-react';
import { useUI } from '../store';
import { LatticeMark } from '../components/Shell';

export function Welcome() {
  const setAddGame = useUI((s) => s.setAddGame);
  return (
    <div className="welcome">
      <div className="welcome-hero">
        <span style={{ color: 'var(--accent)' }}>
          <LatticeMark size={48} />
        </span>
        <h1>Сборки, которые не ломаются</h1>
        <p>Lattice ставит моды и коллекции вместе со всеми зависимостями, проверяет каждую связь до установки и откатывает изменения одним действием.</p>
        <button className="btn primary" style={{ height: 40, padding: '0 20px', marginTop: 8 }} onClick={() => setAddGame(true)}>
          Добавить игру
        </button>
      </div>
      <div className="pillars">
        <div className="card pillar">
          <Network size={22} />
          <b>Граф связей</b>
          <p>У каждого мода и коллекции есть связи: «требует», «нужен для», «несовместим». Решатель подбирает версии так, чтобы все они сходились.</p>
        </div>
        <div className="card pillar">
          <Gauge size={22} />
          <b>Загрузки без ограничений</b>
          <p>Своего троттлинга нет. Файлы качаются по частям в несколько потоков, а освободившийся поток забирает часть чужой работы.</p>
        </div>
        <div className="card pillar">
          <ShieldCheck size={22} />
          <b>Безопасные источники</b>
          <p>Modrinth, Thunderstore, GitHub Releases и ваши файлы. Только HTTPS и доверенные домены, хэши проверяются, игра восстанавливается из резервной копии.</p>
        </div>
      </div>
    </div>
  );
}
