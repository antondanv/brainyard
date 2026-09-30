<div align="center">

<img src="docs/assets/logo.svg" width="72" height="72" alt="">

# Brainyard

**Один интерфейс к агентам, которые у вас уже есть: Claude Code, Codex и Antigravity.**

Подключайте их к своим проектам через один универсальный API: задайте вопрос или запустите
агента в папке и смотрите живую ленту того, что он делает, человеческими словами. Из TypeScript,
по HTTP из любого языка, из терминала или из локальной веб-панели.

[![CI](https://github.com/antondanv/brainyard/actions/workflows/ci.yml/badge.svg)](https://github.com/antondanv/brainyard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@antondanv/brainyard?color=6d7dfc)](https://www.npmjs.com/package/@antondanv/brainyard)
![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-3c873a)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **Русский**

<img src="docs/assets/dashboard.png" width="860" alt="Панель Brainyard: три карточки статуса и прогон Claude Code, который написал fib.py, запустил его и сообщил вывод">

</div>

## Зачем

Claude Code, Codex и Antigravity — отличные агенты, но у каждого свои команды и методы: свои
флаги, свой формат потока событий, свой способ продолжить сессию, подключить MCP-сервер,
выбрать усилие рассуждения или сообщить о лимите. Подключить к проекту сразу несколько —
значит писать и поддерживать под каждый отдельную интеграцию. А ещё у каждого есть
проблемы, которые видны только на настоящем запуске: промпт, начинающийся с `---`, принимается
за опцию командной строки; CLI не завершается, потому что у него открыт stdin; ход кончается
молча после отказа в инструменте.

Brainyard — один универсальный инструмент под всех: те же опции, те же события и те же ошибки
для всех трёх, и все обходные пути уже внутри. Он запускает установленные у вас CLI с вашими
аккаунтами. Никакого сервиса, никаких прямых вызовов API моделей, никаких ключей на стороне.

Он вынесен из рабочей системы, которая каждый день гоняет все три CLI. Почти всё описанное ниже
существует потому, что без этого падал настоящий прогон ([проблемы CLI](docs/gotchas.md)).

## Возможности

- **Статус одной командой.** Установлен ли CLI, какая версия, залогинен ли и как, какие модели
  и уровни усилия есть. Всё бесплатно, где CLI это позволяет. `--live` проверяет каждый CLI
  вызовом на одно слово, а у Claude Code заодно показывает, сколько израсходовано из 5-часового
  и недельного окон подписки.
- **`ask()`.** Один вопрос, один ответ, в изоляции от вашего проекта: ни `CLAUDE.md`, ни хуки,
  ни MCP-серверы в промпт не просачиваются.
- **`start()` / `run()`.** Агент в папке, поток событий из закрытого списка
  (`message`, `command`, `file_write`, `tool_call`…) и человеческая строка на каждое.
- **Подсказки на ходу.** `hint()` отправляет реплику работающему агенту (Claude Code,
  Antigravity). `stop()` останавливает его вместе со всем, что он запустил.
- **Сессии.** Каждый прогон возвращает `sessionId`; передайте его в `resume`, чтобы продолжить.
- **Модели и усилие.** Список спрашивается у самого CLI, выбор проверяется до запуска: Claude
  Code незнакомое усилие молча заменяет своим умолчанием, и вы заплатили бы не за то, что
  выбрали.
- **Уровни доступа.** `full`, `workspace` и `readonly` на флагах прав и песочниц каждого CLI.
  Проверено живыми прогонами, включая «за пределы папки ничего не пишется».
- **MCP-серверы на один прогон.** Один формат конфига, доставка тем способом, какой нужен
  конкретному CLI, общие конфиги не трогаются.
- **Типизированные сбои.** `usage_limit` (со временем сброса), `rate_limited`,
  `not_logged_in`, `network`… Сразу видно, ждать минуту, ждать до 18:50 или идти логиниться.
- **Веб-панель.** `brainyard ui` открывает карточки статуса и песочницу поверх локального
  HTTP API под токеном, которым можно пользоваться и из других языков.
- **Ноль зависимостей в рантайме.**

## Установка

```sh
npm install -g @antondanv/brainyard    # команда brainyard
npm install @antondanv/brainyard       # библиотека
```

Нужен Node.js 22+ и хотя бы один агентный CLI:

| CLI | Установка | Вход |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | один раз запустить `claude` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | один раз запустить `agy` |

## Командная строка

```console
$ brainyard
Brainyard 0.1.0

  ● Claude Code  2.1.280   ready         signed in with claude.ai, pro
  ● Codex        0.153.4   ready         signed in with ChatGPT · default model gpt-6-astra
  ● Antigravity  1.2.13    ready         signed in · model list fetched with your account

  3 of 3 ready · 3.6s · prove each with a real call: brainyard status --live
```

**Вопрос.** Ответ уходит в stdout, подробности в stderr, так что пайпы работают так, как
выглядят:

```console
$ git diff | brainyard ask claude --model haiku "Review this diff in three bullets"
$ brainyard ask codex --effort high "Explain CRDTs in two sentences" > crdt.md
$ brainyard ask all "In one short sentence: what is a monad?"
── Claude Code claude-opus-5-5 · 4.8s · $0.0079
A monad is a type that wraps values in a context, like optionality, lists, I/O, or state, …

── Codex gpt-6-astra · 9.1s
A monad is a programming abstraction that chains computations while managing context, …

── Antigravity 13.9s
A monad is a design pattern that wraps values in a computational context and enables …
```

**Агент.** Лента идёт в stderr. Пока агент работает, напишите реплику и нажмите Enter — она
дойдёт до него. Ctrl+C останавливает агента, а всё, что он уже записал, остаётся на диске.

```console
$ brainyard run claude --model haiku --cwd ./sandbox "Write fib.py, run it, tell me the output"
Claude Code is working · type a message + Enter to steer, Ctrl+C to stop
00:01 ◆ Claude Code started · claude-haiku-4-5-20251001
00:05 › I'll create a Fibonacci script and run it for you.
00:06 ✎ wrote fib.py
00:09 $ ran: python3 fib.py
00:11 › Done! The output is: 0 1 1 2 3 5 8 13 21 34
00:11 ✓ done in 11.6s · 2 actions · $0.0306

session 32a4caae-… · continue: brainyard run claude --resume 32a4caae-… "…"
```

`--json` печатает каждое событие строкой JSON, `--quiet` — только ответ. Как и `codex exec`,
`ask` и `run` читают stdin из пайпа и дописывают его к промпту; для этого они ждут конца ввода,
поэтому скрипту, который оставляет stdin открытым, нужен флаг `--no-stdin`.

| Команда | Что делает |
|---|---|
| `brainyard [status]` | Какие CLI установлены, залогинены и готовы (`--live`, `--models`, `--json`) |
| `brainyard models [brain…]` | Модели и усилия каждого CLI |
| `brainyard ask <brain\|all> <prompt>` | Один вопрос, один ответ (`--model`, `--effort`, `--system`, `--web`) |
| `brainyard run <brain> <prompt>` | Агент с живой лентой (`--cwd`, `--resume`, `--access`, `--mcp`, `--no-web`, `--json`) |
| `brainyard ui` | Панель на `http://127.0.0.1:4747` |

Мозги называются `claude`, `codex` и `antigravity` (или `agy`). Все флаги — в `brainyard help`.

## Библиотека

```ts
import { ask, run, start, status } from '@antondanv/brainyard';

// Кто готов? Бесплатные проверки; `live: true` добавляет каждому вызов на одно слово.
const { ready } = await status(); // ['claude', 'codex', 'antigravity']

// Один вопрос, один ответ.
const { text, costUsd } = await ask('codex', 'One-line summary of RFC 9110?', { effort: 'low' });

// Агент в папке, событие за событием.
const agent = start({
  brain: 'claude',
  cwd: './app',
  prompt: 'Add a unit test for src/math.ts and make it pass',
  access: 'workspace', // правки и команды только внутри ./app
});

for await (const event of agent) {
  if (event.feed) console.log(event.summary); // "wrote test/math.test.ts", "ran: npm test", …
  if (event.kind === 'command' && event.summary.includes('npm test')) {
    agent.hint('Use vitest, not jest.'); // доходит до агента, пока он работает
  }
}

const result = await agent.result;
if (!result.ok) console.error(result.error); // { kind: 'usage_limit', resetsAt: '6:50pm', … }

// Позже — продолжить тот же разговор.
await run({ brain: 'claude', cwd: './app', resume: result.sessionId, prompt: 'Now add a benchmark' });
```

MCP-серверы на один прогон:

```ts
await run({
  brain: 'codex',
  prompt: 'Which markdown file in the docs is the longest? Summarise it.',
  mcpServers: {
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'] },
  },
});
```

`result` отклоняется, только если прогон так и не начался (неверные опции, CLI не установлен).
Если CLI запустился, `result` разрешается — смотрите на `result.ok`. `ask()` при любом сбое
бросает `BrainyardError` с полем `kind`. Больше примеров — в [`examples/`](examples).

### Опции

| Опция | По умолчанию | |
|---|---|---|
| `brain` | | `claude`, `codex` или `antigravity` |
| `prompt` | | Уходит в stdin, никогда не аргументом |
| `cwd` | `process.cwd()` | Где работает агент (у `ask()` — новая временная папка) |
| `model`, `effort` | как у CLI | Проверяются по каталогу CLI до запуска |
| `resume` | | `sessionId` из прошлого результата |
| `access` | `full` (у `ask()` — `readonly`) | См. ниже |
| `web`, `shell` | `true` (у `ask()` веб выключен) | Выключатели там, где они есть у CLI |
| `mcpServers` | | `{ имя: { command, args?, env? } }` |
| `steerable` | где поддерживается | Держать stdin открытым для `hint()` |
| `nudge` | `true` | Ход, кончившийся без текста, получает одно продолжение в том же разговоре |
| `timeoutMs` | нет | Прогон, убитый на середине, оплачен целиком, поэтому потолка по умолчанию нет |
| `signal`, `onEvent`, `env`, `extraArgs`, `command`, `prices`, `includeRaw` | | |

### Уровни доступа

Агенту без интерфейса некого спросить о разрешении, поэтому инструмент, которому нужно
подтверждение, просто получает отказ. Уровень выбирается заранее:

| `access` | Claude Code | Codex | Antigravity |
|---|---|---|---|
| `full` | все инструменты, без подтверждений | все инструменты, без песочницы | все инструменты, без подтверждений |
| `workspace` | правки и команды в его песочнице, только внутри `cwd` | песочница `workspace-write` | правки; его песочница отклоняет большинство команд |
| `readonly` | только чтение и поиск | песочница `read-only` | режим плана: запись отклоняется |

Проверено настоящими прогонами на каждом CLI: в `workspace` файл внутри `cwd` пишется, а запись
в домашнюю папку падает; в `readonly` не пишется ничего. См.
[`scripts/live-check.ts`](scripts/live-check.ts).

### События

Поток каждого CLI превращается в один закрытый список. У каждого события есть `summary` —
строка для человека с укороченными путями и замаскированными секретами. `feed: false` помечает
то, что правда, но не новость (размышление, успешный результат инструмента).

| kind | |
|---|---|
| `init` | CLI запустился: модель, id сессии |
| `message` / `thinking` | Агент что-то сказал / порассуждал |
| `tool_call` / `command` / `file_write` | Агент что-то сделал |
| `tool_result` | Что вернул инструмент (в ленте — только при сбое) |
| `hint` | Ваша реплика дошла до агента |
| `denied` | CLI отказал в инструменте |
| `warning` | Опция, которую этот CLI не умеет выполнить, упавший MCP-сервер, окно подписки на исходе |
| `error` / `stopped` | Что-то сломалось / прогон остановлен |
| `done` | Всегда последнее |

### Что умеет каждый CLI

| | Claude Code | Codex | Antigravity |
|---|:-:|:-:|:-:|
| Реплики на ходу (`hint`) | ✓ | — | ✓ |
| Продолжение сессии | ✓ | ✓ | ✓ |
| MCP-серверы на прогон | ✓ | ✓ | ✓ |
| Сообщает стоимость в долларах | ✓ | только токены | только токены |
| Список моделей | алиасы | ✓ | ✓ |
| Веб можно выключить | ✓ | ✓ | — (предупреждение) |
| Шелл можно выключить | ✓ | вместо этого песочница | — (предупреждение) |
| Загрузка окон подписки | ✓ | — | — |

Опция, которую CLI выполнить не может, никогда не пропадает молча: она возвращается событием
`warning` и в `result.warnings`.

## Панель и HTTP API

`brainyard ui` поднимает панель со скриншота наверху: карточки статуса и песочницу, где можно
задать вопрос или запустить агента с живой лентой, подсказками, остановкой и кнопкой
«продолжить сессию». **Live check** отправляет каждому CLI промпт на одно слово и показывает,
сколько израсходовано из окон подписки Claude Code, а если CLI не ответил — почему:

<img src="docs/assets/live-check.png" width="860" alt="Живая проверка: Claude Code и Antigravity ответили pong, Codex показывает ошибку — его модель недоступна с ChatGPT-аккаунтом; у Claude Code видны 5-часовое и недельное окна подписки">

Под панелью небольшой HTTP API, который можно звать из любого языка:
[`docs/http-api.md`](docs/http-api.md).

Этот API умеет запускать агентов на вашей машине, поэтому и охраняется соответственно: слушает
только `127.0.0.1`, каждый вызов требует токен, напечатанный при старте, заголовок `Host`
обязан называть этот сервер (защита от DNS rebinding), а запись принимается только JSON-ом с
того же origin.

## Проблемы, пойманные при использовании

Несколько вещей, о которых Brainyard заботится за вас. Полный список с симптомами и
решениями — в [`docs/gotchas.md`](docs/gotchas.md) (на английском).

- **Промпт никогда не уходит в командную строку.** У Claude Code `-p` — булев флаг, поэтому
  промпт, начинающийся с `---`, превращается в `error: unknown option`. Всем трём промпт едет
  в stdin.
- **stdin закрывается ровно тогда, когда кончился ход.** Со stream-json на входе CLI считает
  stdin разговором и ждёт следующую реплику вечно — готовая работа висела бы, пока её не
  убьют.
- **Claude Code вливает реплику, пришедшую посреди хода, в текущий ход; Antigravity ставит её
  в очередь отдельным ходом со своим результатом.** Закрыть stdin не на том результате —
  значит потерять подсказку.
- **Код возврата 0 — не успех.** Antigravity раньше обрывал print mode через пять минут с
  кодом 0 посреди работы. Нет итогового результата — значит, ход оборван.
- **Молчаливый ход получает одно продолжение в том же разговоре.** Antigravity после отказа в
  инструменте заканчивает ход без единого слова. Новый процесс не помнил бы, обо что
  споткнулся прошлый.
- **Лимит подписки — это не 429.** Одно повторяют через секунды, другое сбрасывается через
  часы, и CLI говорит, когда именно. Brainyard это время сохраняет.

## Как это проверено

- **144 теста** гоняют настоящий код против поддельных `claude`, `codex` и `agy`, которые
  говорят на диалекте каждого. Как и настоящие CLI, подделки не выходят, пока открыт stdin: раннер,
  который забыл его закрыть, вешает тест, а не проходит его.
- **`npm run live`** прогоняет все проверки на настоящих CLI самыми дешёвыми моделями: вопрос,
  промпт с дефисами, агентный прогон, подсказку, продолжение сессии, MCP и матрицу доступа.
  Последний прогон: Claude Code 2.1.280, Codex 0.153.4, Antigravity 1.2.13, все 21 проверка
  прошли примерно за $0.20.

## Вопросы

**Он зовёт API моделей или требует ключи?** Нет. Он запускает установленные вами CLI, которые
залогинены вашими подписками или ключами. Наружу не уходит ничего сверх того, что CLI отправил
бы и так.

**`full` — это опасно?** Это то же, что `--dangerously-skip-permissions` у Claude Code: агент
может выполнить любую команду. Для непроверенных промптов берите `workspace` или `readonly`,
или запускайте в контейнере.

**Почему нет таймаута по умолчанию?** Прогон, убитый на середине, оплачен целиком и не
возвращает ничего. Нужен потолок — задайте `timeoutMs`; `stop()` и `AbortSignal` работают
всегда.

**Windows?** Пока не проверялся. Батч-обёртки (`claude.cmd`) обрабатываются, но CI гоняет
Linux и macOS.

**А Gemini CLI, Cursor, opencode…?** Пока нет. Новый CLI — это адаптер плюс живая проверка, и
CLI попадает в список, когда её проходит.

## Участие

См. [CONTRIBUTING.md](CONTRIBUTING.md). Больше всего помогают баг-репорты с выводом
`brainyard status --json` и версией CLI.

## Лицензия

[MIT](LICENSE)
