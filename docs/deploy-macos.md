# Running on macOS as a background service (launchd)

The portal is a single process, so a user LaunchAgent is enough to keep it
running across reboots and restarts.

## 1. Configure

```bash
cp .env.example .env
# set ADMIN_TOKEN (fixed) or leave unset to get one printed once on first boot
chmod 600 .env
npm install && npm run build
```

## 2. Verify by hand first

```bash
node --env-file=.env dist/server.js
curl -s localhost:8787/healthz
```

## 3. Install the LaunchAgent

`~/Library/LaunchAgents/com.bacnh.skills-portal.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bacnh.skills-portal</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>--env-file=/absolute/path/to/.env</string>
    <string>/absolute/path/to/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/skills-portal</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- logs MUST live outside the project volume; see the gotcha below -->
  <key>StandardOutPath</key><string>/tmp/skills-portal.log</string>
  <key>StandardErrorPath</key><string>/tmp/skills-portal.err.log</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.bacnh.skills-portal.plist
launchctl list | grep skills-portal     # expect "<pid> 0 com.bacnh.skills-portal"
launchctl kickstart -k gui/$(id -u)/com.bacnh.skills-portal   # restart
```

## Gotchas we hit

- **`StandardOutPath` must not point inside a non-boot APFS volume** (e.g.
  `/Volumes/Dev/...`). launchd fails to open the log there and the job dies with
  exit status 78 and *no output at all*. Point logs at `/tmp` and `KeepAlive`
  works normally. Publishing a shell script inside such a volume and exec'ing it
  from the plist fails the same way (exit 126, "Operation not permitted").
  Passing `node` + the built JS directly in `ProgramArguments` is what works.
- **Use `--env-file`** rather than hardcoding secrets in the plist; the file can
  stay `chmod 600` and out of git.
- Because the server listens on `0.0.0.0`, it is reachable from the LAN at
  whatever address the machine holds (check `ipconfig getifaddr en0`). It
  speaks plain HTTP — fine on a trusted LAN, put a TLS reverse proxy in front
  before exposing it further, since bearer tokens travel in headers.
