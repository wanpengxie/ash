/*
 * Drop-in for `@deepseek-ai/node-addon-system/flock` on Android.
 *
 * Upstream's tryLockExclusive(fd) calls flock(fd, LOCK_EX | LOCK_NB) through a
 * native addon that is only published for linux/darwin and whose loader
 * rejects every other platform up front.
 *
 * Contract kept here: acquisition is exclusive per open file description
 * inside this process. A second descriptor on the same inode, while the first
 * is still open, is refused with EWOULDBLOCK (code 'EAGAIN'/'EWOULDBLOCK',
 * syscall 'flock'), matching what the kernel returns for contended flock.
 * Closing the holding descriptor releases the lock.
 *
 * Not kept: exclusion against OTHER processes. The Android host runs a single
 * engine process per data directory, which is the precondition for using this.
 */
import { fstatSync } from 'node:fs';
import { constants } from 'node:os';

/** key "dev:ino" -> { fd, dev, ino } of the current holder. */
const holders = new Map();

function identity(fd) {
  const stat = fstatSync(fd, { bigint: true });
  return { key: `${stat.dev}:${stat.ino}`, dev: stat.dev, ino: stat.ino };
}

function stillHolds(holder) {
  try {
    const stat = fstatSync(holder.fd, { bigint: true });
    return stat.dev === holder.dev && stat.ino === holder.ino;
  } catch {
    return false; // EBADF: the holder closed its descriptor
  }
}

function contended() {
  const errno = constants.errno.EWOULDBLOCK ?? constants.errno.EAGAIN;
  return Object.assign(new Error('EAGAIN: flock failed'), {
    code: 'EAGAIN',
    errno,
    syscall: 'flock',
  });
}

/**
 * @param {number} fd open descriptor; ownership stays with the caller.
 * @returns {Promise<void>} resolves on acquisition, rejects with EAGAIN on contention.
 */
export async function tryLockExclusive(fd) {
  if (!Number.isInteger(fd) || fd < 0) {
    throw Object.assign(new Error('EBADF: flock failed'), { code: 'EBADF', errno: constants.errno.EBADF, syscall: 'flock' });
  }
  const id = identity(fd);
  const holder = holders.get(id.key);
  if (holder !== undefined && holder.fd !== fd && stillHolds(holder)) throw contended();
  holders.set(id.key, { fd, dev: id.dev, ino: id.ino });
}
