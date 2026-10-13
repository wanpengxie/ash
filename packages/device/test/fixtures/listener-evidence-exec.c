/* Isolated main-image regression fixture. Holds/maps only supplied temp files. */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
int main(int argc, char **argv) {
  int listener, accepted, image; const char *mapped;
  if (argc == 5 && !strcmp(argv[1], "--inherited")) {
    listener = atoi(argv[2]); accepted = atoi(argv[3]); mapped = argv[4];
  } else if (argc == 3) {
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    if (strlen(argv[1]) >= sizeof(address.sun_path)) return 2;
    strcpy(address.sun_path, argv[1]); listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0 || bind(listener, (void *)&address, sizeof(address)) || listen(listener, 2)) return 3;
    accepted = -1; mapped = argv[2];
  } else return 2;
  image = open(mapped, O_RDONLY); struct stat file;
  if (image < 0 || fstat(image, &file) || file.st_size <= 0) return 4;
  void *region = mmap(NULL, (size_t)file.st_size, PROT_READ, MAP_PRIVATE, image, 0);
  if (region == MAP_FAILED) return 5;
  puts("mapped-ready"); fflush(stdout);
  char command[64]; while (fgets(command, sizeof(command), stdin)) {
    if (!strcmp(command, "exit\n")) break;
    puts("done"); fflush(stdout);
  }
  munmap(region, (size_t)file.st_size); close(image); close(listener); if (accepted >= 0) close(accepted); return 0;
}
