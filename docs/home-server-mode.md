# Home-server mode (laptop hosts the hub, lid closed)

Goal: leave the laptop at home on AC power with the lid closed, still serving
the hub to the phone over Tailscale.

## What's configured

### 1. Don't sleep on AC / lid-close (done)

On Plasma 6 the authoritative lid handler is **PowerDevil**, set per-profile in
`~/.config/powerdevilrc`. The **AC** profile is now:

```ini
[AC][SuspendAndShutdown]
AutoSuspendAction=0   # 0 = do nothing → never auto-suspend on AC
LidAction=0           # 0 = do nothing → lid close does nothing on AC
```

Applied with `kwriteconfig6` + `systemctl --user restart plasma-powerdevil`.
Battery profile is left at defaults (still suspends — intentional). The screen
may still turn off on idle; that's fine — it doesn't suspend the machine.

> Verify with a real test: close the lid while on AC and confirm from the phone
> that `https://kai-laptop.tail7603c2.ts.net` still responds.

### 2. Tailscale access (already up)

- `tailscaled` is **enabled + active** (survives reboot).
- `tailscale serve` exposes the hub tailnet-only:
  `https://kai-laptop.tail7603c2.ts.net → http://127.0.0.1:7700`. This config
  persists across reboots.
- The "MagicDNS / systemd-resolved" health warning on the laptop is harmless
  here: the **phone** resolves the tailnet name via its own Tailscale client,
  so phone→laptop works regardless of the laptop's resolver setup.

## Optional hardening — headless / login-screen case (needs sudo)

PowerDevil only governs lid behaviour while you're logged into Plasma. If the
laptop ever sits at the SDDM login screen (e.g. after a reboot) with the lid
closed, **logind** decides. To keep it awake there too:

```bash
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/10-home-server.conf >/dev/null <<'EOF'
[Login]
HandleLidSwitchExternalPower=ignore
EOF
sudo systemctl restart systemd-logind   # ends your graphical session — do it from a TTY
```

(Restarting logind logs you out, so run it when convenient, not mid-session.)

## Known limitation — reboot while away

`hub.service` is bound to `graphical-session.target` **by design** (it launches
konsole/dolphin/etc. which need the session environment — see the project
`CLAUDE.md`). So after a *reboot*, the hub does **not** come back until someone
logs in graphically. For today's "lid closed while already logged in" use case
this is fine. True boot-survival would mean either:

- enabling `loginctl enable-linger kaimikan` **and** moving the unit off
  `graphical-session.target` (which breaks the launch-app actions), or
- auto-login into Plasma on boot.

Left as a deliberate future decision, not changed here.

## Leaving-home checklist

1. Laptop plugged into AC. ✔ (lid-close/suspend already disabled on AC)
2. `tailscale status` shows the phone; hub reachable at the URL above.
3. Hub running: `systemctl --user is-active hub.service` → `active`.
4. Close the lid. From the phone, open `https://kai-laptop.tail7603c2.ts.net`.
5. (If you rebooted first) log in to Plasma once before leaving.
