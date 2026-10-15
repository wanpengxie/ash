# Updates over the air

Three things are updated without a cable or a manual install: Ash on the phone (two packages, the app `ai.ash.agent` and
the kernel `ai.ash.kernel`), the computer program (`ash-device`) on paired computers, and a relay that runs on a server of
the owner's (the self-hosted gateway). Downloads come from GitHub release pages only; there is no mirror. A device that
cannot reach GitHub uses a proxy of its own (`HTTPS_PROXY` / `NO_PROXY`). Every download is checked against the SHA-256
its release publishes, before anything is replaced; a failed check changes nothing.

| | Published where | Who triggers | Checked against | When it fails |
|---|---|---|---|---|
| Phone | GitHub release `v<version>` of the phone's release repository (`PHONE_RELEASES`): `app-<version>.apk`, `kernel-<version>.apk`, `SHA256SUMS` | the owner or an agent: `service:host update.install {version}` | the release's `SHA256SUMS`, read by the hub | nothing is installed when a download or check fails; Android refuses a package of another signature |
| Computer | GitHub release `device-v<version>` of `wanpengxie/ash`: `ash-device-<platform>.tar.gz`, `SHA256SUMS`, `install.sh` | automatic when a computer older than the hub's release connects (`devices.auto_update`, default on); `service:devices update {device}`; a trusted 4008 for a computer too old to talk with | the checksums built into the hub (`packages/sdk/src/device-assets.generated.ts`) | the installed version stays (`installRelease` switches a symlink only after the check and a startup check) |
| Self-hosted relay | GitHub release `v<version>` of `wanpengxie/ash-gateway`: `ash-gateway.mjs`, `wrangler.jsonc`, `upgrade.sh`, `SHA256SUMS` | an agent through the server's body: `/opt/ash-relay/bin/upgrade.sh <version>` | the release's `SHA256SUMS` | the previous release is switched back and restarted when `/v1/health` does not report the new version within 90 s |

The relay on Cloudflare is deployed from the gateway repository's main branch; it is not covered here.

## Releasing

**Computer program.** Set `DEVICE_VERSION` in `packages/sdk/src/versions.ts`, then `npm run build:device && node
tools/package-device.mjs --all`. This writes `build/device/` (the four packages, `SHA256SUMS`, `install.sh`) and
`packages/sdk/src/device-assets.generated.ts` (the version and the four checksums). Publish `build/device/*` exactly as
built as release `device-v<version>`, and commit the generated file. The packages are not reproducible byte for byte:
the hub must be built after this, from the same files (`packages/sdk/test/versions.test.ts` fails when the generated file
names another version than `DEVICE_VERSION`). `DEVICE_MIN_VERSION` moves only when the hub can no longer talk with older
programs.

**Phone.** Build the hub and the two APKs as usual, then publish release `v<version>` with `app-<version>.apk`,
`kernel-<version>.apk` and `SHA256SUMS` (`sha256sum app-<version>.apk kernel-<version>.apk > SHA256SUMS`). The release
repository is private: the hub reads it through the GitHub API with the vault entry `GITHUB_TOKEN` (a read-only token).

**Relay.** Set the version in `package.json` and `GATEWAY_VERSION` in `src/hub.ts` (a test keeps them equal), merge, and
push the tag `v<version>`: the release workflow builds and publishes the files and their `SHA256SUMS`.

## Phone

`service:host update.install {version?}` (without a version: the latest release).

1. The hub reads the release and its `SHA256SUMS` (with `GITHUB_TOKEN` through api.github.com when there is one, else the
   public download pages) and names each package's address and checksum.
2. The host (capability `update`) starts a job and answers at once with `via`. The job downloads each APK to its own
   directory, checks it, and only when both are good installs them: the app first, the kernel last.
   - `via: "shell"`, with the debug identity: `pm install -r`. Installing the kernel replaces the package the shell host's
     bridge lives in; the old host then starts the new build's host itself (as wireless debugging would), which takes over
     from the kernel service's own core. The boot receiver waits 20 s before asking the owner to reconnect.
   - `via: "installer"`, without it: a `PackageInstaller` session per package. The system's confirmation is put in a
     notification; the owner taps it and then 「安装」. The first time, Android also asks to let the kernel install apps.
3. `service:host update.status` reports `downloading`, `installing`, `waiting_user`, `done` or `failed` with a message.
   Installing the kernel restarts the hub; the version after reconnecting is the proof.

The token is sent to api.github.com only: the asset's redirect to signed storage is followed without it. It is handed to
the host in the host call, never in a word's body, so it is not in the ledger, and the host does not log it.

## Computer

- The hub carries its release: `DEVICE_ASSETS` (version and the SHA-256 per platform). `service:devices update {device}`
  installs it with the checksum for the computer's platform; `version` and `sha256` may still be given for another release.
- When a computer's manifest arrives and its version is older than `DEVICE_ASSETS.version`, the hub sends `x.ash.update`
  itself, once per hub run (setting `devices.auto_update`, default on).
- A computer older than `DEVICE_MIN_VERSION` is closed with 4008 inside TLS, and the `!close` line carries
  `update: {version, sha256: {<platform>: …}}` (packages/link/src/secure.ts). The computer installs it, then restarts. A 4008
  that comes in the clear (the relay's) is only a lost connection and installs nothing. So that a computer of an older
  link protocol can still get into TLS to hear this, the announcement before TLS names `LINK_TUNNEL`, which stays put when
  `LINK_PROTOCOL` moves on.
- The program downloads with Node's `fetch`. `bin/ash-device` sets `NODE_USE_ENV_PROXY=1` when a proxy variable is set
  (Node 22 honours `HTTPS_PROXY` / `NO_PROXY` only then), and `ash-device setup` writes the proxy variables of its shell into
  the service definition.
- Rollback: `installRelease` stages the release, checks the archive and runs the new program's `--version` before it moves
  the `current` symlink; a failure leaves the running version in place.

## Self-hosted relay

`scripts/self-host/` in the gateway repository: the systemd unit (workerd through `wrangler dev`, state in
`/var/lib/ash-relay`), nginx for 443 and 80, certificate renewal, and `upgrade.sh <version>`, which downloads the release
files, checks them, switches `/opt/ash-relay/current`, restarts and waits for `/v1/health` to report the version, and rolls
back otherwise. The relay's state is outside the release folders, so devices stay paired across upgrades. When the server
is a paired computer with a body, Ash runs the script there itself (skill `upgrade`).
