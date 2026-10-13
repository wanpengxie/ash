import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalStateFile } from './local-state';

export class NativeListenerEvidenceError extends Error {
  constructor(readonly code: 'unsupported' | 'offline' | 'invalid') { super(`Native listener evidence: ${code}`); }
}
/** Trusted internal metadata only. Not a wire tool or an authorization proof. */
export interface NativeListenerObservation {
  readonly socket: string; readonly executable: string; readonly pid: number; readonly uid: number;
  /** Current OS main image; not a historical exec/continuity credential. */
  readonly main_executable: string;
  readonly process_start: string; readonly socket_identity: string; readonly has_listener: boolean;
  /** Digest of listening kernel addresses observed in this scan. Addresses may
   * be reused after close: this is NOT a generation, continuity proof, or ABA
   * fence across awaits. Raw kernel handles never leave this adapter. */
  readonly listener_identity: string;
  /** Inaccessible unrelated process records, preserving the existing all-visible scope. */
  readonly skipped: number;
}
const directory = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/' : './', import.meta.url));
const requireRelease = createRequire(import.meta.url);
const identity = (s: import('node:fs').BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
type RawObservation = Omit<NativeListenerObservation, 'listener_identity'> & { listener_objects: string[] };
let loaded: { digest: string; module: { observe(socket: string, executable: string, expectedPid: number): RawObservation } } | undefined;
function releaseModule() {
  let fd: number | undefined;
  try {
    if (process.platform !== 'darwin') throw new Error();
    const manifestPath = join(directory, 'listener-evidence.json');
    const manifestStat = lstatSync(manifestPath, { bigint: true });
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1n || (manifestStat.mode & 0o022n) !== 0n) throw new Error();
    const metadata = readLocalStateFile(manifestPath, 4096);
    if (!metadata) throw new Error();
    const m = JSON.parse(metadata.raw);
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['version', 'name', 'platform', 'arch', 'napi', 'sha256'].includes(k)) || m.version !== 1 || m.name !== 'ash-listener-evidence' || m.platform !== process.platform || m.arch !== process.arch || m.napi !== 8 || !Number.isSafeInteger(Number(process.versions.napi)) || Number(process.versions.napi) < m.napi || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error();
    const path = join(directory, 'ash-listener-evidence.node');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 512n * 1024n || (before.mode & 0o022n) !== 0n) throw new Error();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (BigInt(length) !== before.size || !current.isFile() || current.isSymbolicLink() || identity(before) !== identity(after) || identity(after) !== identity(current) || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== m.sha256) throw new Error();
    if (loaded && loaded.digest !== m.sha256) throw new Error(); // A release change requires a new process, not hot code replacement.
    if (!loaded) {
      const module = requireRelease(path);
      if (!module || typeof module.observe !== 'function') throw new Error();
      if (identity(fstatSync(fd, { bigint: true })) !== identity(lstatSync(path, { bigint: true }))) throw new Error();
      loaded = { digest: m.sha256, module };
    }
    return loaded.module;
  } catch { throw new NativeListenerEvidenceError('unsupported'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Fresh full all-visible inspection per call; caches approved CODE only, never OS
 * evidence. The fixed module location derives from this actual release code.
 * Executable --version and existing finalCurrent remain the caller's responsibility. */
export function inspectNativeUnixListener(config: Readonly<{ socket: string; executable: string; expectedPid?: number }>): NativeListenerObservation {
  if (!config || typeof config.socket !== 'string' || typeof config.executable !== 'string' || !isAbsolute(config.socket) || !isAbsolute(config.executable) || /[\u0000-\u001f]/.test(config.socket + config.executable) || config.socket.length > 4096 || config.executable.length > 4096 || (config.expectedPid !== undefined && (!Number.isSafeInteger(config.expectedPid) || config.expectedPid < 1 || config.expectedPid > 2147483647))) throw new NativeListenerEvidenceError('invalid');
  const module = releaseModule();
  try {
    const { listener_objects, ...facts } = module.observe(config.socket, config.executable, config.expectedPid ?? 0);
    if(typeof facts.main_executable!=='string'||!isAbsolute(facts.main_executable)||facts.main_executable!==facts.executable)throw new Error();
    if (!Array.isArray(listener_objects) || listener_objects.length > 32 || listener_objects.some(v => typeof v !== 'string' || !/^[a-f0-9]{16}:[a-f0-9]{16}$/.test(v))) throw new Error();
    return Object.freeze({ ...facts, listener_identity: createHash('sha256').update(JSON.stringify([...listener_objects].sort())).digest('hex') });
  }
  catch (error) { throw new NativeListenerEvidenceError((error as { code?: string }).code === 'invalid' ? 'invalid' : 'offline'); }
}
