// ash payload patch (replaces npm's node_modules/bin-links/lib/fix-bin.js; the assembler checks
// the original's sha256 first and refuses to build if npm changed it).
//
// Why: package bins start with `#!/usr/bin/env node`, and Android has no /usr/bin/env (it is
// /system/bin/env), so every CLI npm installs — `npm i -g`, local .bin, and everything `npx`
// runs (most MCP servers) — fails with ENOENT. Upstream npm only chmods and fixes CRLF on Unix.
// On Android this also rewrites the interpreter path at install time: /usr/bin/env → /system/bin/env,
// /bin/sh (absent before Android 10) → /system/bin/sh, /bin/bash → the runtime's bash via env.
//
// make sure that bins are executable, and that they don't have
// windows line-endings on the hashbang line.
const {
  chmod,
  open,
  readFile,
} = require('fs/promises')

const execMode = 0o777 & (~process.umask())

const writeFileAtomic = require('write-file-atomic')

const isWindowsHashBang = buf =>
  buf[0] === '#'.charCodeAt(0) &&
  buf[1] === '!'.charCodeAt(0) &&
  /^#![^\n]+\r\n/.test(buf.toString())

const ANDROID_HASHBANG = /^#!\s*\/(usr\/bin\/env|bin\/sh|bin\/bash)(?=[\s\n])/

const hashbangNeedsFix = buf =>
  isWindowsHashBang(buf) ||
  (process.platform === 'android' && ANDROID_HASHBANG.test(buf.toString('latin1', 0, 256)))

const needsFixFile = file => {
  const FALSE = () => false
  return open(file, 'r').then(fh => {
    const buf = Buffer.alloc(2048)
    return fh.read(buf, 0, 2048, 0)
      .then(
        () => {
          const fix = hashbangNeedsFix(buf)
          return fh.close().then(() => fix, () => fix)
        },
        // don't leak FD if read() fails
        () => fh.close().then(FALSE, FALSE)
      )
  }, FALSE)
}

const rewrite = file =>
  readFile(file, 'latin1').then(content => {
    let out = content.replace(/^(#![^\n]+)\r\n/, '$1\n')
    if (process.platform === 'android') {
      out = out.replace(/^#!\s*\/usr\/bin\/env(?=[\s\n])/, '#!/system/bin/env')
        .replace(/^#!\s*\/bin\/sh(?=[\s\n])/, '#!/system/bin/sh')
        .replace(/^#!\s*\/bin\/bash(?=[\s\n])/, '#!/system/bin/env bash')
    }
    return out === content ? null : writeFileAtomic(file, out, 'latin1')
  })

const fixBin = (file, mode = execMode) => chmod(file, mode)
  .then(() => needsFixFile(file))
  .then(fix => fix ? rewrite(file) : null)

module.exports = fixBin
