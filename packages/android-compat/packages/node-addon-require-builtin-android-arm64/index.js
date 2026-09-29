'use strict';
/*
 * node-addon-require-builtin-android-arm64 -- pure-JS platform binding.
 *
 * Why: `node-addon-require-builtin` loads a per-platform optional package named
 * `node-addon-require-builtin-<platform>-<arch>` through
 * `node-addon-native-custom-loader`. Upstream only publishes darwin, linux-gnu
 * and win32 prebuilds, so on Android (process.platform === 'android') the
 * loader looks for `node-addon-require-builtin-android-arm64`, finds nothing,
 * and `dsh-app-boot` dies with "host preparation failed: No usable native
 * binding found ...".
 *
 * This package is that platform package. Instead of a .node file it exposes
 * the same three functions the loader validates (requireBuiltin,
 * isAllowedInternalId, getNativeBindingInfo -> backend 'napi', abi 'napi-v9'),
 * implemented with Node's own `--expose-internals` switch. The host launcher
 * must therefore start node with `--expose-internals` on the command line
 * (Node refuses that flag inside NODE_OPTIONS).
 *
 * Semantics mirror the upstream "unrestricted" variant: any builtin id,
 * including `internal/...`, is forwarded to the builtin loader and
 * isAllowedInternalId() always returns true.
 *
 * Placement: anywhere on the Node resolution path of
 * `node-addon-native-custom-loader`, e.g. `<prefix>/lib/node_modules/`
 * as a sibling of `@deepseek-ai/`. No file of the DSH install is touched.
 */
const { createRequire, isBuiltin } = require('node:module');

const requireFromHere = createRequire(__filename);

// The loader contract: 'napi' backend with the ABI tag the loader computes
// for napi (NAPI_VERSION '9' in node-addon-native-custom-loader 0.1.x).
const NAPI_ABI = 'napi-v9';

function internalsReachable() {
  try {
    requireFromHere('internal/options');
    return true;
  } catch {
    return false;
  }
}

// Fail at load time, so the loader records a clear attempt message instead of
// handing out a binding that breaks on first use.
if (!internalsReachable()) {
  const error = new Error(
    'node-addon-require-builtin-android-arm64: Node internals are not reachable; ' +
    'start node with --expose-internals on the command line (NODE_OPTIONS cannot carry it)');
  error.code = 'ERR_ANDROID_REQUIRE_BUILTIN_NO_INTERNALS';
  throw error;
}

function requireBuiltin(moduleId) {
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new TypeError('requireBuiltin(moduleId): moduleId must be a non-empty string');
  }
  const bare = moduleId.startsWith('node:') ? moduleId.slice(5) : moduleId;
  // Never fall through to node_modules resolution: builtins only.
  if (!bare.startsWith('internal/') && !isBuiltin(bare)) {
    const error = new Error(`No such built-in module: ${moduleId}`);
    error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw error;
  }
  return requireFromHere(bare);
}

function isAllowedInternalId(_moduleId) {
  return true;
}

const info = Object.freeze({
  mode: 'napi',
  product: 'require-builtin',
  backend: 'napi',
  abi: NAPI_ABI,
});

function getNativeBindingInfo() {
  return info;
}

module.exports = { requireBuiltin, isAllowedInternalId, getNativeBindingInfo };
// The loader prefers binding.bindingPath over require.resolve() for diagnostics.
Object.defineProperty(module.exports, 'bindingPath', {
  value: __filename,
  enumerable: false,
  configurable: true,
});
