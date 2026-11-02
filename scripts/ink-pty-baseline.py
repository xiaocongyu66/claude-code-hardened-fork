#!/usr/bin/env python3
"""P0 real-PTY baseline for existing React/Ink (Python stdlib + installed Bun).

Run: python3 scripts/ink-pty-baseline.py [--bun /absolute/path/to/bun]
Target: Linux and macOS POSIX PTYs; no Windows/ConPTY support. Platform support
requires remote execution evidence, not merely this platform check. No install
or build is performed. Tests raw mode, bracketed paste, an arrow key, SIGWINCH
size propagation, and normal useApp.exit()/natural process exit cleanup.
Not a screen emulator: no final-cell/layout, fragmented-input timing, alternate
screen, crash, signal-exit, SIGKILL recovery, or full CLI coverage.
"""

import argparse
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time

# Fail explicitly on unsupported platforms, before importing Unix-only modules.
if sys.platform not in ("linux", "darwin"):
    raise SystemExit("PTY baseline requires Linux or macOS; Windows is unsupported")

import fcntl
import pty
import termios

TIMEOUT = 20.0  # One total scenario deadline, not a per-event retry budget.
LIMIT = 1024 * 1024
PREFIX = b"INK_PTY_V1 "
QUERY = re.compile(rb"\x1b\[(?:>0q|c)")
REPLIES = {
    b"\x1b[>0q": b"\x1bP>|pty-baseline(1)\x1b\\",  # XTVERSION
    b"\x1b[c": b"\x1b[?1;2c",  # DA1 sentinel used by TerminalQuerier.flush
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def window_size(fd, columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


class Session:
    def __init__(self, master, child):
        self.master = master
        self.child = child
        self.deadline = time.monotonic() + TIMEOUT
        self.output = bytearray()
        self.control = bytearray()
        self.events = []
        self.control_open = True
        self.query_offset = 0
        self.queries = []
        self.bytes_read = 0
        os.set_blocking(master, False)

    def remaining(self):
        seconds = self.deadline - time.monotonic()
        require(seconds > 0, "scenario deadline exceeded")
        return seconds

    def send(self, data):
        view = memoryview(data)
        while view:
            _, writable, _ = select.select([], [self.master], [], self.remaining())
            require(writable, "PTY write timed out")
            try:
                written = os.write(self.master, view)
            except BlockingIOError:
                continue
            require(written > 0, "PTY write made no progress")
            view = view[written:]

    def pump(self, timeout=None):
        readers = [self.master]
        if self.control_open:
            readers.append(self.child.stderr.fileno())
        ready, _, _ = select.select(
            readers, [], [], self.remaining() if timeout is None else timeout
        )
        if not ready:
            require(timeout == 0, "timed out waiting for fixture output")
            return False
        for fd in ready:
            data = os.read(fd, 65536)
            self.bytes_read += len(data)
            require(self.bytes_read <= LIMIT, "fixture output exceeded 1 MiB limit")
            if fd == self.master:
                require(data, "unexpected PTY EOF")
                self.output.extend(data)
                # Match only the two actual queries made by this minimal app.
                # Keeping the scan position after the last complete query also
                # handles queries split over multiple PTY reads.
                for match in QUERY.finditer(self.output, self.query_offset):
                    query = bytes(match.group())
                    self.send(REPLIES[query])
                    self.queries.append(query)
                    self.query_offset = match.end()
            elif not data:
                self.control_open = False
                require(not self.control, "truncated fixture protocol line")
            else:
                self.control.extend(data)
                while b"\n" in self.control:
                    line, _, rest = self.control.partition(b"\n")
                    self.control = bytearray(rest)
                    require(line.startswith(PREFIX), f"fixture stderr: {line!r}")
                    self.events.append(json.loads(line[len(PREFIX):]))
        return True

    def expect(self, expected):
        while not self.events:
            require(self.control_open, f"fixture closed before {expected!r}")
            self.pump()
        actual = self.events.pop(0)
        require(actual == expected, f"expected {expected!r}, received {actual!r}")

    def finish(self):
        while self.control_open:
            self.pump()
        code = self.child.wait(timeout=self.remaining())
        require(code == 0, f"fixture exited with status {code}")
        # Parent retains the slave for termios inspection, so master EOF is not
        # an exit signal. After wait(), drain all already-written terminal bytes.
        while self.pump(timeout=0):
            self.remaining()
        require(not self.events, f"unexpected trailing events: {self.events!r}")


def run(bun):
    fixture = Path(__file__).resolve().parent / "fixtures" / "pty-baseline.fixture.tsx"
    master, slave = pty.openpty()
    child = None
    session = None
    try:
        window_size(slave, 80, 24)
        before = termios.tcgetattr(slave)
        require(before[3] & termios.ICANON and before[3] & termios.ECHO,
                "fresh PTY must begin in canonical, echo-enabled mode")
        with tempfile.TemporaryDirectory(prefix="ink-pty-baseline-") as home:
            # Do not inherit tokens, Bun/Node preloads, terminal detection knobs,
            # or CLI/user configuration. No business entrypoint is imported.
            env = {
                "PATH": os.environ.get("PATH", os.defpath),
                "HOME": home,
                "XDG_CONFIG_HOME": home,
                "TERM": "xterm-256color",
                "LANG": "en_US.UTF-8",
            }
            child = subprocess.Popen(
                [bun, "--no-env-file", str(fixture)],
                cwd=home, env=env, stdin=slave, stdout=slave,
                stderr=subprocess.PIPE, start_new_session=True,
            )
            session = Session(master, child)
            tty = {"stdinTTY": True, "stdoutTTY": True, "raw": True}
            session.expect({"type": "ready", "columns": 80, "rows": 24, **tty})
            active = termios.tcgetattr(slave)
            require(not active[3] & (termios.ICANON | termios.ECHO | termios.ISIG),
                    "kernel termios did not enter raw mode")

            # Independent, fixed input oracle. This is one bracketed paste,
            # not a claim that the OS delivered particular stdin chunk sizes.
            paste = "paste: 中文\tA\nsecond line"
            session.send(b"\x1b[200~" + paste.encode("utf-8") + b"\x1b[201~")
            session.expect({"type": "input", "input": paste, "upArrow": False, "pasted": True})
            session.send(b"\x1b[A")
            session.expect({"type": "input", "input": "", "upArrow": True, "pasted": False})

            window_size(slave, 100, 32)
            # No controlling terminal is assigned to the new session. Deliver
            # the real OS resize signal explicitly to only our child PID.
            child.send_signal(signal.SIGWINCH)
            session.expect({"type": "resize", "columns": 100, "rows": 32, **tty})
            session.send(b"q")
            session.expect({"type": "input", "input": "q", "upArrow": False, "pasted": False})
            session.expect({"type": "exit", "raw": False})
            session.finish()

            require(termios.tcgetattr(slave) == before,
                    "normal exit did not restore the complete original termios")
            output = bytes(session.output)
            require(b"INK_PTY_BASELINE" in output, "no rendered fixture text on PTY")
            for enabled, disabled in (
                (b"\x1b[?2004h", b"\x1b[?2004l"),
                (b"\x1b[?1004h", b"\x1b[?1004l"),
                (b"\x1b[?25l", b"\x1b[?25h"),
            ):
                require(enabled in output and output.rfind(disabled) > output.rfind(enabled),
                        f"missing or misordered terminal mode cleanup: {enabled!r}")
            require(set(session.queries) == set(REPLIES), "expected XTVERSION and DA1 queries")
            print(f"PASS: {sys.platform} real PTY raw/paste/arrow/resize/normal-exit baseline")
    except Exception:
        if session is not None:
            print(f"PTY output suffix: {bytes(session.output[-4096:])!r}", file=sys.stderr)
        raise
    finally:
        # Only our direct child is ever signalled; the fixture spawns no workers.
        # Forced cleanup is a failure fallback, NOT evidence of signal recovery.
        try:
            if child is not None:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=2)
                child.stderr.close()
        finally:
            os.close(master)
            os.close(slave)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", default="bun", help="installed Bun executable (no installation)")
    args = parser.parse_args()
    bun = shutil.which(args.bun)
    require(bun is not None, f"Bun executable not found: {args.bun}")
    run(str(Path(bun).resolve()))


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
