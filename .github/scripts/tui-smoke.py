#!/usr/bin/env python3
"""Launch devctl in a real Unix pseudo-terminal and quit it cleanly."""

import errno
import os
import select
import signal
import sys
import time


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: tui-smoke.py <devctl> <config>", file=sys.stderr)
        return 2

    command = [sys.argv[1], "--config", sys.argv[2]]
    pid, master = os.forkpty()
    if pid == 0:
        os.execvpe(command[0], command, os.environ.copy())

    output = bytearray()
    started = time.monotonic()
    sent_quit = False
    status = None
    try:
        while time.monotonic() - started < 15:
            if not sent_quit and time.monotonic() - started >= 1:
                os.write(master, b"q")
                sent_quit = True

            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                    if chunk:
                        output.extend(chunk)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise

            waited, candidate = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = candidate
                break
    finally:
        os.close(master)

    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        print("devctl TUI did not exit after receiving q", file=sys.stderr)
        return 1
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        print(output.decode("utf-8", "replace")[-4000:], file=sys.stderr)
        return 1
    if b"devctl" not in output.lower():
        print("devctl TUI produced no recognizable output", file=sys.stderr)
        return 1

    print("OpenTUI rendered and exited normally in a pseudo-terminal")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
