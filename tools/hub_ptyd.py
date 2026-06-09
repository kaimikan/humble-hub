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
import selectors
import signal
import socket
import struct
import sys


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
    clients: dict[socket.socket, bytearray] = {}  # per-client inbound buffer
    cur_size = (0, 0)
    shutting_down = False

    def winsize(rows: int, cols: int) -> None:
        import fcntl
        import termios
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def broadcast(data: bytes) -> None:
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
        for key, _ in sel.select(timeout=1.0):
            if key.data == "server":
                conn, _addr = server.accept()
                conn.setblocking(True)
                clients[conn] = bytearray()
                sel.register(conn, selectors.EVENT_READ, "client")
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
                buf = clients[c]
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
                        if (rows, cols) == cur_size and cols > 1:
                            winsize(rows, cols - 1)  # force a SIGWINCH repaint
                        winsize(rows, cols)
                        cur_size = (rows, cols)
                    elif typ == "k":
                        shutdown()
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
