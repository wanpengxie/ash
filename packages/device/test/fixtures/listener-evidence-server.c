/* Isolated fixture only; creates its own socket, never opens a user daemon. */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/fileport.h>
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <limits.h>
static int bind_socket(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0); struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) exit(2);
  strcpy(address.sun_path, path);
  if (bind(fd, (void *)&address, sizeof(address)) || listen(fd, 2)) exit(3);
  return fd;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("fixture-server 0.0.1"); return 0; }
  if (argc != 2) return 2;
  int listener = bind_socket(argv[1]); puts("ready"); fflush(stdout);
  int accepted = accept(listener, NULL, NULL); if (accepted < 0) return 4;
  char command[64]; pid_t child = 0;
  while (fgets(command, sizeof(command), stdin)) {
    command[strcspn(command, "\n")] = 0;
    if (!strcmp(command, "fork_listener") || !strcmp(command, "fork_accepted")) {
      child = fork();
      if (child == 0) { if (!strcmp(command, "fork_accepted")) close(listener); for (;;) pause(); }
      printf("%d\n", child);
    } else if (!strcmp(command, "drop")) {
      if (child > 0) { kill(child, SIGTERM); waitpid(child, NULL, 0); child = 0; } puts("done");
    } else if (!strcmp(command, "close")) { close(listener); listener = -1; puts("done");
    } else if (!strcmp(command, "rebind")) {
      /* Allocate before releasing any old listener. When it is still live,
       * these are distinct simultaneous objects, not a generation claim. */
      int previous = listener; unlink(argv[1]); listener = bind_socket(argv[1]);
      if (previous >= 0) close(previous); puts("done");
    } else if (!strcmp(command, "reuse")) {
      int previous = listener; close(listener); listener = -1; int fd = open("/dev/null", O_RDONLY);
      if (fd != previous) { if (dup2(fd, previous) < 0) return 5; close(fd); } puts("done");
    } else if (!strcmp(command, "fileport")) {
      fileport_t port; int result = fileport_makeport(listener, &port);
      if (!result) { close(listener); close(accepted); listener = accepted = -1; } puts(result ? "failed" : "done");
    } else if (!strcmp(command, "exec_mapped")) {
      char helper[PATH_MAX], lfd[32], afd[32];
      if (snprintf(helper, sizeof(helper), "%s.other", argv[0]) >= (int)sizeof(helper)) return 6;
      snprintf(lfd, sizeof(lfd), "%d", listener); snprintf(afd, sizeof(afd), "%d", accepted);
      fcntl(listener, F_SETFD, 0); fcntl(accepted, F_SETFD, 0);
      execl(helper, helper, "--inherited", lfd, afd, argv[0], NULL); return 6;
    } else if (!strcmp(command, "exec")) {
      puts("done"); fflush(stdout); fcntl(listener, F_SETFD, 0); fcntl(accepted, F_SETFD, 0);
      execl("/bin/sleep", "sleep", "5", NULL); return 6;
    } else if (!strcmp(command, "exit")) break;
    fflush(stdout);
  }
  if (child > 0) { kill(child, SIGTERM); waitpid(child, NULL, 0); }
  return 0;
}
