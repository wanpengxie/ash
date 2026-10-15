# The card runtime

A card in the conversation is not a picture: it is the third surface of an Ash app, next to its pages and its home-screen
cards. Behind it stand the hub's words (through the router and the gate), a backend the agent writes itself (an app, skill
`build-app`), and the agents. `service:cards` keeps every card that holds resources and lets it sleep when nobody looks.
This builds on docs/GENUI.md (the card language, `show`, `card.update`, forms).

## 1. A card belongs to an app or to an agent

`person:owner/show {a2ui, id, text, app?, temporary_app?, ttl_min?}`. With `app`, the card is that app's surface: every
call it makes is made **as `app:<id>`**, through the router and the gate, limited to the app's `needs` (approved by the
owner when the app was installed). Without `app` the card is the agent's: it can only talk to agents and do things on the
phone itself. An app may change its own cards (`card.update`), as an app refreshes its home-screen cards.

`temporary_app: true` says the app exists only for this card (written by the agent with `build-app` for it): it is removed
when all its cards are closed, unless the owner keeps it (「存成应用」).

## 2. Actions

| action | what happens | where |
|---|---|---|
| `{event: {name, context}}` | the owner's `say` to the card's agent (as before) | phone → agent |
| `openUrl` / `openApp` / `openAsh` / `{copy: {text}}` | opens a link, an app page, copies text | phone only |
| `{call: {member, word, body, result?, timeout_s?}}` | the word is called as the card's app; its result goes into the card's data at `result` | hub, `service:cards/act` |
| `{ask: {agent?, text, result?}}` / `{tell: {agent?, text}}` | the agent is asked (its answer into `result`) or told, with the card's data | hub, `service:cards/act` |
| form 「提交」 | `person:owner/form` (as before) | phone → vault → hub |

`body` and `text` may bind the card's values (`{path}`, `formatString`); they are resolved on the hub from the values
the owner's screen sends with the press. A call that is not a read goes through the gate like an agent's call: the owner
pressed the button, so the app may be asked about, with the approval card on his screen (the call waits for his answer, then
runs or is refused). Nothing else is opened: no word the app was not granted, no way around the gate.

**A button's life** (both renderers): pressed → 「处理中」 and disabled at once; the hub keeps one run per card and
component (pressing again while it runs does nothing); the outcome is written on the card itself (`actions.<component>:
{state: running | ok | failed, text, at}`; a failure says why and what to do); after `timeout_s` (default 30) it is
retryable; the phone gives a short haptic tick.

## 3. Live data

`a2ui.sources: {"/path": source}` binds a data path to
- `{member, word, body?, every_s, pick?, keep?}`: read every `every_s` seconds (at least 5), as the card's app;
- `{event: "<member>/<event>", pick?, keep?}`: each such event the hub sees (throttled to one per 2 s).

`pick` is a JSON pointer into the result or the event body; `keep: n` appends to a list of the last n values (a live chart:
`Chart` series `values` may be `{path}`). Sources need an app that was granted the word. They run only while the card is
active; each change re-draws the card on the hub and is pushed to the screens as one present frame
(`{surface: "chat", op: "card.patch", body: {card}}`), never written to the ledger. The card shows 「HH:MM 更新」.

## 4. `service:cards`: registry and lifecycle

Every card shown is registered (id, message, creator, app, temporary app, sources, lifecycle, pinned, last seen, last
used, expiry, the state of its buttons). Lifecycle:

| state | when | what runs |
|---|---|---|
| active | on a screen now (reported), or used in the last 2 minutes | sources run; its app runs |
| idle | off screen for more than 2 minutes | sources paused (timers stopped, events not taken) |
| dormant | idle for 30 minutes (`cards.dormant_minutes`) | data frozen as a snapshot (「已休眠 · HH:MM 的数据」); a temporary app whose cards are all dormant is put to sleep (`service:apps/apps.sleep`) |
| closed | `card.close` by its creator or the owner, `ttl_min` passed, a form answered | static snapshot; actions refused |

Seeing or pressing a dormant card wakes it: the app is woken (`apps.wake`; a call to a sleeping app also wakes it),
the sources run again, the card is refreshed. A pinned card is never put to sleep and keeps its sources running off screen.

Limits (hub settings): `cards.max_active` 8, `cards.max_sources` 16, `cards.max_temporary_apps` 5; over a limit the least
recently used goes dormant first (its temporary app sleeps). A temporary app is removed when all its cards are closed.

**Visibility**: the owner's screens report the card ids on screen with `service:cards/seen {cards}` when the list stops
scrolling (and once a minute while the chat is visible); no screen reporting = everything idle.

**Words** (`service:cards`, the owner and agents alike): `list`, `describe {id}`, `sleep {id}`, `wake {id}`, `close {id}`,
`pin {id, pinned}`, `keep {id}` (the temporary app stays), `act {card, component, data, request?}`, `seen {cards}`. The owner's
page: the built-in app 「卡片」 (`packages/apps/cards`): the cards that run, their app, state and sources, with sleep / wake /
close / pin — an app like any other, using the same words.

## 5. The mini app in a card

`Html` is an app page set into the conversation: besides `ash.send(action, context)` it has `ash.call(member, word, body)`,
`ash.ask(text)` and `ash.tell(text)`, each sent as `service:cards/act {request}` and run exactly like a button of the card
(as the card's app, through the gate); the answer comes back to the page.

## 6. Not here

A card's app is any Ash app; writing one is skill `build-app`. Card actions do not open new channels to devices or the
network: everything is a word through the router.
