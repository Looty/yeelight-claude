# yeelight-claude

Control Yeelight Wi-Fi lights from Claude, over the local network. It has a Claude Code hook that turns a light strip into a status light (Claude working / finished), an MCP server so Claude can set colors, scenes and moods, a daylight script that makes a bulb follow the sun, and a few effects. Everything talks to the lights directly with the Yeelight LAN protocol (TCP 55443, SSDP discovery on 239.255.255.250:1982). It uses plain Node.js with no npm packages, and nothing goes through the cloud.

## Supported lights

**Yeelight Wi-Fi lights only.** It speaks the Yeelight LAN protocol, so it does not work with other brands (Philips Hue, LIFX, Govee, Tuya and so on), with Yeelight Bluetooth/BLE-only lights, or with lights that only work through Mi Home.

It has been tested on exactly two devices:

| Device | Model reported | Used as |
|---|---|---|
| Yeelight Lightstrip Plus | `stripe` | `strip` |
| Yeelight Color Bulb | `color` | `bulb` |

Other Yeelight Wi-Fi color models may work, but they are untested.

The code knows two lights by name, `strip` and `bulb`, and can't address a third light or a second strip. With only one of the two, the status hook (strip), the daylight script (bulb) and the MCP server still work, but `snapshot.js` and effects run from the command line expect both.

## Requirements

- Node.js 18.3 or newer.
- **LAN Control turned on for each light** (see below). Without it, nothing here can reach the lights.
- The PC and the lights on the same network.
- Windows only for `install-daylight.ps1` and the screen glow tray app. The Node scripts are not Windows-specific.

## Setup

### 1. Turn on LAN Control

Yeelight lights ignore local commands until LAN Control is on. It is a per-light switch in the Yeelight app:

1. Open the **Yeelight** app and tap the light.
2. Open the light's settings (the gear or the menu in the top-right corner).
3. Tap **LAN Control** and turn it on.
4. Repeat for every light.

This only opens the light to commands from your own network. It doesn't change the light's settings or the schedules in the app. If a light still doesn't answer, check that the PC and the light are on the same network: guest Wi-Fi or "AP isolation" blocks this.

### 2. Get the code

```
git clone https://github.com/Looty/yeelight-claude.git
cd yeelight-claude
```

There is nothing to install.

### 3. config.json (optional)

Copy `config.example.json` to `config.json` and edit it. Every part is optional.

```json
{
  "lights": {
    "strip": { "id": "0x0000000012345678", "host": "192.168.1.50" },
    "bulb": { "id": "0x0000000087654321", "host": "192.168.1.51" }
  },
  "location": { "lat": 51.48, "lon": 0.0 }
}
```

The values above are placeholders.

- `lights.<name>.host`: the light's IP. It is only a starting point; when it stops answering, the scripts rediscover the light.
- `lights.<name>.id`: the Yeelight device id. When set, discovery only accepts that exact device.
- `location`: decimal degrees, north and east positive. Only the daylight script uses it. 51.48, 0.0 is Greenwich, as an example.

Delete every id or host you don't know. A configured id that isn't found is never replaced by another device, so a leftover placeholder id means that light is never found.

Without `config.json`, the lights are found by SSDP discovery, by model: a model containing `strip` becomes `strip`, a `color...` or `bslamp...` model becomes `bulb` (otherwise the first other light). Found IPs are saved in `ip-cache.json`.

- The cache wins over `host` in `config.json`. If you change a host by hand, delete `ip-cache.json`.
- Discovery needs the firewall to let node receive inbound UDP (on Windows: allow node.exe on Private networks). If you can't allow that, set the hosts in `config.json`.

## Claude Code status light

`status-hook.js` uses the strip to show what Claude is doing. It only uses slow glides, never pulsing or blinking.

| State | Effect |
|---|---|
| working | light orange at 75% and deeper orange at 45%, gliding 1.8s each way |
| finished | 2.5s glide to green, 4s hold, 2.5s glide back to the strip's own color |

Add this to `~/.claude/settings.json`. If you already have a `hooks` block, merge these four entries into it. Use your own path (on Windows, `C:/path/to/...` with forward slashes works).

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/yeelight-claude/status-hook.js\"", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/path/to/yeelight-claude/status-hook.js\"", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/yeelight-claude/status-hook.js\"", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/yeelight-claude/status-hook.js\"", "timeout": 5 }] }
    ]
  }
}
```

How it behaves:
- It never turns the strip on. If the strip is off, nothing happens.
- It only sends a command when the state changes.
- It handles several sessions at once. If any session is working, the strip shows working.
- It always exits 0 with no output, so it can't block Claude.
- If the strip doesn't answer, it waits 60s before trying again and rediscovers the strip in the background.
- With no known address, it sends nothing on the first event and starts discovery in the background. Setting `lights.strip.host` avoids that.
- While a mood, glow or effect started by the MCP server runs on the strip, the hook leaves the strip alone (`STRIP_MOOD` file).
- While screen glow runs, the hook writes the state to `CLAUDE_STATUS` and the tray app draws it.

To pause it, create an empty file named `DISABLED` in this folder. Delete it to resume. To remove it, delete the four entries from `~/.claude/settings.json`.

`node test-hook.js` plays a full working/finished cycle on the real strip (about 16s). `node preview-working.js` previews other "working" looks on the strip; `--loop <name>` keeps one running and `--stop` ends it.

## MCP server

`mcp-server.js` lets Claude control the lights: you ask in plain words, and Claude calls the server's tools. It is a stdio MCP server with no dependencies, so any MCP client that can run a local command can use it.

### 1. Register it

Do the LAN Control step above first. Then pick your client.

**Claude Code** (once, for all your projects):

```
claude mcp add --scope user yeelight -- node /path/to/yeelight-claude/mcp-server.js
```

Check it with `claude mcp list` (it should say `yeelight ... Connected`), or type `/mcp` inside Claude Code.

**Claude Desktop:** add this to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`), then quit and restart the app:

```json
{
  "mcpServers": {
    "yeelight": {
      "command": "node",
      "args": ["/path/to/yeelight-claude/mcp-server.js"]
    }
  }
}
```

If `node` isn't on the app's PATH, put the full path to node there instead (for example `C:\\Program Files\\nodejs\\node.exe`).

Use your own path to `mcp-server.js` in both cases. On Windows, forward slashes work (`C:/path/to/...`).

### 2. Ask Claude

Just say what you want. For example:

| You say | Claude uses |
|---|---|
| "What are my lights doing?" | `light_status` |
| "Make the strip warm white at 40%" | `set_light` |
| "Turn the bulb off" | `set_light` with `power` |
| "Movie time" / "Set the reading scene" | `scene` |
| "Give me a rainy cafe mood on both lights" | `mood` (Claude makes up the palette) |
| "Glow the strip green for a moment" | `glow` |
| "Play the aurora effect" | `play_effect` |
| "Stop the mood" / "Put the lights back" | `stop` |
| "Make the bulb follow the sun" | `daylight` |
| "Sync the strip to my screen" | `screen_glow` |

Good to know:
- Claude never turns a light on or off unless you ask for that light. A light that is off is skipped, and the reply says so.
- Moods, glows and effects run on the lights themselves, so they keep going without the PC. `stop` returns the lights to how they were before.
- While a mood runs on the strip, the Claude status light (below) leaves it alone.
- If a light can't be found, the reply says so and suggests what to check (LAN Control, the same network, `config.json`).

### 3. Tools

Tools (`light` is `strip`, `bulb` or `both`):
- `light_status`: read-only. Power, brightness, color, running flows, music mode, screen glow and daylight status.
- `set_light`: color (`#RRGGBB` or a name), `ct` (1700-6500K), brightness, transition. Changes power only when `power` is given.
- `scene`: `movie`, `reading`, `focus`, `relax`, `night`. Uses both lights.
- `mood`: an endless slow glide through 2-6 colors, running on the lights themselves.
- `glow`: a short glow in one color, then the light goes back by itself.
- `play_effect`: one of the effects below, in the background.
- `stop`: ends a mood, glow or effect. The lights go back to their previous state.
- `daylight`: `on`, `off`, `status`, `resume`.
- `screen_glow`: `start`, `stop`, `status`. Needs the tray app (see below).

### 4. Testing
- `node mcp-server.js --selftest` runs offline with fake lights. Nothing is sent on the network.
- `node test-mcp.js <tool> '<json>' [<tool> '<json>' ...]` drives the server against the real lights. Only `light_status` is read-only.

When a light can't be reached, the tool result says so and suggests what to check. With no known address, each call to that light first spends about 2.5s on discovery.

## Daylight (bulb follows the sun)

`daylight.js` sets the bulb's color temperature from the sun's position at `location` in `config.json`. The sun times are computed offline.

- Day: 5600K at 100%.
- Around sunrise and sunset: between 3000K and 5600K, following the sun's height.
- Evening: 2700K down to 2200K, dimming to 40% over 2.5 hours after sunset.
- Night: 2200K at 40%. From 04:00 until dawn: 2700K at 60%.
- Every change is a 20s glide.

How it behaves:
- It only acts while the bulb is on, and never turns it on or off. Schedules in the Yeelight app stay in charge.
- If you change the bulb yourself, it leaves the bulb alone until the bulb is next off. The same goes for a color, white or brightness change made through the MCP server's `set_light` or `scene`; a plain "turn the bulb on" lets the daylight curve take over.
- It leaves the bulb alone while a flow or music mode runs on it.
- Sun times use the PC's clock, so the PC's time zone should match `location`.
- Far north or south in summer (around 60 degrees and up), the evening never reaches the night look.

Commands:
- `node daylight.js tick`: one step. Run it every 10 minutes.
- `node daylight.js status`: read-only state as JSON.
- `node daylight.js plan [YYYY-MM-DD]`: the day's curve in 30-minute steps.
- `node daylight.js resume`: take control again after a manual change.
- `node daylight.js manual`: leave the bulb alone until it is next off.
- `node daylight.js selftest`: offline checks. It needs no config.

On Windows, `.\install-daylight.ps1` registers a scheduled task that runs `tick` every 10 minutes for the current user, with no window and no admin rights. `-DryRun` shows what it would register, `-Uninstall` removes it. It needs a location first, also for `-DryRun`: without one it stops with an error. On other systems, run `tick` from cron.

To pause it, create an empty file named `DAYLIGHT_OFF` in this folder.

## Effects

`node effects.js` lists them. `node effects.js all` plays them all, or name one: `pingpong`, `aurora`, `storm`, `candle`, `heartbeat`, `rainbow`, `sunrise`.

- Each effect runs as a flow on the lights themselves, and both lights go back to their previous state afterwards.
- `pingpong`, `storm` and `heartbeat` flash. The others glide or flicker gently.
- Every effect uses both lights. From the command line, both must be on and reachable; the MCP `play_effect` tool skips lights that are off.

## Snapshot and restore

- `node snapshot.js` saves the state of both lights (and any sleep timer) to `snapshot-<time>.json`. The first snapshot ever taken is also kept as `snapshot-original.json`. Both lights must be reachable.
- `node snapshot.js --restore [file]` puts the lights back. Without a file it restores `snapshot-original.json`. It turns a light on if it was on in the snapshot, and re-arms a sleep timer that was running.
- Snapshots contain your device ids and IPs. They are gitignored.
- Schedules made in the Yeelight app live in the cloud. LAN control can't read or change them.

## Screen glow (Windows tray app)

[yeelight-tray](https://github.com/Looty/yeelight-tray) is a separate Windows tray app that colors the strip from the edges of your screen. Build it as its README says (`cargo build --release`) and copy `yeelight-tray.exe` into this folder.

With the exe here:
- The MCP `screen_glow` tool starts and stops it (`--glow on|off`) and reads its state (`--status`).
- The status hook sees it running (`GLOW_ACTIVE`) and hands Claude's status to it through `CLAUDE_STATUS`, so the two don't fight over the strip.

## Things learned the hard way

- **Message size:** a command message over about 250 bytes gets no reply at all. That is about 15 flow steps. The spec doesn't say this. `playFlow()` splits long flows into overlapping chunks.
- **Self-restoring flows:** `start_cf` with action 0 returns the light to its state from before the *first* flow, even when a new flow starts on top of a running one. That is why nothing here saves or restores colors itself.
- **Reading during a flow:** while a flow runs, `get_prop` reports the state the light will return to, not the color it shows.
- **Off lights:** `start_cf` is rejected while a light is off.
- **One zone:** the Lightstrip Plus is a single zone, so a real left-to-right chase isn't possible.

## Safety

- `set_default` and `set_name` are never used. They change persistent settings on the light.
- The Node scripts never use `set_music` (music mode needs an inbound firewall rule). The tray app does use music mode.
- The MCP server and the daylight script never use `cron_*`. Only `snapshot.js` does: it reads the sleep timer and re-arms it on restore.
- Nothing turns a light on by itself. `set_power` is sent only by `set_light` with `power`, by `scene` with `power_on_if_off`, and by `snapshot.js --restore`.
- Effects, moods and glows use flows with action 0, so the lights restore their own state.

## Local files

These are created next to the scripts and are gitignored: `config.json`, `ip-cache.json`, `status-state.json`, `daylight-state.json`, `snapshot-*.json`, and the flag files `DISABLED`, `DAYLIGHT_OFF`, `STRIP_MOOD`, `GLOW_ACTIVE`, `CLAUDE_STATUS`, `GLOW_STOP`. With the tray app here, also `yeelight-tray.exe`, `yeelight-tray.ini` and `yeelight-tray.log*`. The `.gitignore` is an allowlist: everything it doesn't list is ignored.

## License

MIT. See [LICENSE](LICENSE).
