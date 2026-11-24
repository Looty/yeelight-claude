// Claude Code hook -> Yeelight light strip as a status light. No pulsing or blinking, only slow glides.
//   working  : light orange @75% <-> deeper orange @45%, 1.8s each way   (UserPromptSubmit, PostToolUse)
//   finished : 2.5s glide to green, hold 4s, 2.5s glide back to your own color   (Stop)
//
// Safety rules:
//  - Every effect is start_cf with action 0, so the strip restores its own pre-effect state.
//  - Never turns the strip on: if it's off, nothing is sent (and start_cf is rejected while off anyway).
//  - No set_default / set_name / power commands. Only sends on state changes.
//  - Always exits 0 with no output so it can never block or steer Claude.
//  - Pause: create a file named DISABLED next to this script.
const fs = require('fs');
const path = require('path');
const y = require('./yeelight');

const DIR = __dirname;
const STATE = path.join(DIR, 'status-state.json');
const LIGHT = 'strip';
const STALE_MS = 30 * 60 * 1000; // ignore sessions silent for 30 min (closed without SessionEnd)
const FAIL_BACKOFF_MS = 60 * 1000;
const TIMEOUT_MS = 900;

const LIGHT_ORANGE = y.rgb(255, 165, 40), DEEP_ORANGE = y.rgb(255, 120, 0), GREEN = y.rgb(0, 230, 90);
const SLEEP = (ms) => `${ms},7,0,0`;
const WORKING = ['start_cf', [0, 0, y.flow([y.tuple(1800, 1, LIGHT_ORANGE, 75), y.tuple(1800, 1, DEEP_ORANGE, 45)])]];

function hsvToRgb(h, s) {
  const f = (n) => { const k = (n + h / 60) % 6; return 1 - (s / 100) * Math.max(0, Math.min(k, 4 - k, 1)); };
  return y.rgb(Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255));
}

// The glide back targets the strip's own color. During a flow, get_prop reports the pre-flow state.
function finishedEffect(p) {
  const bright = Number(p.bright) || 50;
  const back = p.color_mode === '2' ? y.tuple(2500, 2, Number(p.ct), bright)
    : p.color_mode === '3' ? y.tuple(2500, 1, hsvToRgb(Number(p.hue), Number(p.sat)), bright)
      : y.tuple(2500, 1, Number(p.rgb), bright);
  return ['start_cf', [3, 0, y.flow([y.tuple(2500, 1, GREEN, 70), SLEEP(4000), back])]];
}

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }

function stateFor(ev) {
  if (ev === 'UserPromptSubmit' || ev === 'PostToolUse') return 'working';
  if (ev === 'Stop') return 'idle';
  if (ev === 'SessionEnd') return 'gone';
  return null;
}

// No known IP yet: fail fast (discovery takes longer than a hook should); the caller backs off and
// rediscovers in the background.
async function sendRetry(cmds) {
  const host = y.hostOf(LIGHT);
  if (!host) throw new Error('strip not discovered yet');
  try { return await y.sendTo(host, cmds, TIMEOUT_MS); } catch { return y.sendTo(y.hostOf(LIGHT), cmds, TIMEOUT_MS); }
}

async function main() {
  if (fs.existsSync(path.join(DIR, 'DISABLED'))) return;
  // While screen glow runs it owns the strip's connection (music mode), so Claude's status is handed
  // to glow through CLAUDE_STATUS and glow draws it (Claude takes priority over the screen).
  // glow writes its PID to GLOW_ACTIVE; a leftover file from a crashed glow (PID gone) is ignored.
  let glowAlive = false;
  try {
    const pid = Number(fs.readFileSync(path.join(DIR, 'GLOW_ACTIVE'), 'utf8').trim());
    if (pid) { process.kill(pid, 0); glowAlive = true; }
  } catch {}
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const next = stateFor(input.hook_event_name);
  if (!next) return;

  const now = Date.now();
  const st = readJson(STATE, { sessions: {}, shown: 'idle', failedAt: 0 });

  // A mood/glow/effect started through the MCP server owns the strip (it writes its pid to STRIP_MOOD).
  // Stand down while it's alive and the strip is still flowing; otherwise drop the stale marker.
  const MOOD = path.join(DIR, 'STRIP_MOOD');
  if (!glowAlive && fs.existsSync(MOOD)) {
    let alive = false;
    try { const pid = Number(fs.readFileSync(MOOD, 'utf8').trim()); if (pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (alive) {
      try {
        const [[flowing]] = await sendRetry([['get_prop', ['flowing']]]);
        if (flowing === '1') return;
      } catch { return; }
    }
    try { fs.unlinkSync(MOOD); } catch {}
    st.shown = 'unknown'; // force the next state to be sent again
  }
  const sid = input.session_id || 'unknown';
  if (next === 'gone') delete st.sessions[sid];
  else st.sessions[sid] = { state: next, ts: now };
  for (const [k, s] of Object.entries(st.sessions)) if (now - s.ts > STALE_MS) delete st.sessions[k];

  // Any live session working -> working; otherwise idle.
  const want = Object.values(st.sessions).some((s) => s.state === 'working') ? 'working' : 'idle';
  if (glowAlive) {
    if (want !== st.shown) {
      const line = want === 'working' ? 'working' : next === 'idle' ? 'finished' : 'idle';
      try { fs.writeFileSync(path.join(DIR, 'CLAUDE_STATUS'), `${line} ${now}`); st.shown = want; } catch {}
    }
  } else if (want !== st.shown && now - (st.failedAt || 0) > FAIL_BACKOFF_MS) {
    try {
      if (want === 'working') {
        await sendRetry([WORKING]);
      } else if (next === 'idle') {
        const [vals] = await sendRetry([['get_prop', ['power', 'bright', 'ct', 'rgb', 'hue', 'sat', 'color_mode']]]);
        const p = Object.fromEntries(['power', 'bright', 'ct', 'rgb', 'hue', 'sat', 'color_mode'].map((k, i) => [k, vals[i]]));
        if (p.power === 'on') await sendRetry([finishedEffect(p)]);
      } else {
        await sendRetry([['stop_cf', []]]); // session closed mid-work: just restore
      }
      st.shown = want;
      st.failedAt = 0;
    } catch {
      st.failedAt = now; // strip unplugged / IP changed: back off; rediscover in the background
      require('child_process').spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(DIR, 'yeelight.js'))}).rediscover()`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
}

main().catch(() => {}).finally(() => process.exit(0));
