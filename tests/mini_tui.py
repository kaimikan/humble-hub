#!/usr/bin/env python3
"""A minimal stand-in for Claude Code's terminal behaviour, for pty tests.

Mimics the traits that matter to the blank-drawer bug: switches to the
alternate screen, toggles cursor visibility around redraws, enables
bracketed paste, and repaints ONLY on SIGWINCH (like a TUI that redraws on
resize) — so a client that never provokes a SIGWINCH sees nothing but the
mode-replay bytes.
"""
import fcntl
import os
import signal
import struct
import sys
import termios


def size():
    try:
        r, c, *_ = struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, b"\0" * 8))
        return (r or 24, c or 80)
    except OSError:
        return (24, 80)


last = [None]


def draw(*_):
    r, c = size()
    # ink-style: skip the repaint when the size didn't actually change —
    # coalesced SIGWINCHes from a too-fast jiggle land here as "no change"
    if (r, c) == last[0]:
        return
    last[0] = (r, c)
    sys.stdout.write(
        "\x1b[?25l\x1b[2J\x1b[H"          # hide cursor, clear, home
        f"MINI-TUI {c}x{r}\r\n"
        "the quick brown fox\r\n"
        "> \x1b[?25h"                      # prompt, show cursor
    )
    sys.stdout.flush()


sys.stdout.write("\x1b[?1049h\x1b[?2004h")  # alt screen + bracketed paste
sys.stdout.flush()
draw()
signal.signal(signal.SIGWINCH, draw)

while True:
    try:
        if not os.read(0, 1024):
            break
    except InterruptedError:
        continue  # SIGWINCH interrupts the read; keep serving
    except OSError:
        break
