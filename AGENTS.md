# Brainyard

Один слой над CLI агентов — Claude Code, Codex, Antigravity и OpenCode: статус, разовые вопросы,
запуск в папке с живой лентой событий, сессии, к которым человек возвращается (`open`,
`sessions`), и панели tmux, которые переживают программу. Из терминала, из TypeScript
и из локального дашборда. Два пакета в одном репозитории (npm workspaces, одна версия):
`@antondanv/brainyard` — только API, `@antondanv/brainyard-cli` — команда `brainyard` и дашборд.
Главный потребитель API — Treeyard (`../Treeyard`).

## Стек

TypeScript (ESM, strict), Node.js 22+, без runtime-зависимостей. Тесты — Vitest, lint и
формат — Biome. Публикация обоих пакетов в npm — из GitHub release (`.github/workflows/publish.yml`).

## Команды

Всё — из корня репозитория.

```sh
npm ci                                # при NODE_ENV=production: npm ci --include=dev
npm run dev -- status                 # CLI из исходников
npm run typecheck && npm test && npm run lint && npm run build   # перед «на проверке»
npm run format                        # biome check --write
npm run live                          # проверка на настоящих CLI — тратит деньги, только по просьбе
npm pack --dry-run -w packages/cli    # что уйдёт в npm (так же для packages/brainyard)
```

## Устройство

- `packages/brainyard/` — API, `@antondanv/brainyard`:
  - `src/brains/` — адаптер на каждый CLI: как вызвать, как читать поток.
  - `src/run.ts`, `ask.ts`, `status.ts`, `catalog.ts` — запуск, разовые ответы, статус, модели.
  - `src/sessions.ts`, `open.ts`, `panes.ts` — сохранённые сессии, интерактивный CLI, панели tmux.
  - `test/fixtures/` — фейковые claude, codex, agy и opencode; `test/helpers.ts` — общие и для тестов CLI.
- `packages/cli/` — `@antondanv/brainyard-cli`: `src/main.ts` — команда `brainyard` (диспетчер,
  status, models, ask, run, open, ui и serve), `src/panes.ts`, `sessions.ts`, `usage.ts` — panes и
  pane, sessions и stop, usage; `src/args.ts` — флаги, `src/format.ts` и `term.ts` — вывод;
  `src/ui/` — дашборд и HTTP API; `src/tui/` — приложение (`brainyard` без аргументов):
  `state.ts` — состояние и события, `update.ts` и `view.ts` — чистые `update(state, событие)` и
  `render(state) → строки`, `app.ts` — чтение по расписанию и эффекты, `terminal.ts` — экран
  терминала. Экран — чистая функция: веб рисует те же кадры. Тесты команды — `test/run-cli.ts`:
  он всегда задаёт тестовый сокет tmux. API берёт только из `@antondanv/brainyard`, как внешний
  пользователь; чего не хватает — экспортируй из `packages/brainyard/src/index.ts` осознанно.
- CLI видит исходники API без сборки: `paths` в `tsconfig.json`, alias в `vitest.config.ts`.
  Сборка — сначала API, потом CLI по его `dist/`.
- README, README.ru, CHANGELOG и LICENSE лежат в корне; в пакеты их копирует `prepack`.
- `docs/gotchas.md` — причуды CLI; `docs/http-api.md` — HTTP API (`brainyard serve` и дашборд).

## Правила

- Тесты — на фейковых CLI, без сети и без настоящих агентов. Новое поведение CLI —
  сначала в фейк, потом в адаптер.
- tmux в тестах — только на отдельном сокете; рабочий сервер `tmux -L brainyard` не трогать.
- Публичный API (`packages/brainyard/src/index.ts`) меняется осознанно: запись в CHANGELOG.md.
- Изменилось поведение или команды — поправь README.md и README.ru.md.
- Комментарии в коде — по-английски, коротко и про «зачем».
- Git: коммиты по смыслу (Conventional Commits), только своё; push, теги и релизы — по просьбе.

<!-- treeyard -->
## Дерево задач

Проект ведётся деревом целей в `.tree/` (treeyard): обзор — `.tree/README.md`, узлы — `.tree/nodes/<id>.md`.
Работаешь над задачей — найди её узел (`treeyard show`) и держись его. Итог — в журнал узла
(`treeyard log <id> "что сделано; что осталось"`), всплывшие идеи — новыми узлами
(`treeyard add "…" --parent <id> --status idea`). Критерий выполнен — `treeyard set <id> status=review`; готово ставит человек.
<!-- /treeyard -->
