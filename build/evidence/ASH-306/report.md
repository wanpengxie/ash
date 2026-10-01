# ASH-306 narrow administration runtime checkpoint

This checkpoint implements only the approved pause/resume slice of `service:admin`. The SDK contracts are strict: pause is `{}` or `{by: message_id}` and resume is `{confirmed:true}`. Settings, plugin, gateway, and model mutations are **not** registered as successful production routes; this avoids logging opaque credentials or accepting arbitrary installation inputs while their safe contracts remain unspecified.

The router admits a plain pause only from a currently authenticated local owner. A reflex pause requires a trusted local `service:reflex` caller and a cited, non-migrated, locally authenticated owner `say` request to `agent:main`; it rechecks that source's current credential before acceptance and during recovery. `Ledger.append` inserts the request, retry mapping, tracked context, and a unique consumed-`by` claim in one SQLite transaction. A different client ID cannot consume the same source again, including after resume or restart; an identical client-ID retry returns the original acceptance without rerunning the effect. Rejected source/transport combinations leave no ledger row.

The one durable pause fact is JSON boolean `kv['v2:admin:paused']`; absence means false and malformed values fail closed. The admin journal applies each accepted request ID once, with an increasing ledger-sequence guard against older commands overtaking newer ones. A pause prevents new main turns and requests cancellation of the active turn. Agent intake may still durably ACK and queue owner messages while paused. Resume requires an authenticated local owner web screen with explicit confirmation. At effect time the handler rechecks the current, unexpired ScreenRegistry binding against the original trusted transport principal, without requiring online/visible status. A previously accepted resume cannot clear pause if that binding expires before execution; any stranded resume on process recovery fails closed and requires a new screen request.

Focused synthetic tests cover competing reflex claims, same-ID ACK retry, cross-restart reuse, revoked original credential, remote/API/device/agent negative cases with zero acceptance, stale resume recovery, effect-time screen expiry, and an active/queued agent-turn transition. A production `startOwner` echo + real HTTP test checks pause, queued `say`, API and remote-screen rejection, and local registered-screen resume. These tests use temporary state and do not modify a user home, real device, or external gateway.

Reproduce from this checkout:

```sh
node --import tsx --test packages/core/test/members/admin.test.ts packages/core/test/members/admin-host.test.ts
npm run -s typecheck
npm run -s build:core
npm test
ASH_TEST_DSH_ROOT=/path/to/installed/@deepseek-ai/dsh npm test
npm run -s test:public-terms -- --terms-file "$PRIVATE_TERMS_FILE"
```

At this checkpoint: focused 7/7; typecheck and core build pass; default full suite 283 pass/66 conditional skip; full suite with an installed real DSH runtime 290 pass/59 conditional skip; private-term scan 0 findings across 434 public files. All suites exited naturally.

This is a partial card, not F-S26/F-S27 or plugin R16 acceptance. There is no production `service:reflex` member yet, no Android pause/resume end-to-end, and no claim that all legacy settings operations are safely represented as words. The real DSH tests exercise existing session behavior, not a complete new cross-service pause workflow. Independent QA and later UI/Android/senses/clock integration remain required.
