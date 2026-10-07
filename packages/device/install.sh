#!/bin/sh
# Release bootstrap. Does not remove existing state, keys, or workspaces.
set -eu
gateway=${1:?Usage: install.sh GATEWAY PAIR_CODE [setup options]}
pair=${2:?Pairing code required}
shift 2
version=${ASH_DEVICE_VERSION:-0.1.0}
case "$version" in *[!0-9.]*|'') echo "Invalid release version" >&2; exit 1;; esac
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo "macOS or Linux required" >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo "Unsupported CPU" >&2; exit 1;; esac
ash_install_root="$HOME/.ash-device"
ash_stage=$(mktemp -d)
base="https://github.com/wanpengxie/ash/releases/download/device-v$version"
asset="ash-device-$os-$arch.tar.gz"
curl --proto '=https' --tlsv1.2 -fLS "$base/$asset" -o "$ash_stage/$asset"
curl --proto '=https' --tlsv1.2 -fLS "$base/SHA256SUMS" -o "$ash_stage/SHA256SUMS"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$ash_stage/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$ash_stage/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$ash_stage/$asset" | awk '{print $1}'); fi
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "Checksum failed; old install untouched" >&2; exit 1; }
tar -tzf "$ash_stage/$asset" | awk 'index($0,"ash-device/")!=1 || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit bad }'
tar -tvzf "$ash_stage/$asset" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { bad=1 } END { exit bad }'
mkdir -p "$ash_install_root/versions"
ash_release="$ash_install_root/versions/$version-$(date +%s)-$$"
mkdir "$ash_release"
tar -xzf "$ash_stage/$asset" --strip-components=1 -C "$ash_release"
[ "$("$ash_release/node" "$ash_release/ash-device.mjs" --version)" = "$version" ] || { echo "Release startup check failed" >&2; exit 1; }
ln -s "$ash_release" "$ash_install_root/current-$$"
# rename() replaces the link itself, not the directory it points to.
"$ash_release/node" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$ash_install_root/current-$$" "$ash_install_root/current"
exec "$ash_install_root/current/bin/ash-device" setup --root "$ash_install_root" --gateway "$gateway" --pair "$pair" "$@"
