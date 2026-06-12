#!/usr/bin/env python3
"""hub_ptyd — a tiny detachable pty holder (our own minimal dtach).

Runs ONE program on a pty and serves its I/O over a Unix socket so that any
number of clients (the hub's WebSocket bridge) can attach, detach and
reattach without disturbing the program. Spawned as a transient systemd user
unit, it survives hub.service restarts — drawer chats no longer die when the
hub is restarted, and the full-page terminal can attach to the same session
as the drawer.

    hub_ptyd.py <socket-path> -- <argv...>

Framed protocol, both directions: 1-byte type + 4-byte big-endian length +
payload.
  client → daemon:  i = input bytes · r = resize (rows u16, cols u16) ·
                    k = kill session
  daemon → client:  o = program output

A resize to the *current* size jiggles the width first so the program always
receives SIGWINCH and repaints — that's what makes reattach show the screen.
Exits (and removes the socket) when the program does. Stdlib only.
"""
import os
import pty
import re
import selectors
import signal
import socket
import struct
import sys
import time

# DEC private mode set/reset (e.g. mouse tracking, alt screen, bracketed
# paste). Programs emit these once at startup, so late-attaching clients
# would miss them — we track the latest state and replay it on attach.
MODE_RE = re.compile(rb"\x1b\[\?([0-9;]+)([hl])")


def main() -> int:
    sep = sys.argv.index("--")
    sock_path, argv = sys.argv[1], sys.argv[sep + 1:]

    pid, master = pty.fork()
    if pid == 0:  # child: the program
        os.execvp(argv[0], argv)

    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o600)
    server.listen(8)
    server.setblocking(False)
    os.set_blocking(master, False)

    sel = selectors.DefaultSelector()
    sel.register(server, selectors.EVENT_READ, "server")
    sel.register(master, selectors.EVENT_READ, "master")
    # per-client state: inbound frame buffer + whether its first resize is
    # still pending (only that one earns a repaint jiggle)
    clients: dict[socket.socket, dict] = {}
    cur_size = (0, 0)
    restore_at = None  # (deadline, rows, cols): second half of a repaint jiggle
    modes: dict[bytes, bool] = {}  # DEC private modes the program has set
    mode_carry = b""               # tail bytes in case a sequence splits reads
    shutting_down = False

    def winsize(rows: int, cols: int) -> None:
        import fcntl
        import termios
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def track_modes(data: bytes) -> None:
        nonlocal mode_carry
        buf = mode_carry + data
        for params, hl in MODE_RE.findall(buf):
            for p in params.split(b";"):
                modes[p] = hl == b"h"
        mode_carry = buf[-12:]  # re-parsing overlap is harmless (idempotent)

    def send_frame(c: socket.socket, data: bytes) -> None:
        try:
            c.sendall(b"o" + struct.pack(">I", len(data)) + data)
        except OSError:
            drop(c)

    def broadcast(data: bytes) -> None:
        track_modes(data)
        frame = b"o" + struct.pack(">I", len(data)) + data
        for c in list(clients):
            try:
                c.sendall(frame)
            except OSError:
                drop(c)

    def drop(c: socket.socket) -> None:
        if c in clients:
            sel.unregister(c)
            del clients[c]
            c.close()

    def shutdown(*_) -> None:
        nonlocal shutting_down
        shutting_down = True
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, shutdown)

    running = True
    while running:
        timeout = 1.0
        if restore_at:
            timeout = min(timeout, max(0.0, restore_at[0] - time.monotonic()))
        for key, _ in sel.select(timeout=timeout):
            if key.data == "server":
                conn, _addr = server.accept()
                conn.setblocking(True)
                clients[conn] = {"buf": bytearray(), "fresh": True}
                sel.register(conn, selectors.EVENT_READ, "client")
                if modes:  # replay terminal modes the program set at startup
                    seq = b"".join(b"\x1b[?" + p + (b"h" if on else b"l")
                                   for p, on in modes.items())
                    send_frame(conn, seq)
            elif key.data == "master":
                try:
                    data = os.read(master, 65536)
                except (BlockingIOError, InterruptedError):
                    continue
                except OSError:
                    data = b""
                if not data:  # program exited
                    running = False
                    break
                broadcast(data)
            else:  # a client
                c = key.fileobj
                try:
                    chunk = c.recv(65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    drop(c)
                    continue
                state = clients[c]
                buf = state["buf"]
                buf.extend(chunk)
                while len(buf) >= 5:
                    typ, ln = chr(buf[0]), struct.unpack(">I", buf[1:5])[0]
                    if len(buf) < 5 + ln:
                        break
                    payload = bytes(buf[5:5 + ln])
                    del buf[:5 + ln]
                    if typ == "i":
                        try:
                            os.write(master, payload)
                        except OSError:
                            pass
                    elif typ == "r" and ln >= 4:
                        rows, cols = struct.unpack(">HH", payload[:4])
                        if (rows, cols) != cur_size:
                            restore_at = None  # a real resize wins
                            winsize(rows, cols)
                            cur_size = (rows, cols)
                        elif state["fresh"] and cols > 1:
                            # reattach at the unchanged size: shrink now,
                            # restore a beat later (see loop bottom). The two
                            # halves MUST be spaced out — back-to-back winsize
                            # calls coalesce into one SIGWINCH at the final
                            # (unchanged) size, which size-comparing TUIs
                            # (ink/Claude) ignore entirely: the reattaching
                            # client then sees only the replayed empty alt
                            # screen — the blank-drawer bug. Never jiggle on
                            # later same-size resizes — each repaint dumps a
                            # duplicate frame into scrollback.
                            winsize(rows, cols - 1)
                            restore_at = (time.monotonic() + 0.12, rows, cols)
                        state["fresh"] = False
                    elif typ == "k":
                        shutdown()
        if restore_at and time.monotonic() >= restore_at[0]:
            _, rows, cols = restore_at
            restore_at = None
            winsize(rows, cols)
        # reap the child if it died; selector timeout makes this prompt
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                running = False
        except ChildProcessError:
            running = False

    for c in list(clients):
        drop(c)
    server.close()
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
