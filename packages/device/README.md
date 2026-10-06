# Device endpoint — work in progress

The first construction slice provides a standalone Node device endpoint, the shared
gateway transport, and workspace tools. It does **not** yet host local agents or
provide an installer, device-management UI, or delegated conversation threads.

## Development

The integration branch temporarily depends on `file:../ash-gateway-device` (gateway
0.5 development). Keep that sibling checkout available, run `npm ci` there, then
run `npm ci` in this repository. Before merging/releasing, replace this dependency
with an approved, published gateway revision and regenerate the lockfile.

Build with `npm run build:device`. Run:

```sh
node packages/device/dist/ash-device.mjs --config /absolute/path/device.json --pair CODE
```

The config contains `gateway`, `name`, optional `kind` (`laptop` or `server`), and
absolute `stateDir` and `workdir` paths. Omit `--pair` on later starts. Pairing must
be approved on the owner side. Revocation stops reconnection and retains the local
key; an explicit new pairing is required to reconnect.

`workspace.poll` is read-only. `workspace.signal` is a separate action. Commands
run under the device's OS account; paths are not sandboxed. Output is kept in a
normal file under the state directory, with a bounded preview and path returned.
Common credentials are redacted in returned text, with `redacted:true` where
applicable; this is display hygiene, not a security boundary.

## Tests

`node --import tsx --test packages/device/test/*.test.ts` covers workspace behavior.
`tools/e2e-device.ts` exercises the actual phone core, pairing, gateway and workspace
against a **fresh local** gateway only. Set `GATEWAY_URL` and a local fixture
`BOOTSTRAP_SECRET`; no model key is needed. The gateway repository also has a
`tunnel-e2e` script covering browser and duplex device traffic.
