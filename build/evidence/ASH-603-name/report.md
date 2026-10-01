# ASH-603 current display name — author evidence

This increment replaces the fixed presence-bar name with the single short name read from the managed `IDENTITY.md` file. The existing authenticated screen sends `service:self/read`; a trusted `self.changed` summary frame only triggers a new read. It never supplies the displayed name. The parser accepts one `- 名字：…` or `- Name: …` line, removes only the exact factory-template note, preserves user names with parentheses, and rejects empty, duplicate, long, control-character, or markup-like values. Missing, malformed, unavailable, disconnected, or changed-scope reads show the default name, never the previous account's name. A same-screen change keeps the prior verified name while its canonical read is pending; a failed read restores the default.

The visible header, accessible label, and person-sheet heading update together. Avatar and human status remain sourced only from authoritative status events. No new route, credential, polling loop, or local file access was added.

From the repository root:

```sh
node --import tsx --test packages/core/ui/test/identity-name.test.js packages/core/ui/test/presence.test.js packages/core/ui/test/sheet-agent.test.js packages/core/ui/test/sheets.test.js
node --import tsx packages/core/ui/test/agent-sheet-browser-probe.mjs
ASH_TEST_DSH_ROOT=/path/to/installed/dsh node --expose-internals --import tsx --test --test-concurrency=1 packages/*/test/*.test.ts packages/core/test/arch/*.test.ts packages/core/test/contract/*.test.ts packages/core/test/fixtures/*.test.ts packages/core/test/members/*.test.ts packages/core/test/world/*.test.ts packages/core/ui/test/*.test.js
npm run -s typecheck
npm run -s build:core
npm run -s gen:ui
git diff --exit-code -- packages/core/src/ui.ts
```

Author focused checks: 18/18, including late same-screen response ordering and the no-flicker read-back/failure path. The installed-DSH serial full suite naturally exited with 456 tests, 397 pass, 59 skip, 0 fail. Typecheck, core build, generated bundle consistency, and the private-term scan (516 files, 0 findings) passed. Production `startOwner` plus isolated Chrome passed: a real `IDENTITY.md` write changed the displayed name after canonical read-back; a registered remote read-only screen saw the same name; switching to another isolated owner scope with no identity file immediately restored the default. The same probe rechecked the previously merged activity and clock pages, managed editor, remote write denial, and delayed response discard. Temporary homes, browser profile, and listeners were removed by the probe.

The first browser attempt found a real bug: live `self.changed` arrived as a summary frame with `body_summary.path`, not `body.path`. The fixed path is covered by a unit negative/positive and by the real write/read-back probe.

Independent QA verification remains pending for this exact merged candidate; do not mark F-U02 complete from this author report.
