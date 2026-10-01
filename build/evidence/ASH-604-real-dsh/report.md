# Real runtime conversation probe

This test uses the production owner bootstrap and an installed session runtime. A scripted local model endpoint drives two `ash_say` calls and two `ash_react` calls in one turn. The browser is an isolated headless Chrome profile. All state, workspace files, and model requests remain in temporary directories or loopback listeners; no existing app profile, account, or device is used.

## Reproduce

```sh
ASH_TEST_DSH_ROOT=<installed-runtime-directory> node --expose-internals --import tsx packages/core/ui/test/dsh-conversation-browser-probe.mjs
npm run -s typecheck
npm run -s build:core
ASH_TEST_DSH_ROOT=<installed-runtime-directory> npm test
```

The probe needs Chrome at `/opt/google/chrome/chrome`, or `ASH_PROBE_CHROME` set to another Chrome binary. `ASH_TEST_DSH_ROOT` is read-only; the test never modifies that installation. The probe closes its model listener, owner server, runtime, and Chrome process, then removes only its own temporary directory.

## Observed

- Two consecutive `ash_say` requests produced two grouped assistant bubbles in the same durable turn. A valid `ash_react` attached to the source owner bubble; a second reaction to a missing id returned `not_found` and created no extra visible reaction.
- The owner bubble showed sending, delivered, and read in order, with acceptance and receipt boundaries held independently in the test.
- After an offline/online network transition and page reload, the browser resubscribed to the event stream. The two assistant bubbles and one reaction appeared exactly once.
- A later turn called a controlled device operation that stayed unresolved. The browser sent a stop message; the turn had one cancelled terminal while the device was still pending. Releasing the device did not produce a second tool response or an assistant say attributed to the cancelled turn.
- The probe passed twice. Typecheck and core build passed. The installed-runtime full suite reported 436 tests: 377 passed, 59 intentional skips, 0 failed. The public-term scan found 0 findings across 502 files.

## Not established

Chrome's network-offline emulation did not update the connection indicator within 20 seconds. This probe establishes reload/reconnect replay deduplication, not immediate offline-indicator timing. Existing separate browser tests cover queued offline sends. It does not exercise Android WebView, a remote screen, a physical device, unrestricted native tools, or external provider credentials. Those remain separate acceptance boundaries; this result does not complete the whole conversation card.
