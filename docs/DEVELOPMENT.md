# Разработка Lattice

Для тех, кто хочет собрать Lattice сам, поправить ошибку или добавить игру.

## Запуск из исходников

Нужны Windows 10/11 и Node.js 22.

```bash
npm install
```

```bash
npm run dev
```

Если после `npm install` нет `node_modules/electron/dist`, докачайте Electron:
`node node_modules/electron/install.js`.

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | окно с перезагрузкой при изменениях |
| `npm run build && npm start` | собрать и запустить без dev-сервера |
| `npm run typecheck` | проверка типов |
| `npm test` | 153 теста ядра (около 3 секунд) |
| `npm run i18n` | переводы: каких строк не хватает в каждом языке (`-- --sources` — все строки с ключами) |
| `npm run smoke` | прогон окна во временном профиле: ставит моды с Modrinth, проверяет коллекции, снимает все экраны в `smoke/` |
| `npm run games` | обновить список игр на BepInEx из реестра Thunderstore (`electron/core/thunderstore-games.json`) |
| `npm run dist` | установщик Windows: `release/Lattice-Setup-<версия>.exe` |
| `npm run icon` | перерисовать иконку `build/icon.png` |
| `npm run demo` | анимированный ролик для сайта (`demo/`) |

Флаги прогона (`npm run smoke -- <флаг>` или `Lattice.exe --smoke <флаг>`):

| Флаг | Что проверяет |
|---|---|
| `--fixes` | проверка целостности и починка, установка Fabric в папку лаунчера, удаление без следов |
| `--archives` | 7-Zip лежит вне asar, декодер RAR загружается |
| `--thunderstore` | Valheim: Jötunn с загрузчиком с настоящего Thunderstore |
| `--ts-games=repo,peak` | игры из реестра Thunderstore: самый скачиваемый мод каждой планируется, скачивается и раскладывается; загрузчик должен лечь в корень игры |
| `--showcase=<файл.mrpack>` | библиотека для снимков README: настоящая сборка Minecraft и Cyberpunk 2077 с модами, упакованными по-разному |
| `--home=<папка>` | не временный профиль, а указанный (повторные прогоны без скачивания) |
| `--out=<папка>`, `--routes=home,mods`, `--lang=en`, `--light` | куда класть снимки, какие экраны, язык, светлая тема |

Вызовы, которые шли дольше 200 мс, прогон записывает в `smoke-trace.txt`.

Сборщику установщика нужен путь к проекту короче 260 символов. Если проект
лежит глубоко: `subst L: "<папка проекта>"`, затем `npm run dist` из `L:\`,
потом `subst L: /d`.

Что и как проверяется — в [TESTING.md](TESTING.md). Порядок выпуска — в
[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

## Устройство

Ядро не знает про Electron: `electron/core` импортирует только Node, поэтому всё,
кроме окна, проверяется тестами без запуска программы. Почему Electron, а не
Rust — в [adr/0001-electron-or-rust.md](adr/0001-electron-or-rust.md).

```
shared/
  types.ts        все типы, общие для ядра и окна
  api.ts          единственный список методов, которые окно может вызвать
  i18n.ts         переводы: t('Русский текст') ищет строку по короткому хэшу
  locales/        en, zh-CN, es, pt-BR, de
electron/core/
  service.ts      всё, что может запросить окно
  resolver.ts     подбор версий всех зависимостей под игру и загрузчик
  compat.ts       проверка профиля: связи, версии, коллекции, мастер-файлы
  loadorder.ts    порядок модов; цикл — ошибка, только если в нём есть правило пользователя
  jarmeta.ts      что объявляет jar мода для каждого загрузчика
  layout.ts       раскладка архива: обёртки, файлы россыпью, варианты, правила игр
  installer.ts    распаковка в подготовленную копию: Minecraft, BepInEx, FOMOD, раскладка
  content.ts      проверка по файлам: не туда положено, не хватает основы
  gamelog.ts      журналы игр: какие моды загрузились, какие упали
  deployer.ts     жёсткие ссылки в папку игры, список своих файлов, резервные копии
  removal.ts, cleanup.ts   удаление модов и поиск их следов
  nexus-assist.ts скачивание с Nexus без Premium: подхват файла из папки загрузок
  journal.ts      журнал Lattice и отчёт о проблеме (без ключей и имени пользователя)
  disk.ts         учёт места и уборка ненужного
  downloader.ts   загрузчик по частям с паузой, докачкой и проверкой хэша
  archives.ts     zip, 7z, rar с защитой от выхода за пределы папки
  fomod.ts        разбор ModuleConfig.xml
  plugins.ts      мастер-файлы Bethesda и plugins.txt
  collections.ts  коллекции, импорт .mrpack
  importers.ts    перенос из Vortex, Mod Organizer 2, r2modman
  detect.ts       копии игр в Steam, GOG, Epic, Xbox и лаунчеры Minecraft
  games.ts        игры: девять написаны вручную, остальные — из реестра Thunderstore
  launch.ts       запуск игры
  sources/        Modrinth, CurseForge, Thunderstore, Nexus Mods, GameBanana, GitHub
electron/main.ts  окно, IPC, диалоги, nxm://, обновления, режим --smoke
src/              окно: React, zustand; токены дизайна в src/styles/tokens.css
build/            иконка и шаги установщика NSIS
tests/            тесты ядра; tests/data — настоящие данные сборок
docs/             этот файл и остальная документация
```

## Как добавить строку интерфейса

Пишите по-русски прямо в коде: `t('Текст')`, для чисел — `plural(n, 'мод',
'мода', 'модов')`. Затем `npm run i18n` покажет идентификатор новой строки;
добавьте перевод с этим идентификатором в каждый файл `shared/locales/*.ts`.
Тесты не пройдут, пока хотя бы в одном языке строки нет.

## Как добавить игру

- **Игра на BepInEx с сообществом на Thunderstore** — скорее всего, она уже
  есть: `npm run games` берёт список из реестра Thunderstore. В список попадают
  только игры со стандартными правилами установки BepInEx и копией в Steam.
- **Другая игра** — описание в `electron/core/games.ts`; если моды раскладываются
  по особым папкам — правила в `layout.ts` и основы в `content.ts`; если у игры
  есть журнал загрузчика — разбор в `gamelog.ts`. К каждому — тест на образце.

## Регистрация в Nexus Mods и CurseForge

Nexus не разрешает публичным приложениям работать на личных API-ключах
пользователей: приложение нужно зарегистрировать
([правила API](https://help.nexusmods.com/article/114-api-acceptable-use-policy)).

1. Соберите тестовую версию (`npm run dist`). Вход в Nexus в ней — через личный
   ключ: это разрешено для тестирования.
2. Напишите на support@nexusmods.com: приложите сборку и ссылку на исходники.
3. Отправьте название, описание и логотип (`build/icon.png`).
4. Nexus выдаст «slug» приложения. Соберите выпуск с ним:

```bash
LATTICE_NEXUS_SLUG=ваш-slug npm run dist
```

В PowerShell: `$env:LATTICE_NEXUS_SLUG="ваш-slug"; npm run dist`.

В такой сборке вместо поля для ключа появится кнопка «Войти через Nexus» (SSO):
пользователь подтверждает доступ на сайте Nexus, и Lattice получает ключ, не
видя пароля. Ключ хранится только на компьютере пользователя, в зашифрованном
хранилище Windows.

**CurseForge** — так же: ключ выдаёт сам CurseForge (console.curseforge.com).
Сборка с ключом — `LATTICE_CURSEFORGE_KEY=ключ npm run dist`; без него
пользователь может указать свой ключ в настройках.
