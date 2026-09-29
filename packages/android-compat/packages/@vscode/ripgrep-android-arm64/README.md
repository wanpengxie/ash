# @vscode/ripgrep-android-arm64

Why: `@vscode/ripgrep` 1.18 resolves its binary as
`require.resolve("@vscode/ripgrep-${process.platform}-${arch}/bin/rg")`.
Upstream publishes no Android package, so on Android (`process.platform ===
'android'`) the import throws "Could not find @vscode/ripgrep-android-arm64" and
every grep/glob tool of `@deepseek-ai/dsh-tool-fs-search` fails with
SEARCH_FAILED.

This package is that missing platform package. It contains no code: `bin/rg`
is a relative symlink to the ripgrep executable shipped in the payload runtime
(Termux `ripgrep`, bionic, RUNPATH `$ORIGIN/../lib` for libpcre2-8.so).
`require.resolve` returns the symlink's real path, which is what gets spawned.

Placement: `<payload>/dsh/lib/node_modules/@vscode/ripgrep-android-arm64/`
(a sibling of `@deepseek-ai/`, found by Node's upward `node_modules` walk from
`.../@deepseek-ai/dsh/node_modules/@vscode/ripgrep/lib/`). Nothing under
`@deepseek-ai/` is modified. If the payload layout changes, re-point the link
(or replace it with a copy of the binary, mode 0755).

Do not add an `exports` field: the resolver asks for the `bin/rg` subpath.
