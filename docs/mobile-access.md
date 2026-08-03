# Mobile access to the hub (Tailscale plan)

Goal: open the hub (shelf, jottings, drawer terminals) from the phone when
away from the home workstation, without exposing anything to the public
internet.

## Why Tailscale (and not the alternatives)

- **Tailscale** builds a private WireGuard mesh ("tailnet") between your
  devices. The hub stays bound to the laptop; the phone reaches it through an
  encrypted tunnel as if on the same LAN. Free tier covers personal use
  (up to ~100 devices, 3 users). No port forwarding, no public exposure.
- *Cloudflare Tunnel / reverse proxy*: makes the hub publicly reachable behind
  an auth layer, the wrong default for an app that **executes shell commands**.
  Rejected.
- *Plain SSH + a terminal app*: gets you Claude Code but not the hub UI.
  Worth having anyway as a fallback (Termius/JuiceSSH over the same tailnet).
- *Claude Remote Control / claude.ai*: covers conversations but not the hub
  (see `../../babble-building/experiments/01-…`; verdict was Park).

## What's required of you

1. **Account**: sign up at tailscale.com for the free Personal plan (GitHub SSO is fine).
2. **Laptop** (one-time, ~5 min):
   ```bash
   sudo pacman -S tailscale
   sudo systemctl enable --now tailscaled
   sudo tailscale up          # opens a browser login
   tailscale status           # note the laptop's 100.x.y.z IP / MagicDNS name
   ```
3. **Phone**: install the Tailscale app (Play Store / App Store), sign in to
   the same account, toggle the VPN on.
4. **Expose the hub to the tailnet**, preferably with Tailscale Serve, which
   proxies localhost:7700 to the tailnet with automatic HTTPS, so the app
   itself never stops being localhost-only:
   ```bash
   sudo tailscale serve --bg https / http://127.0.0.1:7700
   ```
   Then on the phone: `https://<laptop-magicdns-name>.<tailnet>.ts.net`.

## Code changes needed in the hub (small)

- [ ] **wss support**: `hub.js` and the terminal page hardcode `ws://`.
      Behind Tailscale Serve the page is HTTPS, so WebSockets must use
      `wss://`: switch to
      `location.protocol === "https:" ? "wss" : "ws"`. One-line change in
      both places.
- [ ] Optional: mobile polish pass (drawer at 100vw on small screens, larger
      touch targets for ✕/menus, font bump in the terminal).

## Risks & considerations

1. **The hub is a remote-control for the laptop.** Terminals run as your
   user; jottings/API can be written. Anyone who can reach the hub owns the
   machine. The tailnet IS the security boundary: keep it single-user, don't
   share nodes, and never enable funnel (public exposure) for this service.
2. **The phone becomes a key.** A lost/unlocked phone with the Tailscale
   toggle on can reach the hub. Mitigations: phone lock screen (you have
   one), Tailscale's device key expiry (default 180 days, re-auth after),
   and you can remove a device from the tailnet admin panel instantly from
   any browser.
3. **Laptop must be awake.** Suspend kills access. For deliberate
   away-from-home sessions: KDE → Energy Saving → disable sleep while on AC,
   lid closed counts. Worth a "before leaving home" checklist note rather
   than permanently disabling sleep.
4. **Mode presets travel too.** "accept edits" from the phone means file
   edits happen without prompts while you're on a small screen; consider
   keeping mode: default when mobile until trust is established. (The bypass
   preset was deliberately never added.)
5. **Session lifetime**: drawer sessions still die on hub restarts; on mobile
   that's more annoying (no Konsole fallback). Raises the priority of the
   tmux-backed-pty to-do.
6. **Battery (laptop)**: an idle tailscaled is negligible; the whisper daemon
   already handles AC/battery. No real concern.
7. **What does NOT change**: no router config, no DNS, no certificates to
   manage (Serve handles TLS), no new auth layer to build.

## Suggested order of work

1. Tailscale on laptop + phone, verify the tailnet pings (15 min)
2. The wss one-liner + `tailscale serve` (10 min)
3. Test shelf + jottings from the phone's browser
4. Test a drawer terminal with the phone keyboard's dictation
5. Mobile polish pass only if step 3-4 chafe
