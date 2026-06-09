#!/usr/bin/env python3
"""Service-launcher integration test on its own uvicorn (:7798).

Uses the real curated-cool-content manifest: detects it as a service, starts
it via the API (transient hub-svc-* unit), sees the dot flip, stops it.
Skips the start/stop half if the service is already running (user-started).

    ~/.venvs/playwright/bin/python tests/test_services.py
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HUB = Path(__file__).resolve().parent.parent
PORT = 7798
SVC = "curated-cool-content"
SVC_PORT = 7701
failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def api(path, method="GET"):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


server = subprocess.Popen(
    [str(HUB / ".venv/bin/python"), "-m", "uvicorn", "app:app",
     "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
    cwd=HUB, env=dict(os.environ), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(80):
        if port_open(PORT):
            break
        time.sleep(0.25)

    projects = api("/api/projects")
    svc = next((p for p in projects if p["name"] == SVC), None)
    check("manifest detected as service", svc and svc["type"] == "service"
          and svc["port"] == SVC_PORT, str(svc))
    lidl = next((p for p in projects if p["name"] == "little-lidl-list"), None)
    check("lidl manifest detected too", lidl and lidl["type"] == "service", str(lidl))

    page = urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=10).read().decode()
    check("card has ▶ open + status dot + service chip",
          f"openService('{SVC}')" in page and f'data-svc="{SVC}"' in page
          and 'data-type="service" onclick="pick(this)"' in page)

    if port_open(SVC_PORT):
        print(f"  SKIP  {SVC} already running — start/stop half skipped")
    else:
        states = api("/api/services")
        check("/api/services reports stopped", states.get(SVC) is False, str(states))
        r = api(f"/api/projects/{SVC}/service/open", method="POST")
        check("open starts the service", r.get("ok") and r.get("started")
              and port_open(SVC_PORT), str(r))
        unit = subprocess.run(["systemctl", "--user", "is-active",
                               f"hub-svc-{SVC}.service"],
                              capture_output=True, text=True).stdout.strip()
        check("runs as a transient hub-svc unit", unit == "active", unit)
        check("/api/services reports running", api("/api/services").get(SVC) is True)
        r2 = api(f"/api/projects/{SVC}/service/open", method="POST")
        check("second open is idempotent (no restart)", r2.get("started") is False, str(r2))
        api(f"/api/projects/{SVC}/service/stop", method="POST")
        time.sleep(1.5)
        check("stop closes the port", not port_open(SVC_PORT))
finally:
    if server.poll() is None:
        server.terminate()
        server.wait()
    # exact unit names only — never glob over real units
    subprocess.run(["systemctl", "--user", "stop", f"hub-svc-{SVC}.service"],
                   capture_output=True)

print()
if failures:
    print(f"❌ {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("✅ all checks passed")
