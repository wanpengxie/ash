/* Fixed-release, synchronous Node-API inspector. No network connection, argv,
 * environment, credential or conversation reads. Darwin all-visible scope is
 * intentionally the lsof scope; inaccessible unrelated processes are omitted. */
#define NAPI_VERSION 8
#include <node_api.h>
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#endif

#define MAX_PIDS 65536
#define MAX_FDS 65536
#define MAX_REGIONS 10000
#define MAX_LISTENERS 32
static napi_value failure(napi_env env, const char *code) {
  napi_throw_error(env, code, "Native listener evidence unavailable"); return NULL;
}
#ifdef __APPLE__
struct observation {
  pid_t pid; struct proc_bsdinfo process; struct stat socket, executable_file;
  char socket_path[PATH_MAX], executable[PATH_MAX], main_executable[PATH_MAX];
  unsigned skipped; int listening;
  uint64_t listener_objects[MAX_LISTENERS][2]; unsigned listener_count;
};
static int listener_object(struct observation *out, const struct socket_fdinfo *si) {
  /* Kernel addresses identify the objects in this observation only. Freed
   * addresses can be reused; never interpret them as an allocation generation.
   * SO_ACCEPTCONN selects this supplementary snapshot, NOT the owner set. */
  if (!out || !(si->psi.soi_options & SO_ACCEPTCONN)) return 0;
  for (unsigned i = 0; i < out->listener_count; i++)
    if (out->listener_objects[i][0] == si->psi.soi_so && out->listener_objects[i][1] == si->psi.soi_pcb) return 0;
  if (out->listener_count == MAX_LISTENERS || !si->psi.soi_so || !si->psi.soi_pcb) return -1;
  out->listener_objects[out->listener_count][0] = si->psi.soi_so;
  out->listener_objects[out->listener_count++][1] = si->psi.soi_pcb; return 0;
}
static int canonical_equal(const char *path, const char *expected) {
  char canonical[PATH_MAX]; return realpath(path, canonical) && !strcmp(canonical, expected);
}
static int socket_matches(const struct socket_fdinfo *si, const char *path) {
  if (si->psi.soi_family != AF_UNIX || si->psi.soi_kind != SOCKINFO_UN) return 0;
  const struct sockaddr_un *addr = &si->psi.soi_proto.pri_un.unsi_addr.ua_sun;
  if (addr->sun_family != AF_UNIX || !addr->sun_path[0]) return 0;
  int size = (int)addr->sun_len - (int)offsetof(struct sockaddr_un, sun_path);
  if (size < 1 || size >= (int)sizeof(addr->sun_path)) size = sizeof(addr->sun_path) - 1;
  char name[sizeof(addr->sun_path)]; memcpy(name, addr->sun_path, (size_t)size); name[size] = 0;
  return canonical_equal(name, path);
}
static int expected_failure(pid_t pid, pid_t expected) { return expected && pid == expected; }
/* A bounded fresh FD list, including Mach fileports: fileports can retain a
 * listener after every numeric FD was closed. Never filter owners by listen(). */
static int process_sockets(pid_t pid, pid_t expected, const char *path,
                           int *matched, int *listening, unsigned *skipped, struct observation *objects) {
  errno = 0; int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes < 0 || (bytes == 0 && errno != 0)) {
    if (expected_failure(pid, expected)) return -1;
    (*skipped)++; return 0;
  }
  struct proc_fdinfo *fds = NULL; int got = 0, capacity = bytes;
  for (int retry = 0; retry < 3; retry++) {
    if (capacity < 0 || capacity > MAX_FDS * (int)sizeof(*fds)) { free(fds); return -1; }
    capacity += 32 * (int)sizeof(*fds);
    struct proc_fdinfo *next = realloc(fds, (size_t)capacity);
    if (!next) { free(fds); return -1; } fds = next;
    errno = 0; got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
    if (got < 0 || (got == 0 && errno != 0)) {
      free(fds); if (expected_failure(pid, expected)) return -1; (*skipped)++; return 0;
    }
    if (got < capacity) break;
    if (retry == 2) { free(fds); return -1; }
  }
  if (got % (int)sizeof(*fds)) { free(fds); return -1; }
  for (int i = 0; i < got / (int)sizeof(*fds); i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    struct socket_fdinfo si; errno = 0;
    int n = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &si, sizeof(si));
    if (n != sizeof(si)) {
      if (expected_failure(pid, expected)) { free(fds); return -1; }
      (*skipped)++; continue;
    }
    if (socket_matches(&si, path)) { *matched = 1; if (si.psi.soi_options & SO_ACCEPTCONN) *listening = 1;
      if (listener_object(objects, &si)) { free(fds); return -1; } }
  }
  free(fds);
  errno = 0; bytes = proc_pidinfo(pid, PROC_PIDLISTFILEPORTS, 0, NULL, 0);
  if (bytes == 0 && errno == 0) return 0;
  if (bytes <= 0) { if (expected_failure(pid, expected)) return -1; (*skipped)++; return 0; }
  struct proc_fileportinfo *ports = NULL; capacity = bytes;
  for (int retry = 0; retry < 3; retry++) {
    if (capacity > MAX_FDS * (int)sizeof(*ports)) { free(ports); return -1; }
    capacity += 32 * (int)sizeof(*ports);
    struct proc_fileportinfo *next = realloc(ports, (size_t)capacity);
    if (!next) { free(ports); return -1; } ports = next;
    errno = 0; got = proc_pidinfo(pid, PROC_PIDLISTFILEPORTS, 0, ports, capacity);
    if (got < 0 || (got == 0 && errno != 0)) {
      free(ports); if (expected_failure(pid, expected)) return -1; (*skipped)++; return 0;
    }
    if (got < capacity) break;
    if (retry == 2) { free(ports); return -1; }
  }
  if (got % (int)sizeof(*ports)) { free(ports); return -1; }
  for (int i = 0; i < got / (int)sizeof(*ports); i++) {
    if (ports[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    struct socket_fdinfo si;
    int n = proc_pidfileportinfo(pid, ports[i].proc_fileport, PROC_PIDFILEPORTSOCKETINFO, &si, sizeof(si));
    if (n != sizeof(si)) {
      if (expected_failure(pid, expected)) { free(ports); return -1; }
      (*skipped)++; continue;
    }
    if (socket_matches(&si, path)) { *matched = 1; if (si.psi.soi_options & SO_ACCEPTCONN) *listening = 1;
      if (listener_object(objects, &si)) { free(ports); return -1; } }
  }
  free(ports); return 0;
}
static int mapped_executable(pid_t pid, const char *executable) {
  uint64_t address = 0;
  for (int i = 0; i < MAX_REGIONS; i++) {
    struct proc_regionwithpathinfo info;
    int bytes = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &info, sizeof(info));
    if (bytes != sizeof(info)) return 0;
    if (info.prp_vip.vip_path[0] && canonical_equal(info.prp_vip.vip_path, executable)) return 1;
    uint64_t next = info.prp_prinfo.pri_address + info.prp_prinfo.pri_size;
    if (next <= address) return 0; address = next;
  }
  return 0;
}
static int same_process(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_uid == b->pbi_uid &&
    a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static int same_socket(const struct stat *a, const struct stat *b) {
  return S_ISSOCK(b->st_mode) && a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
/* The main executable is distinct from an arbitrary matching VM region.
 * This is a current OS observation, NOT an exec generation/history proof. */
static int main_executable(pid_t pid, struct observation *out) {
  char path[PROC_PIDPATHINFO_MAXSIZE], canonical[PATH_MAX]; struct stat file;
  memset(path, 0, sizeof(path));
  int bytes = proc_pidpath(pid, path, sizeof(path));
  if (bytes <= 0 || !memchr(path, 0, sizeof(path)) || !realpath(path, canonical) ||
      strcmp(canonical, out->executable) || stat(canonical, &file) || !S_ISREG(file.st_mode)) return -1;
  const struct stat *old = &out->executable_file;
  if (file.st_dev != old->st_dev || file.st_ino != old->st_ino || file.st_size != old->st_size ||
      file.st_mode != old->st_mode || file.st_uid != old->st_uid || file.st_gid != old->st_gid || file.st_nlink != old->st_nlink ||
      file.st_mtimespec.tv_sec != old->st_mtimespec.tv_sec || file.st_mtimespec.tv_nsec != old->st_mtimespec.tv_nsec ||
      file.st_ctimespec.tv_sec != old->st_ctimespec.tv_sec || file.st_ctimespec.tv_nsec != old->st_ctimespec.tv_nsec) return -1;
  if (out->main_executable[0] && strcmp(out->main_executable, canonical)) return -1;
  strcpy(out->main_executable, canonical); return 0;
}
static int inspect(const char *socket, const char *executable, pid_t expected, struct observation *out) {
  memset(out, 0, sizeof(*out));
  if (!realpath(socket, out->socket_path) || !realpath(executable, out->executable) ||
      stat(out->socket_path, &out->socket) || !S_ISSOCK(out->socket.st_mode) ||
      stat(out->executable, &out->executable_file) || !S_ISREG(out->executable_file.st_mode)) return -1;
  if (expected && main_executable(expected, out)) return -1;
  int capacity = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0), got = 0; pid_t *pids = NULL;
  for (int retry = 0; retry < 3; retry++) {
    if (capacity <= 0 || capacity > MAX_PIDS * (int)sizeof(*pids)) { free(pids); return -1; }
    capacity += 32 * (int)sizeof(*pids);
    pid_t *next = realloc(pids, (size_t)capacity);
    if (!next) { free(pids); return -1; } pids = next;
    got = proc_listpids(PROC_ALL_PIDS, 0, pids, capacity);
    if (got <= 0 || got % (int)sizeof(*pids)) { free(pids); return -1; }
    if (got < capacity) break;
    if (retry == 2) { free(pids); return -1; }
  }
  int owners = 0, expected_seen = !expected;
  for (int i = 0; i < got / (int)sizeof(*pids); i++) {
    pid_t pid = pids[i]; if (pid <= 0) continue;
    struct proc_taskallinfo info;
    int bytes = proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, &info, sizeof(info));
    if (bytes != sizeof(info)) {
      if (expected_failure(pid, expected)) { free(pids); return -1; }
      out->skipped++; continue;
    }
    if (pid == expected) expected_seen = 1;
    int matched = 0, listening = 0;
    if (process_sockets(pid, expected, out->socket_path, &matched, &listening, &out->skipped, NULL)) { free(pids); return -1; }
    if (matched) {
      if (main_executable(pid, out)) { free(pids); return -1; }
      owners++; out->pid = pid; out->process = info.pbsd; out->listening = listening;
      if (owners > 1) { free(pids); return -1; }
    }
  }
  free(pids);
  if (owners != 1 || !expected_seen || (expected && expected != out->pid) || !mapped_executable(out->pid, out->executable)) return -1;
  /* Selected owner must remain visible, fully inspectable and in the same
   * process incarnation after the global enumeration and VM identity read. */
  struct proc_bsdinfo after; struct stat socket_after; int matched = 0, listening = 0;
  if (proc_pidinfo(out->pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after) ||
      !same_process(&out->process, &after) || process_sockets(out->pid, out->pid, out->socket_path, &matched, &listening, &out->skipped, out) ||
      !matched || stat(out->socket_path, &socket_after) || !same_socket(&out->socket, &socket_after) ||
      main_executable(out->pid, out)) return -1;
  out->listening = listening; return 0;
}
static int input(napi_env env, napi_value value, char *buffer, size_t capacity) {
  napi_valuetype kind; size_t bytes;
  if (napi_typeof(env, value, &kind) != napi_ok || kind != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &bytes) != napi_ok || bytes < 1 || bytes >= capacity ||
      napi_get_value_string_utf8(env, value, buffer, capacity, &bytes) != napi_ok || strlen(buffer) != bytes || buffer[0] != '/') return 0;
  return 1;
}
static int set_string(napi_env env, napi_value object, const char *key, const char *value) {
  napi_value text; return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &text) == napi_ok && napi_set_named_property(env, object, key, text) == napi_ok;
}
static int set_number(napi_env env, napi_value object, const char *key, double value) {
  napi_value number; return napi_create_double(env, value, &number) == napi_ok && napi_set_named_property(env, object, key, number) == napi_ok;
}
#endif
static napi_value observe(napi_env env, napi_callback_info callback) {
#ifndef __APPLE__
  (void)callback; return failure(env, "unsupported");
#else
  size_t argc = 3; napi_value args[3];
  if (napi_get_cb_info(env, callback, &argc, args, NULL, NULL) != napi_ok || argc != 3) return failure(env, "invalid");
  char socket[PATH_MAX], executable[PATH_MAX]; int64_t expected;
  if (!input(env, args[0], socket, sizeof(socket)) || !input(env, args[1], executable, sizeof(executable)) ||
      napi_get_value_int64(env, args[2], &expected) != napi_ok || expected < 0 || expected > INT_MAX) return failure(env, "invalid");
  struct observation out;
  if (inspect(socket, executable, (pid_t)expected, &out)) return failure(env, "offline");
  char incarnation[96], identity[192];
  snprintf(incarnation, sizeof(incarnation), "%llu:%llu", (unsigned long long)out.process.pbi_start_tvsec, (unsigned long long)out.process.pbi_start_tvusec);
  snprintf(identity, sizeof(identity), "%llu:%llu:%lld:%ld", (unsigned long long)out.socket.st_dev, (unsigned long long)out.socket.st_ino,
           (long long)out.socket.st_ctimespec.tv_sec, out.socket.st_ctimespec.tv_nsec);
  napi_value result, listening, objects;
  if (napi_create_object(env, &result) != napi_ok || !set_string(env, result, "socket", out.socket_path) ||
      !set_string(env, result, "executable", out.executable) || !set_string(env, result, "process_start", incarnation) ||
      !set_string(env, result, "main_executable", out.main_executable) ||
      !set_string(env, result, "socket_identity", identity) || !set_number(env, result, "pid", out.pid) ||
      !set_number(env, result, "uid", out.process.pbi_uid) || !set_number(env, result, "skipped", out.skipped) ||
      napi_get_boolean(env, out.listening, &listening) != napi_ok || napi_set_named_property(env, result, "has_listener", listening) != napi_ok) return failure(env, "offline");
  if (napi_create_array_with_length(env, out.listener_count, &objects) != napi_ok) return failure(env, "offline");
  for (unsigned i = 0; i < out.listener_count; i++) {
    char object[40]; napi_value value;
    snprintf(object, sizeof(object), "%016llx:%016llx", (unsigned long long)out.listener_objects[i][0], (unsigned long long)out.listener_objects[i][1]);
    if (napi_create_string_utf8(env, object, NAPI_AUTO_LENGTH, &value) != napi_ok || napi_set_element(env, objects, i, value) != napi_ok) return failure(env, "offline");
  }
  if (napi_set_named_property(env, result, "listener_objects", objects) != napi_ok) return failure(env, "offline");
  return result;
#endif
}
NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "observe", NAPI_AUTO_LENGTH, observe, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "observe", function) != napi_ok) return failure(env, "unsupported");
  return exports;
}
