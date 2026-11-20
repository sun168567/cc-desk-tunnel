#!/usr/bin/env python3
# Runs a program unable to open, change, remove or rename the protected paths; everything else stays as it is.
# The service starts its SFTP server through this, so that the file panel cannot reach the service's own
# secrets. It uses Landlock, which the Linux kernel offers any process to restrict itself (5.13 and later, where
# enabled), and which Docker's default seccomp profile allows.
#
#   landlock-run.py --probe                          prints the Landlock ABI, or exits with 97 without it
#   landlock-run.py PROTECTED... -- PROGRAM ARGS...  runs the program confined
#
# Landlock only grants: a hierarchy allowed is allowed whole. So the tree is walked from / and every directory
# above a protected path is split: its entries may be listed, each other entry is allowed on its own, and the
# protected one is left out. Such a directory takes no new entries, and one that appears in it later is out of
# reach until the program is started again. Symbolic links met on the way are not followed: what they point at
# is reached, or not, by its own place.
import ctypes
import os
import stat
import struct
import sys

UNAVAILABLE = 97
# The three Landlock system calls have these numbers on every architecture.
CREATE, ADD, RESTRICT = 444, 445, 446
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def call(*args):
    result = libc.syscall(*args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def abi():
    return call(ctypes.c_long(CREATE), None, ctypes.c_size_t(0), ctypes.c_uint32(1))


def main():
    try:
        version = abi()
    except OSError as error:
        sys.stderr.write(f'Landlock unavailable: {error.strerror}\n')
        sys.exit(UNAVAILABLE)
    if sys.argv[1:] == ['--probe']:
        print(version)
        return
    split = sys.argv.index('--')
    protected = {os.path.realpath(path) for path in sys.argv[1:split]}
    program = sys.argv[split + 1 :]
    # Every filesystem right this kernel knows, so that none stays unrestricted.
    handled = (1 << 13) - 1
    if version >= 2:
        handled |= 1 << 13  # REFER
    if version >= 3:
        handled |= 1 << 14  # TRUNCATE
    if version >= 5:
        handled |= 1 << 15  # IOCTL_DEV
    read_dir = 1 << 3
    # The rights a single file can be given: execute, write, read, truncate and device ioctl.
    file_rights = handled & (1 | 2 | 4 | (1 << 14) | (1 << 15))
    attribute = ctypes.create_string_buffer(struct.pack('Q', handled))
    ruleset = call(ctypes.c_long(CREATE), attribute, ctypes.c_size_t(8), ctypes.c_uint32(0))

    def add(path, rights):
        try:
            descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError:
            return
        try:
            rule = ctypes.create_string_buffer(struct.pack('=Qi', rights, descriptor))
            call(ctypes.c_long(ADD), ctypes.c_int(ruleset), ctypes.c_int(1), rule, ctypes.c_uint32(0))
        finally:
            os.close(descriptor)

    def allow(directory):
        prefix = directory.rstrip('/') + '/'
        if not any(path.startswith(prefix) for path in protected):
            add(directory, handled)
            return
        add(directory, read_dir)
        try:
            names = os.listdir(directory)
        except OSError:
            return
        for name in names:
            entry = prefix + name
            if entry in protected:
                continue
            try:
                mode = os.lstat(entry).st_mode
            except OSError:
                continue
            if stat.S_ISLNK(mode):
                continue
            if stat.S_ISDIR(mode):
                allow(entry)
            else:
                add(entry, file_rights)

    if '/' in protected:
        sys.exit('Refusing to protect /')
    allow('/')
    # Landlock needs this without privileges; the service's container sets it already.
    libc.prctl(38, 1, 0, 0, 0)
    call(ctypes.c_long(RESTRICT), ctypes.c_int(ruleset), ctypes.c_uint32(0))
    os.close(ruleset)
    os.execv(program[0], program)


main()
