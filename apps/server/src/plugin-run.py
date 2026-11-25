#!/usr/bin/env python3
# Runs a plugin's program with nothing of the service in reach, and ends what it leaves running.
#
#   plugin-run.py --probe                exits with 97 where this system cannot confine a program
#   plugin-run.py READABLE... --write WRITABLE... -- PROGRAM ARGS...
#
# Landlock, which the Linux kernel offers any process to restrict itself (5.13 and later, where enabled), keeps the
# program to the files given and from tracing other processes, and from its sixth version on from sending them
# signals. What it leaves to every process of the same user a system call filter takes: unix sockets, by which
# another process's are reached through their path, such as the shared SSH connection to a computer; the modes,
# owners and watching of files; and the limits and scheduling of other processes.
#
# This itself runs unconfined and is to be started isolated (python3 -I): what is in the program's home directory
# must not be loaded here.
import ctypes
import errno
import os
import platform
import signal
import struct
import sys
import time

UNAVAILABLE = 97
CREATE, ADD, RESTRICT = 444, 445, 446
PDEATHSIG, SECCOMP, CHILD_SUBREAPER, NO_NEW_PRIVS = 1, 22, 36, 38
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

# System calls by their numbers on x86-64 and on arm64, where it has them.
MACHINES = {'x86_64': (0xC000003E, 0), 'aarch64': (0xC00000B7, 1)}
SOCKET, PRLIMIT = (41, 198), (302, 261)
REFUSED = [
    (425, 425),  # io_uring_setup, whose operations no filter sees
    (76, 45),  # truncate, which Landlock knows from its third version on
    (254, 27), (301, 263),  # inotify_add_watch, fanotify_mark
    (188, 5), (189, 6), (463, 463), (197, 14), (198, 15), (466, 466),  # setxattr and removexattr by path
    (141, 140), (142, 118), (144, 119), (203, 122), (314, 274), (251, 30),  # priorities and scheduling
    (248, 217), (249, 218), (250, 219),  # keyrings
]  # fmt: skip
# Done as far as the program can tell, as copying a file sets its mode: chmod, chown and lchown, and their *at.
PRETENDED = [(90, None), (268, 53), (452, 452), (92, None), (94, None), (260, 54)]
FAMILIES = [2, 10, 16]  # IPv4, IPv6, netlink


def call(*args):
    result = libc.syscall(*args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def prctl(*args):
    if libc.prctl(*(ctypes.c_ulong(arg) if isinstance(arg, int) else arg for arg in args)) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def landlock(readable, writable):
    version = call(ctypes.c_long(CREATE), None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    # Every filesystem right this kernel knows, so that none stays unrestricted.
    handled = (1 << 13) - 1
    for since, right in ((2, 13), (3, 14), (5, 15)):  # REFER, TRUNCATE, IOCTL_DEV
        if version >= since:
            handled |= 1 << right
    file_rights = handled & (1 | 2 | 4 | 1 << 14 | 1 << 15)
    fields = (handled, 0, 1 | 2) if version >= 6 else (handled,)
    packed = struct.pack(f'{len(fields)}Q', *fields)
    attribute = ctypes.create_string_buffer(packed, len(packed))
    ruleset = call(ctypes.c_long(CREATE), attribute, ctypes.c_size_t(len(packed)), ctypes.c_uint32(0))
    given = [(path, 1 | 4 | 8) for path in readable] + [(path, handled) for path in writable]
    for path, rights in given:
        path = os.path.realpath(path)
        try:
            descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError:
            continue
        rights = rights if os.path.isdir(path) else rights & file_rights
        rule = ctypes.create_string_buffer(struct.pack('=Qi', rights, descriptor))
        call(ctypes.c_long(ADD), ctypes.c_int(ruleset), ctypes.c_int(1), rule, ctypes.c_uint32(0))
        os.close(descriptor)
    call(ctypes.c_long(RESTRICT), ctypes.c_int(ruleset), ctypes.c_uint32(0))
    os.close(ruleset)


def filter_calls():
    arch, column = MACHINES[platform.machine()]
    LOAD, EQUAL, AT_LEAST, RETURN = 0x20, 0x15, 0x35, 0x06
    NUMBER, ARCH, ARGUMENT = 0, 4, 16
    ALLOW, REFUSE, PRETEND = 0x7FFF0000, 0x00050000 | errno.EPERM, 0x00050000
    KILL = 0x80000000
    # (code, jump when true, jump when false, value)
    code = [(LOAD, 0, 0, ARCH), (EQUAL, 1, 0, arch), (RETURN, 0, 0, KILL), (LOAD, 0, 0, NUMBER)]
    code += [(AT_LEAST, 0, 1, 0x40000000), (RETURN, 0, 0, REFUSE)]  # the other numbers of x86-64
    for calls, result in ((REFUSED, REFUSE), (PRETENDED, PRETEND)):
        for numbers in calls:
            if numbers[column] is not None:
                code += [(EQUAL, 0, 1, numbers[column]), (RETURN, 0, 0, result)]
    allowed = [(EQUAL, len(FAMILIES) - at, 0, family) for at, family in enumerate(FAMILIES)]
    code += [(EQUAL, 0, len(allowed) + 3, SOCKET[column]), (LOAD, 0, 0, ARGUMENT), *allowed]
    code += [(RETURN, 0, 0, REFUSE), (RETURN, 0, 0, ALLOW)]
    # The program's own limits are its own.
    code += [(EQUAL, 0, 3, PRLIMIT[column]), (LOAD, 0, 0, ARGUMENT), (EQUAL, 1, 0, 0)]
    code += [(RETURN, 0, 0, REFUSE), (RETURN, 0, 0, ALLOW)]
    packed = b''.join(struct.pack('HBBI', *line) for line in code)
    lines = ctypes.create_string_buffer(packed, len(packed))
    program = ctypes.create_string_buffer(struct.pack('HxxxxxxQ', len(code), ctypes.addressof(lines)))
    prctl(SECCOMP, 2, program)


def confine(readable, writable):
    prctl(NO_NEW_PRIVS, 1, 0, 0, 0)
    landlock(readable, writable)
    filter_calls()


# Ends what the program left running: whatever it started comes to this process when its own parent is gone.
def sweep():
    me = os.getpid()
    while True:
        left = []
        for name in os.listdir('/proc'):
            if name.isdigit():
                try:
                    with open(f'/proc/{name}/stat') as file:
                        state, parent = file.read().rpartition(')')[2].split()[:2]
                except OSError:
                    continue
                if int(parent) == me and state != 'Z':
                    left.append(int(name))
        if not left:
            return
        for pid in left:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        time.sleep(0.005)


def main():
    if sys.argv[1:] == ['--probe']:
        readable, writable, program = [], [], None
    else:
        split, write = sys.argv.index('--'), sys.argv.index('--write')
        readable, writable = sys.argv[1:write], sys.argv[write + 1 : split]
        program = sys.argv[split + 1 :]
    prctl(CHILD_SUBREAPER, 1, 0, 0, 0)
    child = os.fork()
    if child == 0:
        try:
            # Should this process be killed, the program does not go on without it.
            prctl(PDEATHSIG, int(signal.SIGKILL), 0, 0, 0)
            confine(readable, writable)
        except Exception as error:
            sys.stderr.write(f'This system cannot confine a program: {error}\n')
            os._exit(UNAVAILABLE)
        if not program:
            os._exit(0)
        try:
            os.execvp(program[0], program)
        except OSError as error:
            sys.stderr.write(f'{program[0]}: {error.strerror}\n')
            os._exit(127)

    def end(*_):
        sweep()
        os._exit(128 + signal.SIGTERM)

    signal.signal(signal.SIGTERM, end)
    prctl(PDEATHSIG, int(signal.SIGTERM), 0, 0, 0)
    while True:
        pid, status = os.waitpid(-1, 0)
        if pid == child:
            break
    sweep()
    code = os.waitstatus_to_exitcode(status)
    os._exit(code if code >= 0 else 128 - code)


main()
