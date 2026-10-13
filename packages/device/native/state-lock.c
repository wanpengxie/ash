/* ash-state-lock: no pathname input, no configuration bytes, no retained child process.
 * flock locks the inherited open-file description. Parent fd remains open after this
 * process exits, so the lock remains until the parent closes it or dies. */
#include <errno.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#if !defined(__APPLE__) && !defined(__linux__)
#error "ash-state-lock supports macOS and Linux only"
#endif
int main(int argc, char **argv) {
  (void)argv;
  struct stat st;
  if (argc != 1 || fstat(3, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size != 0 || (st.st_mode & 077) != 0) return 3;
  if (flock(3, LOCK_EX | LOCK_NB) != 0) return errno == EWOULDBLOCK || errno == EAGAIN ? 2 : 3;
  if (fputs("ash-state-lock/1 acquired\n", stdout) == EOF || fflush(stdout) != 0) return 3;
  return 0;
}
