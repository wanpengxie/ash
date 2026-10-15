# Cards in the conversation (generative UI)

An agent can put any information in front of the owner as a card in the conversation, and ask for input the same way.
There is one card language for the conversation and the home-screen widgets (A2UI v0.9 basic catalog plus Ash
extensions), one component catalog, and one checker. Forms, password fields that go straight into the vault, and
`$vault.<name>` references are built on it.

## 1. The catalog and the checker (`packages/sdk/src/card.ts`)

The checker that `service:widgets` used moves to the sdk (both the human edge and the widgets service use it) and gains a
`surface`:

| Component | widget | chat | |
|---|---|---|---|
| Text (simple Markdown), Image, Icon, Row, Column, Stack, Grid, List, Card, Tabs, Divider, Spacer, Button, CheckBox, Switch, ChoicePicker, ProgressBar, Badge, Clock, Timer, Chart | yes | yes | as today |
| TextField `{label, value, variant: shortText\|longText\|number\|obscured, placeholder}` | no | yes | `obscured` is a password box |
| DateTimeInput `{label, value, enableDate, enableTime}` | no | yes | ISO text in data |
| Slider `{label, value, min, max, step}` | no | yes | |
| Table `{columns, rows}` | no | yes | Ash extension; rows may be a `{path}` |
| Html `{html, height}` | no | yes | the sandboxed mini app (§5) |

Containers (Row, Column, List, Grid) take `gap` in the conversation (dp between children; there is no default spacing),
and a Chart series takes `min` (the bottom of its axis, so a price or a weight is not a flat line). The conversation draws
icons as single-colour line icons from Ash's icon set and uses the app's design tokens and type sizes; the client draws the
card's frame. A few obvious slips are read the way they were meant and noted (a ChoicePicker value given as text, "true"
for a switch, a number written as text). Every card answer also carries `hints`: cheap, certain design checks (more than
two accents, more than one main title, icon or primary button, hex colours, a frame drawn on the root, emoji in texts).

Every component keeps its schema in one table (`FIELDS`); a widget refuses what RemoteViews cannot draw with the reason, as
before. The conversation checks **leniently**: an unknown component or an invalid property is dropped (a dropped child
leaves a gap, not a broken card) and each drop is a diagnostic returned to the agent (`problems`). A card whose root
cannot be drawn is refused (`bad_request`) and never reaches the owner. `widget.card.validate` takes `surface`.

The output is the same literal plan the widget gets (`{root, components, …}`: every binding, function and template
resolved), plus for the conversation: `data` (the card's data model), `binds` (where each input writes) and `reactive`
(some displayed value reads a path an input writes).

## 2. Words

- `person:owner/show {a2ui, id?, text?}` — a card in the conversation (the fixed kinds `{card: options|file|image|link|permission}` stay as they are: they are already drawn natively and are not worth rewriting). `id` (default: the message id) names the card for later updates; `text` is the plain summary for notifications, the lock screen, old clients and the agent's own history. Answers `{accepted, card, problems?}`.
- `person:owner/card.update {id, a2ui?, data?}` — replace the card's layout and/or merge into its data (JSON pointer → value). The card keeps its place in the conversation. Only its creator may update it. This is how a follow-up changes the card instead of sending a new one, and how a long card fills in step by step.
- `person:owner/card.draft {card, data}` — owner only, from the owner's screen: what the owner has typed or chosen so far. The hub keeps it with the card (a refresh shows it again) and, for a reactive card, answers with the card redrawn. Not recorded (it changes nothing anyone acts on; the action that follows carries the values).
- `person:owner/form {title, why?, schema, values?, secret?}` — a card with inputs that waits until the owner submits or cancels (§6).
- `person:owner/card.preview {id, theme?}` — the card as the phone draws it, as a picture the agent can see (a present
  frame `{surface: "chat", op: "card.preview"}` to a channel that shows the conversation; the web page cannot draw one).

## 3. In the conversation

`show` is recorded like any card. The hub keeps a row per card (`owner_cards`: id, message, creator, a2ui, data, plan,
text, state, form) in the ledger database; `service:history/window` hydrates a card item from it, so the newest version
and the owner's draft are what every channel draws. `card.update` is recorded but not displayed; the next window read
(every channel re-reads on `sync`) shows the new version in place.

The phone draws the plan natively in the chat (`ui/ChatCards.kt`: real Android views, the widget's colours, icons,
Markdown and charts), the web page in DOM (`js/cards.js`). Unknown components in a plan (a newer hub) are skipped; a card
item a client cannot draw shows its `text`.

## 4. Interaction and state

- Local, no model: switching tabs, toggling, choosing, typing, sliding change the card's data on the screen at once. The
  client sends `card.draft` (debounced); when the plan is `reactive` it redraws from the answer, so a text that shows
  `${/count}` follows the slider without the agent.
- To the agent: a `Button` with `{event:{name, context}}` sends the owner's `say` to the card's creator with
  `card: {id, action, context, data}` (the current values; never a password) and the button's label as the text. The agent
  reads it as `[card <id>, action <name>] {"…": …}`. The button does only that; what happens is the agent's (interactive
  card rule). The card's state is saved with it.
- Refresh: the window carries the saved data; a client also keeps unsent edits in memory.
- Taste: every card but a form has a 👍 / 👎 footer. A tap is the owner's `say` to the creator with
  `card: {id, action: "feedback", context: {feedback}}`; the agent reads `[card <id>, feedback up] 👍`, the choice is kept with
  the card (`feedback` in the item), and the skill `genui` has the agent keep the owner's taste in `design/TASTE.md` and
  liked cards in `design/gallery/` in its work directory.

## 5. The escape hatch: a sandboxed mini app

`Html {html, height}` is one self-contained HTML document (inline CSS and JS, no external fetch). It runs in its own
WebView (phone) / `iframe sandbox="allow-scripts"` (web) under a strict CSP (`default-src 'none'; script-src
'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`): no network, no storage shared with Ash. The theme comes in
as CSS variables (`--ash-bg`, `--ash-text`, `--ash-accent`, …). A small bridge `ash.send(action, context)` posts an action
exactly like a Button (it reaches the agent as the owner's message); there is no other way out, so anything the mini app
wants done goes through the agent and the gate. "Keep as an app" on the card asks the creator agent to turn it into an
Ash app (the agent writes it with the apps skill: code mode).

## 6. Forms, passwords and `$vault`

`form` is a `show` the hub writes from the schema (TextField / number / Switch / ChoicePicker / DateTimeInput per property;
`secret` fields are `obscured`), with 「提交」 and 「取消」. The request stays open like `ask` (default 24 h, at most 7 days).
On submit the owner's client first saves each secret field with `service:vault/set {ref, value, kind: password}` (the
owner's own word; `value` is `x-ash-secret`, so the ledger holds only `{set, length}`), then answers the form with
`{values: {non-secret fields}, secret: {field: {ref, masked: "****"+last 4}}}`. The hub checks every secret ref is now
set. The agent never sees a value; it uses it by name:

`workspace.bash {command, env: {VAR: "$vault.NAME"}}`. The hub replaces `$vault.NAME` with the value right before it hands
the request to the body (the phone's container, or a computer over the encrypted link); the ledger keeps the reference.
Every value injected is replaced by `***` in everything that body returns (and its base64 and URL-encoded forms). The
first time a name is used on a body the gate asks the owner (「用保险箱里的『标签』在 手机 上执行」, with 「以后都可以」).
The same `$vault.NAME` works in an app's `server.env`, an agent runtime's environment and an MCP server's `env`, resolved
when they start and never written back. `service:vault/request` becomes a one-field form card: no more keys page.

## 7. Plain text

Every card has `text` (given, or made from its title and first texts). Notifications, the island, the lock screen and
anything that cannot draw the card show that.

## 8. Not done here

- Token-level streaming of a card while the model writes it: the runtimes deliver a tool call whole. A long card streams
  by `show` with what is ready (missing children draw as placeholders) and `card.update` as the rest arrives.
- Data by reference: a card's numbers are written into its `data` by the agent. Binding a card to a recorded tool result
  by id needs the agent to know that result's ledger id, which its receipts do not carry yet; it comes with that.
- Maps (a live map): use an Image and an `openUrl` geo: action.

## 9. Delivery

1. Move the checker to the sdk with `surface` and the lenient mode; chat components. Card store, `show {a2ui}`,
   `card.update`, `card.draft`, window hydration, actions to the agent.
2. `form`, vault writes from the client, `vault/request` as a form.
3. Phone renderer (`ChatCards.kt`) and web renderer (`cards.js`), mini app sandbox on both.
4. `$vault` in `workspace.bash` (router hook, scrub, gate grant), apps / agents / MCP environment.
5. Skills, rules, docs; end-to-end test: a script agent sends a form, the owner answers with a secret, the agent runs
   `workspace.bash` with `$vault.X`, and the value is nowhere in the ledger.
