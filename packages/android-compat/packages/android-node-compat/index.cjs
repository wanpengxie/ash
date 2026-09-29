'use strict';
/*
 * android-node-compat -- runtime preload for Node on Android app sandboxes.
 *
 * Load it from the host launcher, before the application entry:
 *
 *   node --expose-internals --require /abs/path/android-node-compat/index.cjs \
 *        <prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js ...
 *
 * It changes no file of the application. Everything is gated on
 * process.platform === 'android' and is a no-op elsewhere. It fixes three
 * platform facts that make portable POSIX code fail on Android:
 *
 * 1. Hard links are refused. In app-private storage (f2fs + SELinux
 *    `untrusted_app`) and on FUSE storage, link(2) fails with EACCES/EPERM
 *    (sometimes EXDEV/ENOTSUP) while rename(2) works. Code that publishes a
 *    new file with link(tmp, dst) ("create, never replace") then fails
 *    outright. The fallback here keeps the no-replace contract: it creates
 *    dst with O_EXCL (COPYFILE_EXCL), so an existing dst still fails with
 *    EEXIST exactly like link(2). Differences: dst is a copy (own inode), and
 *    a concurrent reader may briefly observe a partially written dst.
 *
 * 2. Ancestor directories cannot be opened. Durability code that fsyncs every
 *    ancestor of a data directory up to "/" hits /data, /data/user, ... which
 *    an app may stat but not open (EACCES/EPERM), and read-only system
 *    filesystems (erofs) reject fsync on directories with EINVAL. Directory
 *    fsync is a best-effort durability hint for directories the app does not
 *    own, so opening such a directory read-only yields an inert handle whose
 *    sync()/datasync()/close() succeed, and EINVAL from fsync on a directory
 *    handle is treated as success.
 *
 * 3. No flock addon. `@deepseek-ai/node-addon-system/flock` refuses every
 *    platform except linux/darwin before looking for a binary, so no platform
 *    package can help. A synchronous module resolve hook redirects exactly
 *    that specifier to ./flock.mjs, which emulates exclusive flock within this
 *    process (see that file for the exact contract).
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nodeModule = require('node:module');

const ENABLED = process.platform === 'android' && process.env.ANDROID_NODE_COMPAT_DISABLE !== '1';
const DEBUG = process.env.ANDROID_NODE_COMPAT_DEBUG === '1';
const INSTALLED = Symbol.for('android-node-compat.installed');

function debug(message) {
  if (DEBUG) process.stderr.write(`[android-node-compat] ${message}\n`);
}

const LINK_REFUSED = new Set(['EACCES', 'EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const DIR_OPEN_REFUSED = new Set(['EACCES', 'EPERM']);

function isReadOnlyFlags(flags) {
  if (flags === undefined || flags === null) return true;
  if (typeof flags === 'number') return (flags & 3) === fs.constants.O_RDONLY;
  return flags === 'r' || flags === 'rs' || flags === 'sr';
}

function isDirectoryPath(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function install() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  const fsp = fs.promises;

  // --- 1. link(2) fallback -------------------------------------------------
  const originalLink = fs.link;
  const originalLinkSync = fs.linkSync;
  const originalLinkPromise = fsp.link;
  const EXCL = fs.constants.COPYFILE_EXCL;

  function sourceIsFile(existingPath) {
    try {
      return fs.statSync(existingPath).isFile();
    } catch {
      return false;
    }
  }

  fsp.link = async function link(existingPath, newPath) {
    try {
      return await originalLinkPromise(existingPath, newPath);
    } catch (error) {
      if (!LINK_REFUSED.has(error && error.code) || !sourceIsFile(existingPath)) throw error;
      debug(`link ${error.code}; exclusive copy ${existingPath} -> ${newPath}`);
      await fsp.copyFile(existingPath, newPath, EXCL);
    }
  };
  fs.linkSync = function linkSync(existingPath, newPath) {
    try {
      return originalLinkSync(existingPath, newPath);
    } catch (error) {
      if (!LINK_REFUSED.has(error && error.code) || !sourceIsFile(existingPath)) throw error;
      debug(`linkSync ${error.code}; exclusive copy ${existingPath} -> ${newPath}`);
      fs.copyFileSync(existingPath, newPath, EXCL);
    }
  };
  fs.link = function link(existingPath, newPath, callback) {
    originalLink(existingPath, newPath, (error) => {
      if (!error || !LINK_REFUSED.has(error.code) || !sourceIsFile(existingPath)) return callback(error);
      debug(`link(cb) ${error.code}; exclusive copy ${existingPath} -> ${newPath}`);
      fs.copyFile(existingPath, newPath, EXCL, callback);
    });
  };

  // --- 2. directory open/fsync tolerance -------------------------------------
  const originalOpen = fsp.open;
  let fileHandlePatched = false;

  function patchFileHandle(handle) {
    if (fileHandlePatched || !handle) return;
    fileHandlePatched = true;
    const proto = Object.getPrototypeOf(handle);
    for (const method of ['sync', 'datasync']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = async function (...args) {
        try {
          return await original.apply(this, args);
        } catch (error) {
          if (error && error.code === 'EINVAL') {
            let directory = false;
            try { directory = (await this.stat()).isDirectory(); } catch {}
            if (directory) {
              debug(`${method} EINVAL on a directory handle; treated as success`);
              return undefined;
            }
          }
          throw error;
        }
      };
    }
  }

  function inertDirectoryHandle(target, cause) {
    let closed = false;
    const handle = {
      fd: -1,
      inert: true,
      cause,
      async sync() {},
      async datasync() {},
      async stat(options) { return fsp.stat(target, options); },
      async close() { closed = true; },
      get closed() { return closed; },
    };
    handle[Symbol.asyncDispose] = handle.close;
    return handle;
  }

  fsp.open = async function open(target, flags, mode) {
    let handle;
    try {
      handle = await originalOpen(target, flags, mode);
    } catch (error) {
      if (DIR_OPEN_REFUSED.has(error && error.code) && isReadOnlyFlags(flags) && isDirectoryPath(target)) {
        debug(`open ${error.code} on directory ${target}; returning an inert handle`);
        return inertDirectoryHandle(String(target), error);
      }
      throw error;
    }
    patchFileHandle(handle);
    return handle;
  };

  // --- 3. flock redirect -----------------------------------------------------
  const flockUrl = pathToFileURL(path.join(__dirname, 'flock.mjs')).href;
  const FLOCK_SPECIFIER = '@deepseek-ai/node-addon-system/flock';
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === FLOCK_SPECIFIER) return { url: flockUrl, format: 'module', shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
  } else {
    process.emitWarning('android-node-compat: module.registerHooks is unavailable; flock redirect not installed (needs Node >= 22.15)');
  }

  // Refresh ESM facades of builtins (`import { link } from "node:fs/promises"`).
  nodeModule.syncBuiltinESMExports();
  debug('installed');
}

if (ENABLED) install();

module.exports = { enabled: ENABLED };
