#!/usr/bin/env node
// Yeelight MCP server: zero dependencies, MCP over stdio (JSON-RPC 2.0, one JSON message per line).
// stdout carries protocol messages only; every log line goes to stderr.
//
// Register (user scope):
//   claude mcp add --scope user yeelight -- node /path/to/yeelight-claude/mcp-server.js
// Lights come from config.json (see config.example.json); without it they are found by SSDP discovery.
// Offline check (fake lights, nothing is sent on the LAN):
//   node mcp-server.js --selftest
//
// Tools
//   light_status {light?}                      read-only: power, brightness, color, flowing, music mode,
//                                              screen glow, daylight, running effect
//   set_light    {light, power?, color?, ct?, brightness?, transition_ms?}
//                                              changes power ONLY when `power` is given; an off light
//                                              without power:"on" is reported and left alone
//   scene        {name, power_on_if_off?}      movie | reading | focus | relax | night (1.5s glide)
//   mood         {colors[2-6], seconds_per_color?, brightness?, light?}
//                                              endless slow on-device glide through a palette
//   glow         {color, seconds?, light?}     glide to a color, hold, glide back, light restores itself
//                                              (a mood/flow already running on that light ends)
//   play_effect  {name}                        effects.js effects, played in the background (ends a mood)
//   stop         {light?}                      ends any flow / effect; lights restore themselves
//   daylight     {action}                      on | off | status | resume (daylight.js + DAYLIGHT_OFF flag)
//   screen_glow  {action}                      start | stop | status of the yeelight-tray.exe tray app
//                                              (--glow on/off, --status); start is confirmed only once
//                                              the tray reports it is glowing
//
// Safety: never uses set_default / set_name / cron_* / set_scene / set_music. set_power is sent only by
// set_light with an explicit `power`, and by scene with power_on_if_off:true. Flows use action 0, so
// lights return to their own previous state. While screen glow runs (GLOW_ACTIVE pid alive), the strip
// is left to it. Errors become isError tool results; the process never exits on bad input.
//
// STRIP_MOOD marker: while a mood / glow / effect started here runs on the strip, the file STRIP_MOOD
// holds this server's pid (glow and effects remove it when they end; stop, set_light, scene and
// screen_glow start remove it). It is meant for status-hook.js, which must then leave the strip alone,
// and must DELETE (not just ignore) a marker whose strip is no longer flowing, or the hook's own working
// flow would later look like a live mood. With an older copy of status-hook.js that does not read the
// marker, strip results carry a note.
//
// Daylight: after set_light sets the bulb's color / ct / brightness, or scene sets the bulb, daylight.js
// markManual() is called (when daylight.js is installed), so the daylight curve leaves the bulb alone until
// it is next off. A bare power-on is not manual: the curve takes over as after a wall switch.
'use strict';

// Protocol output must be the only thing on stdout. Grab the real writer, then send everything
// else (console.log in effects.js / daylight.js, stray writes) to stderr.
const rawOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (...a) => process.stderr.write(...a);
console.log = console.info = console.debug = (...a) => console.error(...a);
process.stdout.on('error', () => {}); // EPIPE when the client goes away
const log = (...a) => console.error('[yeelight-mcp]', ...a);
process.on('uncaughtException', (e) => log('uncaught:', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e && e.stack || e));

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const y = require('./yeelight');

let DIR = __dirname; // the selftest points this at a temp dir
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const IO_TIMEOUT = 3000;
const MAX_MSG = 235; // measured: longer command messages are silently dropped

class UserError extends Error {}

// ---------------------------------------------------------------- light IO
// All light traffic goes through io.send so the selftest can swap in fake lights.
const io = { send: (name, cmds, ms) => y.send(name, cmds, ms) };

// One queue per light, so our own commands to a light never interleave.
const queues = {};
function withLight(name, fn) {
  const run = (queues[name] || Promise.resolve()).then(fn);
  queues[name] = run.catch(() => {});
  return run;
}

function msgSize(method, params) { return JSON.stringify({ id: 99999, method, params }).length; }

async function cmd(name, cmds, ms = IO_TIMEOUT) {
  for (const [m, p] of cmds) {
    if (msgSize(m, p) > MAX_MSG) throw new Error(`${m} message too long (${msgSize(m, p)} bytes)`);
  }
  const res = await io.send(name, cmds, ms);
  const errs = (res || []).map((r, i) => (r && !Array.isArray(r) && r.error ? `${cmds[i][0]}: ${JSON.stringify(r.error)}` : null)).filter(Boolean);
  if (errs.length) throw new Error(`light rejected ${errs.join('; ')}`);
  return res;
}

const STATE_PROPS = ['power', 'bright', 'ct', 'rgb', 'hue', 'sat', 'color_mode', 'flowing', 'music_on'];
async function readState(name, ms = IO_TIMEOUT) {
  const [vals] = await cmd(name, [['get_prop', STATE_PROPS]], ms);
  if (!Array.isArray(vals)) throw new Error('bad get_prop reply');
  return Object.fromEntries(STATE_PROPS.map((p, i) => [p, String(vals[i])]));
}

// A light that can't be reached (not configured and not discovered, or its address stopped answering)
// gets a setup hint; the light's own replies (light rejected ...) pass through unchanged.
function lightError(name, e) {
  const m = (e && e.message) || String(e);
  if (!/not found on the LAN|address unknown|timeout talking|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(m)) return m;
  return `${m}; check that the ${name} has power, is on this network and has LAN Control on in the Yeelight app`
    + (/not found on the LAN/.test(m) ? ', and that the firewall lets node receive the discovery replies (inbound UDP)' : '');
}

// ---------------------------------------------------------------- helpers
const hex = (n) => '#' + (Number(n) >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase();
const sleepTuple = (ms) => `${Math.max(50, Math.round(ms))},7,0,0`;
const tupleMs = (tp) => Number(tp.split(',')[0]);
const flowMs = (tuples) => tuples.reduce((s, tp) => s + tupleMs(tp), 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function hsvToRgb(h, s) {
  const f = (n) => { const k = (n + h / 60) % 6; return 1 - (s / 100) * Math.max(0, Math.min(k, 4 - k, 1)); };
  return y.rgb(Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255));
}

const COLORS = {
  red: [255, 0, 0], crimson: [220, 20, 60], coral: [255, 100, 70], orange: [255, 120, 0], amber: [255, 160, 0],
  gold: [255, 190, 30], yellow: [255, 230, 0], lime: [160, 255, 0], green: [0, 230, 60], mint: [60, 255, 160],
  teal: [0, 180, 150], turquoise: [40, 220, 200], cyan: [0, 255, 255], aqua: [0, 255, 255], sky: [80, 180, 255],
  blue: [0, 60, 255], navy: [10, 20, 130], indigo: [75, 0, 200], purple: [140, 0, 255], violet: [170, 60, 255],
  lavender: [190, 150, 255], magenta: [255, 0, 255], pink: [255, 90, 170], rose: [255, 40, 100],
  peach: [255, 170, 110], white: [255, 255, 255], 'warm white': [255, 190, 120], 'cool white': [220, 235, 255],
};

function parseColor(v, field = 'color') {
  if (typeof v !== 'string' || !v.trim()) throw new UserError(`${field} must be "#RRGGBB" or a color name (${Object.keys(COLORS).join(', ')})`);
  const s = v.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  let n;
  if (COLORS[s]) n = y.rgb(...COLORS[s]);
  else if (/^#?[0-9a-f]{6}$/.test(s)) n = parseInt(s.replace('#', ''), 16);
  else if (/^#?[0-9a-f]{3}$/.test(s)) n = parseInt(s.replace('#', '').split('').map((c) => c + c).join(''), 16);
  else throw new UserError(`${field}: unknown color "${v}". Use "#RRGGBB" or one of: ${Object.keys(COLORS).join(', ')}`);
  if (n === 0) throw new UserError(`${field}: black can't be shown by a light; lower the brightness instead`);
  return n;
}

function num(v, field, lo, hi, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserError(`${field} must be a number from ${lo} to ${hi}`);
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function oneOf(v, field, allowed, def) {
  if (v === undefined || v === null || v === '') {
    if (def === undefined) throw new UserError(`${field} is required (${allowed.join(' | ')})`);
    return def;
  }
  const s = String(v).toLowerCase();
  if (!allowed.includes(s)) throw new UserError(`${field} must be one of ${allowed.join(' | ')}, got "${v}"`);
  return s;
}

const lightsOf = (v, def) => {
  const l = oneOf(v, 'light', ['strip', 'bulb', 'both'], def);
  return l === 'both' ? ['strip', 'bulb'] : [l];
};

function pidAlive(file) {
  try {
    const pid = Number(fs.readFileSync(path.join(DIR, file), 'utf8').trim());
    if (!pid) return 0;
    try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : 0; }
  } catch { return 0; }
}
const glowPid = () => pidAlive('GLOW_ACTIVE');
// Screen glow runs inside the tray app yeelight-tray.exe (the separate yeelight-tray project), placed
// next to this file. Injectable so the selftest can
// use a stub instead of the real exe.
const glowCmd = { exe: () => path.join(DIR, 'yeelight-tray.exe'), args: (a) => a };

function trayRun(args, ms) {
  return new Promise((res) => execFile(glowCmd.exe(), glowCmd.args(args), { cwd: DIR, windowsHide: true, timeout: ms },
    (err, so, se) => res({ err, out: `${so || ''}`.trim(), errOut: `${se || ''}`.trim() })));
}

// `yeelight-tray.exe --status` JSON: {running, pid, glow, paused, paused_until, state, claude, ...}.
// null when the exe is missing or did not answer (callers fall back to the GLOW_ACTIVE pid check).
async function trayStatus() {
  if (!fs.existsSync(glowCmd.exe())) return null;
  const r = await trayRun(['--status'], 4000);
  const line = r.out.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

function trayText(s) {
  if (!s.glow) return `screen glow off (tray running, pid ${s.pid})`;
  if (s.paused) return `screen glow paused until ${s.paused_until} (tray pid ${s.pid}); it resumes by itself`;
  const st = { glowing: 'running', claude: 'running (showing Claude status)', strip_off: 'on, waiting for the strip to be switched on',
    strip_busy: 'on, waiting (another program streams to the strip)', unreachable: 'on, strip unreachable (retrying)',
    firewall: 'on, but the strip cannot connect back (Windows Firewall?)', retrying: 'on, reconnecting', connecting: 'on, connecting',
    no_strip: 'on, no strip found (set strip_host in yeelight-tray.ini, or allow discovery through the firewall)' }[s.state] || s.state;
  return `screen glow ${st} (tray pid ${s.pid})`;
}

// ---- STRIP_MOOD marker (see header). A claim is a token; a timed claim (glow) or an effect only removes
// the marker if it is still its own, so a newer mood's marker survives.
const moodFile = () => path.join(DIR, 'STRIP_MOOD');
let moodClaim = null; // { token, timer }
let moodSeq = 0;
function stripRelease(token) {
  if (token !== undefined && (!moodClaim || moodClaim.token !== token)) return;
  if (moodClaim && moodClaim.timer) clearTimeout(moodClaim.timer);
  moodClaim = null;
  // A claim ending on its own (timer / effect end) leaves another session's marker alone; an explicit
  // stop / set_light / scene / screen_glow (no token) removes any marker, since the strip changed.
  if (token !== undefined && pidAlive('STRIP_MOOD') !== process.pid) return;
  try { fs.unlinkSync(moodFile()); } catch {}
}
function stripClaim(ms) {
  stripRelease();
  const token = ++moodSeq;
  moodClaim = { token, timer: null };
  try { fs.writeFileSync(moodFile(), String(process.pid)); } catch (e) { log('cannot write STRIP_MOOD:', e.message); }
  if (ms) { moodClaim.timer = setTimeout(() => stripRelease(token), ms + 1000); moodClaim.timer.unref(); }
  return token;
}
process.on('exit', () => { if (pidAlive('STRIP_MOOD') === process.pid) { try { fs.unlinkSync(moodFile()); } catch {} } });

// Shown on strip results only with an older status-hook.js that predates STRIP_MOOD. Errs towards showing the note.
function hookNote() {
  const hook = path.join(DIR, 'status-hook.js');
  if (!fs.existsSync(hook) || fs.existsSync(path.join(DIR, 'DISABLED'))) return '';
  try { if (fs.readFileSync(hook, 'utf8').includes('STRIP_MOOD')) return ''; } catch {}
  return ' (note: the Claude status hook, if enabled, will end this at the end of the turn)';
}
const FLOW_ENDS = ' (a flow was already running, a mood or the status hook\'s working glow: it ends for good, and the light returns to its state from before that flow)';

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]);
}

// Loaded lazily and reloaded only when the file changes: daylight.js is optional and may be mid-edit.
let dayCache = { mtime: 0, mod: null };
function daylightModule() {
  const file = path.join(DIR, 'daylight.js');
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { throw new Error('daylight.js is not installed'); }
  if (dayCache.mod && dayCache.mtime === mtime) return dayCache.mod;
  try { delete require.cache[require.resolve(file)]; } catch {}
  dayCache = { mtime, mod: require(file) };
  return dayCache.mod;
}
async function daylightCall(fn) {
  const m = daylightModule();
  if (typeof m[fn] !== 'function') throw new Error(`daylight.js has no ${fn}()`);
  return withTimeout(m[fn](), 5000, `daylight.${fn}()`);
}
// After set_light / scene changed the bulb: daylight.js must treat it as a manual choice, or its next tick
// would see a freshly turned-on bulb and glide it back to the daylight curve. Never fails the tool.
function daylightManual() {
  try { const m = daylightModule(); if (typeof m.markManual === 'function') m.markManual(); } catch (e) {
    if (!/not installed/.test(e.message)) log('daylight markManual:', e.message);
  }
}

// Common gate for every tool that changes a light. Returns { state } or { skip: reason }.
async function gate(name, { allowOff = false } = {}) {
  if (name === 'strip' && glowPid()) return { skip: 'screen glow is driving the strip (stop it with screen_glow action "stop" first)' };
  const state = await readState(name);
  if (state.music_on === '1') return { skip: 'in music mode (another program is streaming to it)' };
  if (state.power !== 'on' && !allowOff) return { skip: 'it is off, left unchanged (it is only turned on when asked explicitly)' };
  return { state };
}

// Runs fn(name) for each light (in parallel, each in its own queue) and gathers per-light lines.
async function perLight(names, fn) {
  const out = await Promise.all(names.map((n) => withLight(n, () => fn(n))
    .then((msg) => ({ n, msg, err: false }), (e) => ({ n, msg: `error: ${lightError(n, e)}`, err: true }))));
  return { text: out.map((o) => `${o.n}: ${o.msg}`).join('\n'), isError: out.every((o) => o.err) };
}

// ---------------------------------------------------------------- background effects
// Same chunking as yeelight.playFlow (every chunk action 0, a padding sleep bridges to the next chunk,
// so the light ends in its pre-effect state), but cancellable: stop and any other change bump `fxGen`
// so no further chunk is sent.
const PAD_MS = 400;
let fxGen = 0;
let fxRun = null; // { name, gen, endsAt }
let fxStarting = false; // set synchronously while play_effect checks the lights (parallel tool calls)

function cancelEffect() {
  if (fxRun) log(`effect ${fxRun.name} cancelled`);
  fxGen++;
  fxRun = null;
}

async function playChunks(name, tuples, gen) {
  const chunks = y.chunkFlow(tuples);
  for (let i = 0; i < chunks.length; i++) {
    if (gen !== fxGen) return;
    const last = i === chunks.length - 1;
    const body = last ? chunks[i] : [...chunks[i], sleepTuple(PAD_MS)];
    const t0 = Date.now();
    const sent = await withLight(name, async () => {
      if (gen !== fxGen) return false;
      if (name === 'strip' && glowPid()) return false; // screen glow took the strip over
      await cmd(name, [['start_cf', [body.length, 0, y.flow(body)]]], 2500);
      return true;
    });
    if (!sent) return;
    await wait(Math.max(0, flowMs(chunks[i]) + (last ? 0 : 120) - (Date.now() - t0)));
  }
}

// ---------------------------------------------------------------- tools
const SCENES = {
  movie: { bulb: { ct: 2700, bright: 10 }, strip: { rgb: y.rgb(20, 40, 160), bright: 30 } },
  reading: { bulb: { ct: 4000, bright: 100 }, strip: { ct: 3000, bright: 40 } },
  focus: { bulb: { ct: 5000, bright: 100 }, strip: { ct: 4500, bright: 50 } },
  relax: { bulb: { ct: 2400, bright: 45 }, strip: { rgb: y.rgb(255, 120, 30), bright: 35 } },
  night: { bulb: { ct: 1900, bright: 8 }, strip: { rgb: y.rgb(255, 80, 0), bright: 5 } },
};

let EFFECT_NAMES = [];
try { EFFECT_NAMES = Object.keys(require('./effects').EFFECTS); } catch (e) { log('effects.js not loadable:', e.message); }

const lightProp = { type: 'string', enum: ['strip', 'bulb', 'both'] };
const colorProp = { type: 'string', description: '"#RRGGBB" or a color name: ' + Object.keys(COLORS).join(', ') };

const TOOLS = [
  {
    name: 'light_status',
    description: 'Read-only. Current state of the light strip ("strip") and the color bulb ("bulb"): power, brightness (1-100), color mode (ct = white temperature in Kelvin, rgb = color), color, whether an on-device flow is running, music mode; plus whether screen glow (yeelight-tray.exe) is running, the daylight automation status and any effect playing. While a flow runs, the lights report the color they will return to, not the flowing color.',
    inputSchema: { type: 'object', properties: { light: { ...lightProp, default: 'both' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_light',
    description: 'Set one or both lights. Power changes ONLY if `power` is given; if a light is off and power is not "on", it is left alone and reported as off. Give either `color` or `ct`, not both. Changes glide smoothly. Any running flow/mood/effect on that light is stopped first.',
    inputSchema: {
      type: 'object',
      properties: {
        light: lightProp,
        power: { type: 'string', enum: ['on', 'off'], description: 'Only when the user asked to switch the light on or off.' },
        color: colorProp,
        ct: { type: 'integer', minimum: 1700, maximum: 6500, description: 'White color temperature in Kelvin (1700 candle .. 2700 warm .. 4000 neutral .. 6500 daylight).' },
        brightness: { type: 'integer', minimum: 1, maximum: 100 },
        transition_ms: { type: 'integer', minimum: 30, maximum: 10000, default: 800 },
      },
      required: ['light'],
    },
  },
  {
    name: 'scene',
    description: 'Apply a preset to both lights with a 1.5s glide. movie: dim warm bulb + blue strip; reading: bright neutral bulb + warm strip; focus: cool bright; relax: warm amber; night: very dim orange. Lights that are off are skipped (and reported) unless power_on_if_off is true, which only the user should ask for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: Object.keys(SCENES) },
        power_on_if_off: { type: 'boolean', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'mood',
    description: 'Endless, slow, smooth glide through a palette of 2-6 colors, running on the lights themselves (no PC needed). Invent palettes freely for prompts like "rainy cafe" (e.g. ["#2B3A55","#C08552","#5B6D8A"]), "sunset", "deep ocean", "forest at dusk". With light "both", the bulb runs the same palette at a different offset so the two lights differ. Lights that are off are skipped. End it with the stop tool (lights then return to their previous state).',
    inputSchema: {
      type: 'object',
      properties: {
        colors: { type: 'array', minItems: 2, maxItems: 6, items: colorProp },
        seconds_per_color: { type: 'number', minimum: 2, maximum: 60, default: 8 },
        brightness: { type: 'integer', minimum: 1, maximum: 100, default: 60 },
        light: { ...lightProp, default: 'both' },
      },
      required: ['colors'],
    },
  },
  {
    name: 'glow',
    description: 'Short notification glow: glides to a color at 70% in 0.8s, holds for `seconds`, glides back, and the light restores its previous state on its own. Returns immediately. Skips lights that are off. If a mood (or other flow) is running on that light, the glow ENDS it: afterwards the light returns to its state from before the mood, and the mood does not resume.',
    inputSchema: {
      type: 'object',
      properties: {
        color: colorProp,
        seconds: { type: 'number', minimum: 1, maximum: 30, default: 4 },
        light: { ...lightProp, default: 'strip' },
      },
      required: ['color'],
    },
  },
  {
    name: 'play_effect',
    description: 'Play a show-off effect on both lights in the background; returns immediately with the expected duration, and both lights return to their previous state afterwards. Effects: ' + EFFECT_NAMES.join(', ') + '. Note: pingpong, storm and heartbeat FLASH/BLINK (pick those only when asked; slow glides are the gentler default); aurora, rainbow and sunrise glide; candle flickers gently. Lights that are off are skipped. stop ends it early. A mood (or other flow) running on a light is ENDED by the effect and does not resume afterwards. Only one effect at a time.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', enum: EFFECT_NAMES } }, required: ['name'] },
  },
  {
    name: 'stop',
    description: 'End any running mood, glow or effect. The lights return to the state they had before it started. Does not change power. (Screen glow has its own stop: screen_glow action "stop".)',
    inputSchema: { type: 'object', properties: { light: { ...lightProp, default: 'both' } } },
  },
  {
    name: 'daylight',
    description: 'Daylight automation (bulb color temperature follows the time of day). "off" pauses it (creates the DAYLIGHT_OFF flag file), "on" re-enables it, "status" reports it, "resume" clears a manual override so it takes control again.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'status', 'resume'] } }, required: ['action'] },
  },
  {
    name: 'screen_glow',
    description: 'Screen-synced ambient light on the light strip (the yeelight-tray.exe tray app samples the screen colors and streams them to the strip, like a TV backlight). start turns it on (starting the tray app if needed) and waits (up to ~10s) until the tray reports it is glowing; it refuses if the strip is off and never turns it on; a mood/effect on the strip ends. stop turns it off (the strip returns to its previous state; the tray app keeps running), status tells whether it is on, paused (the user can pause it from the tray menu) or waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'] },
      },
      required: ['action'],
    },
  },
];

function describe(name, s) {
  if (s.power !== 'on') return { power: s.power };
  const o = { power: 'on', brightness: Number(s.bright) };
  if (s.color_mode === '2') Object.assign(o, { mode: 'ct', ct: Number(s.ct) });
  else if (s.color_mode === '3') Object.assign(o, { mode: 'hsv', hue: Number(s.hue), sat: Number(s.sat), rgb: hex(hsvToRgb(Number(s.hue), Number(s.sat))) });
  else Object.assign(o, { mode: 'rgb', rgb: hex(s.rgb) });
  o.flowing = s.flowing === '1';
  o.music_on = s.music_on === '1';
  if (o.flowing) o.note = 'a flow is running; color/brightness above are what it returns to';
  return o;
}

const handlers = {
  async light_status(a) {
    const names = lightsOf(a.light, 'both');
    const out = {};
    await Promise.all(names.map(async (n) => {
      try { out[n] = describe(n, await readState(n)); } catch (e) { out[n] = { error: lightError(n, e) }; }
    }));
    const gp = glowPid();
    out.screen_glow = gp ? { running: true, pid: gp } : { running: false };
    out.effect = fxRun ? { name: fxRun.name, seconds_left: Math.max(0, Math.round((fxRun.endsAt - Date.now()) / 1000)) } : null;
    try { out.daylight = await daylightCall('status'); } catch (e) { out.daylight = { unavailable: e.message }; }
    out.daylight_flag_off = fs.existsSync(path.join(DIR, 'DAYLIGHT_OFF'));
    const lightErr = names.every((n) => out[n].error);
    return { text: JSON.stringify(out, null, 2), isError: lightErr };
  },

  async set_light(a) {
    const names = lightsOf(a.light);
    const power = a.power === undefined || a.power === null || a.power === '' ? undefined : oneOf(a.power, 'power', ['on', 'off']);
    const color = a.color === undefined || a.color === null || a.color === '' ? undefined : parseColor(a.color);
    const ct = num(a.ct, 'ct', 1700, 6500);
    const bright = num(a.brightness, 'brightness', 1, 100);
    const ms = num(a.transition_ms, 'transition_ms', 30, 10000, 800);
    if (color !== undefined && ct !== undefined) throw new UserError('give either color or ct, not both');
    if (!power && color === undefined && ct === undefined && bright === undefined) throw new UserError('nothing to change: give power, color, ct or brightness');
    cancelEffect();
    if (names.includes('strip')) stripRelease();
    return perLight(names, async (n) => {
      const g = await gate(n, { allowOff: true });
      if (g.skip) return `skipped, ${g.skip}`;
      const s = g.state;
      const cmds = [];
      if (s.flowing === '1') cmds.push(['stop_cf', []]);
      if (power === 'off') {
        if (s.power !== 'on') return 'already off';
        cmds.push(['set_power', ['off', 'smooth', ms]]);
        await cmd(n, cmds);
        return 'turned off' + (color !== undefined || ct !== undefined || bright !== undefined ? ' (color/brightness ignored)' : '');
      }
      if (s.power !== 'on' && power !== 'on') return 'it is off, left unchanged (pass power:"on" only if the user asked to turn it on)';
      if (s.power !== 'on') cmds.push(['set_power', ['on', 'smooth', ms]]);
      if (color !== undefined) cmds.push(['set_rgb', [color, 'smooth', ms]]);
      if (ct !== undefined) cmds.push(['set_ct_abx', [ct, 'smooth', ms]]);
      if (bright !== undefined) cmds.push(['set_bright', [bright, 'smooth', ms]]);
      if (!cmds.length) return 'already on';
      await cmd(n, cmds);
      // Only a color / ct / brightness choice is manual; a bare power-on lets the daylight curve take over.
      if (n === 'bulb' && (color !== undefined || ct !== undefined || bright !== undefined)) daylightManual();
      const parts = [];
      if (s.power !== 'on') parts.push('turned on');
      if (s.flowing === '1') parts.push('stopped running flow');
      if (color !== undefined) parts.push(`color ${hex(color)}`);
      if (ct !== undefined) parts.push(`${ct}K`);
      if (bright !== undefined) parts.push(`brightness ${bright}%`);
      return parts.join(', ') + ` (${ms}ms glide)`;
    });
  },

  async scene(a) {
    const name = oneOf(a.name, 'name', Object.keys(SCENES));
    const powerOn = a.power_on_if_off === true || a.power_on_if_off === 'true';
    cancelEffect();
    stripRelease();
    const ms = 1500;
    return perLight(['bulb', 'strip'], async (n) => {
      const p = SCENES[name][n];
      const g = await gate(n, { allowOff: powerOn });
      if (g.skip) return `skipped, ${g.skip}`;
      const cmds = [];
      if (g.state.flowing === '1') cmds.push(['stop_cf', []]);
      if (g.state.power !== 'on') cmds.push(['set_power', ['on', 'smooth', ms]]);
      cmds.push(p.ct ? ['set_ct_abx', [p.ct, 'smooth', ms]] : ['set_rgb', [p.rgb, 'smooth', ms]]);
      cmds.push(['set_bright', [p.bright, 'smooth', ms]]);
      await cmd(n, cmds);
      if (n === 'bulb') daylightManual();
      return `${name}: ${p.ct ? p.ct + 'K' : hex(p.rgb)} at ${p.bright}%` + (g.state.power !== 'on' ? ' (turned on as asked)' : '');
    });
  },

  async mood(a) {
    if (!Array.isArray(a.colors) || a.colors.length < 2 || a.colors.length > 6) throw new UserError('colors must be an array of 2 to 6 colors');
    const pal = a.colors.map((c, i) => parseColor(c, `colors[${i}]`));
    const sec = Math.min(60, Math.max(2, Number(a.seconds_per_color ?? 8) || 8));
    const bright = num(a.brightness, 'brightness', 1, 100, 60);
    const names = lightsOf(a.light, 'both');
    cancelEffect();
    return perLight(names, async (n) => {
      const g = await gate(n);
      if (g.skip) return `skipped, ${g.skip}`;
      const off = n === 'bulb' && names.length === 2 ? Math.floor(pal.length / 2) : 0;
      const order = pal.map((_, i) => pal[(i + off) % pal.length]);
      const tuples = order.map((c) => y.tuple(sec * 1000, 1, c, bright));
      await cmd(n, [['start_cf', [0, 0, y.flow(tuples)]]]);
      if (n === 'strip') stripClaim();
      return `mood running: ${order.map(hex).join(' > ')}, ${sec}s per color at ${bright}% (stop to end)` + (n === 'strip' ? hookNote() : '');
    });
  },

  async glow(a) {
    const color = parseColor(a.color);
    const sec = Math.min(30, Math.max(1, Number(a.seconds ?? 4) || 4));
    const names = lightsOf(a.light, 'strip');
    cancelEffect();
    return perLight(names, async (n) => {
      const g = await gate(n);
      if (g.skip) return `skipped, ${g.skip}`;
      const s = g.state;
      const b = Number(s.bright) || 50;
      const back = s.color_mode === '2' ? y.tuple(800, 2, Number(s.ct), b)
        : s.color_mode === '3' ? y.tuple(800, 1, hsvToRgb(Number(s.hue), Number(s.sat)), b)
          : y.tuple(800, 1, Number(s.rgb) || 0xffffff, b);
      const tuples = [y.tuple(800, 1, color, 70), sleepTuple(sec * 1000), back];
      await cmd(n, [['start_cf', [tuples.length, 0, y.flow(tuples)]]]);
      if (n === 'strip') stripClaim(flowMs(tuples));
      return `glowing ${hex(color)} for ${sec}s, then back (${(flowMs(tuples) / 1000).toFixed(1)}s total)`
        + (s.flowing === '1' ? FLOW_ENDS : '') + (n === 'strip' ? hookNote() : '');
    });
  },

  async play_effect(a) {
    const name = oneOf(a.name, 'name', EFFECT_NAMES);
    // Checked and claimed synchronously (no await in between), so parallel calls can't both pass.
    if (fxStarting) throw new UserError('another effect is starting right now; call stop first or wait');
    if (fxRun && Date.now() < fxRun.endsAt + 2000) {
      throw new UserError(`effect "${fxRun.name}" is still playing (~${Math.max(0, Math.round((fxRun.endsAt - Date.now()) / 1000))}s left); call stop first or wait`);
    }
    fxStarting = true;
    try {
      const gen0 = fxGen;
      const fx = require('./effects').EFFECTS[name]();
      const skipped = [];
      const lights = {};
      const ending = [];
      await Promise.all(Object.keys(fx).map(async (n) => {
        try {
          const g = await gate(n);
          if (g.skip) skipped.push(`${n}: skipped, ${g.skip}`);
          else { lights[n] = fx[n]; if (g.state.flowing === '1') ending.push(n); }
        } catch (e) { skipped.push(`${n}: error: ${lightError(n, e)}`); }
      }));
      if (!Object.keys(lights).length) return { text: `nothing played:\n${skipped.join('\n')}`, isError: true };
      // stop / set_light / scene / mood / glow arrived while the lights were being checked: they win.
      if (fxGen !== gen0) return { text: `${name} cancelled before it started (another light change came in)`, isError: true };
      cancelEffect();
      const gen = fxGen;
      const ms = Math.max(...Object.values(lights).map(flowMs));
      fxRun = { name, gen, endsAt: Date.now() + ms };
      const token = lights.strip ? stripClaim() : undefined;
      Promise.all(Object.entries(lights).map(([n, tp]) => playChunks(n, tp, gen).catch((e) => log(`effect ${name} on ${n}:`, e.message))))
        .finally(() => { if (fxRun && fxRun.gen === gen) fxRun = null; if (token !== undefined) stripRelease(token); });
      return `playing ${name} on ${Object.keys(lights).join(' + ')} for about ${(ms / 1000).toFixed(1)}s; the lights restore themselves afterwards`
        + (ending.length ? `\n${ending.join(' + ')}:${FLOW_ENDS}` : '')
        + (lights.strip && hookNote() ? `\nstrip:${hookNote()}` : '')
        + (skipped.length ? `\n${skipped.join('\n')}` : '');
    } finally {
      fxStarting = false;
    }
  },

  async stop(a) {
    const names = lightsOf(a.light, 'both');
    const had = fxRun && fxRun.name;
    cancelEffect();
    if (names.includes('strip')) stripRelease();
    const r = await perLight(names, async (n) => {
      if (n === 'strip' && glowPid()) return 'screen glow is driving the strip; use screen_glow action "stop"';
      const s = await readState(n);
      if (s.power !== 'on') return 'off, nothing to stop';
      if (s.flowing !== '1') return 'no flow running';
      await cmd(n, [['stop_cf', []]]);
      return 'stopped, returning to its previous state';
    });
    if (had) r.text = `effect ${had} cancelled\n` + r.text;
    return r;
  },

  async daylight(a) {
    const action = oneOf(a.action, 'action', ['on', 'off', 'status', 'resume']);
    const flag = path.join(DIR, 'DAYLIGHT_OFF');
    let msg;
    if (action === 'off') { fs.writeFileSync(flag, new Date().toISOString() + '\n'); msg = 'daylight paused (DAYLIGHT_OFF created)'; }
    else if (action === 'on') { try { fs.unlinkSync(flag); msg = 'daylight enabled (DAYLIGHT_OFF removed)'; } catch (e) { if (e.code !== 'ENOENT') throw e; msg = 'daylight already enabled'; } }
    else if (action === 'resume') { const r = await daylightCall('resume'); msg = 'manual override cleared' + (r !== undefined ? `: ${JSON.stringify(r)}` : ''); }
    let st;
    try { st = await daylightCall('status'); } catch (e) {
      if (action === 'status') return { text: `daylight unavailable: ${e.message}; flag DAYLIGHT_OFF ${fs.existsSync(flag) ? 'present' : 'absent'}`, isError: true };
      st = { unavailable: e.message };
    }
    return (msg ? msg + '\n' : '') + JSON.stringify(st, null, 2);
  },

  async screen_glow(a) {
    const action = oneOf(a.action, 'action', ['start', 'stop', 'status']);
    const exe = glowCmd.exe();
    const tray = await trayStatus();
    const trayOn = !!(tray && tray.running);
    const pid = glowPid(); // whoever owns the strip for glow: the tray, or another (older) glow program
    const legacy = pid && !(trayOn && tray.pid === pid) ? pid : 0;
    if (action === 'status') {
      if (trayOn) return trayText(tray) + (legacy ? `; another glow program (pid ${legacy}) owns the strip` : '');
      return pid ? `screen glow running (pid ${pid})` : 'screen glow not running';
    }
    if (!fs.existsSync(exe)) throw new UserError(`yeelight-tray.exe not found in ${DIR}; build the yeelight-tray project with "cargo build --release" and copy the exe here`);
    if (action === 'start') {
      if (trayOn && tray.glow && !tray.paused && (tray.state === 'glowing' || tray.state === 'claude')) return `screen glow already running (tray pid ${tray.pid})`;
      if (legacy) return `screen glow already running (another glow program, pid ${legacy})`;
      let st;
      try { st = await readState('strip'); } catch (e) { return { text: `strip: error: ${lightError('strip', e)}`, isError: true }; }
      if (st.power !== 'on') return { text: 'the strip is off; screen glow never turns it on (switch it on first, only if the user asked)', isError: true };
      if (st.music_on === '1') return { text: 'the strip is already in music mode (another program is streaming to it); screen glow not started', isError: true };
      cancelEffect(); // a running effect must not keep sending chunks once glow owns the strip
      stripRelease();
      // "--glow on" hands the command to a running tray and exits, or becomes the tray itself.
      const child = await new Promise((res, rej) => {
        const c = spawn(exe, glowCmd.args(['--glow', 'on']), { cwd: DIR, detached: true, windowsHide: true, stdio: 'ignore' });
        c.once('error', rej);
        c.once('spawn', () => res(c));
      });
      child.unref();
      // Confirmed only when the tray reports it is glowing (it owns the strip in music mode).
      const deadline = Date.now() + 10000;
      let last = null;
      while (Date.now() < deadline) {
        await wait(600);
        const s = await trayStatus();
        if (!s || !s.running) continue;
        last = s;
        if (s.state === 'glowing' || s.state === 'claude') {
          return `screen glow started (tray pid ${s.pid}); the strip follows the screen until screen_glow stop`
            + (st.flowing === '1' ? '; the flow that was running on the strip ended' : '');
        }
        if (['strip_off', 'strip_busy', 'unreachable', 'firewall', 'no_strip'].includes(s.state)) {
          const hint = s.state === 'firewall' ? ' Windows Firewall probably blocks yeelight-tray.exe (allow it on Private networks).' : '';
          return { text: `screen glow is on but not running: ${trayText(s)}.${hint} The tray keeps retrying; screen_glow stop turns it off.`, isError: true };
        }
      }
      return `yeelight-tray.exe started but glow is not confirmed yet${last ? ` (${trayText(last)})` : ''}; check with screen_glow action "status"`;
    }
    // stop: the tray restores the strip in the background; wait until it releases GLOW_ACTIVE.
    let out = '';
    if (trayOn) { const r = await trayRun(['--glow', 'off'], 7000); out = r.err ? (r.out || r.err.message) : ''; }
    // Another glow program owns GLOW_ACTIVE: GLOW_STOP is the legacy stop request it honors (the tray
    // ignores a GLOW_STOP aimed at another program).
    if (legacy) { try { fs.writeFileSync(path.join(DIR, 'GLOW_STOP'), 'stop'); } catch (e) { out = `cannot create GLOW_STOP: ${e.message}`; } }
    for (let i = 0; i < 35 && glowPid(); i++) await wait(200);
    const still = glowPid();
    if (still) return { text: `screen glow did not stop (pid ${still} still owns the strip)${out ? ': ' + out : ''}`, isError: true };
    if (!pid && !(trayOn && tray.glow)) return 'screen glow was not running';
    return 'screen glow stopped; the strip returns to its previous state';
  },
};

async function callTool(name, args) {
  try {
    const r = await withTimeout(handlers[name](args && typeof args === 'object' ? args : {}), 20000, name);
    const o = typeof r === 'string' ? { text: r } : r;
    const res = { content: [{ type: 'text', text: o.text }] };
    if (o.isError) res.isError = true;
    return res;
  } catch (e) {
    if (!(e instanceof UserError)) log(`${name} failed:`, e && e.stack || e);
    return { content: [{ type: 'text', text: (e instanceof UserError ? '' : 'error: ') + (e && e.message || String(e)) }], isError: true };
  }
}

// ---------------------------------------------------------------- JSON-RPC
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'Invalid Request');
  // An id that is neither string nor number: reject before running anything.
  if (msg.id !== undefined && msg.id !== null && typeof msg.id !== 'string' && typeof msg.id !== 'number') return fail(null, -32600, 'Invalid Request');
  const hasId = msg.id !== undefined && msg.id !== null && (typeof msg.id === 'string' || typeof msg.id === 'number');
  if (msg.method === undefined && hasId) return null; // a response to us; we never send requests
  if (typeof msg.method !== 'string') return hasId ? fail(msg.id, -32600, 'Invalid Request') : null;
  const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
  let res;
  switch (msg.method) {
    case 'initialize':
      res = ok(msg.id, {
        protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'yeelight', version: '1.0.0' },
        instructions: 'Controls the light strip ("strip") and the color bulb ("bulb"). Prefer slow glides; never switch a light on or off unless the user asked for that light.',
      });
      break;
    case 'ping': res = ok(msg.id, {}); break;
    case 'tools/list': res = ok(msg.id, { tools: TOOLS }); break;
    case 'tools/call':
      if (!Object.prototype.hasOwnProperty.call(handlers, p.name)) res = fail(msg.id, -32602, `Unknown tool: ${p.name}`);
      else res = ok(msg.id, await callTool(p.name, p.arguments));
      break;
    default:
      if (msg.method.startsWith('notifications/') && !hasId) return null;
      res = fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
  return hasId ? res : null; // notifications never get a reply
}

function send(obj) { if (obj) rawOut(JSON.stringify(obj) + '\n'); }

async function onLine(line) {
  line = line.replace(/\r$/, '').trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send(fail(null, -32700, 'Parse error')); return; }
  try {
    if (Array.isArray(msg)) {
      if (!msg.length) { send(fail(null, -32600, 'Invalid Request')); return; }
      const out = (await Promise.all(msg.map((m) => dispatch(m).catch((e) => fail(m && m.id !== undefined ? m.id : null, -32603, e.message))))).filter(Boolean);
      if (out.length) send(out);
    } else {
      send(await dispatch(msg));
    }
  } catch (e) {
    log('dispatch error:', e && e.stack || e);
    if (msg && msg.id !== undefined) send(fail(msg.id, -32603, 'Internal error'));
  }
}

function serve() {
  // No explicit exit: once stdin closes, the process ends by itself after pending replies are flushed
  // (and after a background effect, if one is playing, has sent its last chunk).
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      onLine(line);
    }
    if (buf.length > 1e6) { buf = ''; send(fail(null, -32700, 'Parse error: line too long')); }
  });
  process.stdin.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; });
  process.stdin.on('error', () => {});
  log(`ready (pid ${process.pid})`);
}

// ---------------------------------------------------------------- offline selftest
async function selftest() {
  const os = require('os');
  const assert = require('assert');
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yeelight-mcp-selftest-'));
  y.sendTo = y.send = () => { throw new Error('selftest must not touch real lights'); };
  const lights = {
    strip: { power: 'on', bright: '40', ct: '3000', rgb: String(y.rgb(255, 100, 0)), hue: '0', sat: '0', color_mode: '1', flowing: '0', music_on: '0' },
    bulb: { power: 'off', bright: '80', ct: '2700', rgb: '16777215', hue: '0', sat: '0', color_mode: '2', flowing: '0', music_on: '0' },
  };
  const sent = [];
  let musicFollowsGlow = false; // fake strip reports music_on while a (stub) glow pid file is alive
  const ALLOWED = ['get_prop', 'set_power', 'set_rgb', 'set_ct_abx', 'set_bright', 'start_cf', 'stop_cf'];
  io.send = async (name, cmds) => cmds.map(([m, p]) => {
    assert(ALLOWED.includes(m), `forbidden method ${m}`);
    const size = JSON.stringify({ id: 99999, method: m, params: p }).length;
    assert(size <= MAX_MSG, `${m} too long: ${size}`);
    sent.push({ name, m, p, t: Date.now() });
    const L = lights[name];
    if (m === 'get_prop') return p.map((k) => (k === 'music_on' && name === 'strip' && musicFollowsGlow && glowPid() ? '1' : L[k] ?? ''));
    if (m === 'set_power') { L.power = p[0]; return ['ok']; }
    if (L.power !== 'on') return { error: { code: -1, message: 'client quota exceeded' } };
    if (m === 'start_cf') { assert.strictEqual(p[0] === 0 ? p[0] : p[2].split(',').length / 4, p[0], 'count must equal tuple count'); L.flowing = '1'; }
    if (m === 'stop_cf') L.flowing = '0';
    return ['ok'];
  });
  const call = async (name, args) => { sent.length = 0; const r = await callTool(name, args); log(`${name} ${JSON.stringify(args)} ->`, JSON.stringify(r.content[0].text), r.isError ? '[isError]' : ''); return r; };
  const methods = () => sent.map((s) => `${s.name}.${s.m}`);
  const powerCmds = () => sent.filter((s) => s.m === 'set_power');

  let r = await call('light_status', {});
  assert(!r.isError && JSON.parse(r.content[0].text).strip.power === 'on');
  assert.deepStrictEqual(methods(), ['strip.get_prop', 'bulb.get_prop']);

  // A light that can't be found (no config.json, discovery found nothing) is reported per light with a
  // setup hint; the other light still works and nothing crashes.
  const realSend = io.send;
  io.send = async (name, cmds, ms) => {
    if (name === 'bulb') throw new Error('bulb not found on the LAN (set lights.bulb.host in config.json)');
    return realSend(name, cmds, ms);
  };
  r = await call('light_status', {});
  const st0 = JSON.parse(r.content[0].text);
  assert(!r.isError && st0.strip.power === 'on' && /not found on the LAN.*LAN Control/.test(st0.bulb.error), 'missing bulb reported by light_status');
  r = await call('light_status', { light: 'bulb' }); assert(r.isError, 'only light missing: isError');
  r = await call('set_light', { light: 'bulb', brightness: 50 });
  assert(r.isError && /^bulb: error: bulb not found/.test(r.content[0].text), 'missing bulb reported by set_light');
  r = await call('scene', { name: 'relax' });
  assert(!r.isError && /bulb: error: bulb not found/.test(r.content[0].text) && /strip: relax/.test(r.content[0].text), 'scene still sets the strip');
  io.send = realSend;

  // Stub daylight.js in the temp dir: counts markManual() calls (bulb changes made by set_light / scene).
  const dayStub = path.join(DIR, 'daylight.js'), manualF = path.join(DIR, 'manual-count.txt');
  fs.writeFileSync(dayStub, `const fs=require('fs');exports.markManual=()=>{const f=${JSON.stringify(manualF)};fs.writeFileSync(f,String((Number(fs.existsSync(f)&&fs.readFileSync(f,'utf8'))||0)+1));};\n`);
  const manualCount = () => (fs.existsSync(manualF) ? Number(fs.readFileSync(manualF, 'utf8')) : 0);

  r = await call('set_light', { light: 'bulb', color: 'red' });
  assert(/off/.test(r.content[0].text) && !powerCmds().length && methods().length === 1, 'off bulb untouched');
  r = await call('set_light', { light: 'both', color: '#00ff88', brightness: 30 });
  assert.deepStrictEqual(methods().filter((m) => !m.endsWith('get_prop')), ['strip.set_rgb', 'strip.set_bright']);
  r = await call('set_light', { light: 'strip', color: 'red', ct: 3000 }); assert(r.isError);
  r = await call('set_light', { light: 'strip', color: 'chartreuse-ish' }); assert(r.isError);
  r = await call('set_light', { light: 'strip', color: '#000' }); assert(r.isError);
  r = await call('set_light', { light: 'lamp', color: 'red' }); assert(r.isError);

  r = await call('scene', { name: 'relax' });
  assert(!powerCmds().length && /bulb: skipped/.test(r.content[0].text));
  lights.strip.flowing = '1';
  r = await call('scene', { name: 'movie' });
  assert.deepStrictEqual(methods().filter((m) => m.startsWith('strip') && !m.endsWith('get_prop')), ['strip.stop_cf', 'strip.set_rgb', 'strip.set_bright']);
  assert.strictEqual(manualCount(), 0, 'off bulb left alone: no markManual');
  r = await call('scene', { name: 'night', power_on_if_off: true });
  assert.strictEqual(powerCmds().length, 1); assert.strictEqual(lights.bulb.power, 'on');
  assert.strictEqual(manualCount(), 1, 'scene turning the bulb on calls daylight markManual');

  // STRIP_MOOD marker + hook note (an older status-hook.js that does not know the marker)
  const moodF = path.join(DIR, 'STRIP_MOOD');
  fs.writeFileSync(path.join(DIR, 'status-hook.js'), '// old hook\n');
  r = await call('mood', { colors: ['#112233', '#445566', '#778899', '#AABBCC', '#DDEEFF', 'white'], seconds_per_color: 60, brightness: 100 });
  assert(!r.isError);
  const cf = sent.filter((s) => s.m === 'start_cf');
  assert.strictEqual(cf.length, 2); assert.notStrictEqual(cf[0].p[2], cf[1].p[2], 'bulb offset');
  assert(cf.every((s) => s.p[0] === 0 && s.p[1] === 0));
  assert.strictEqual(fs.readFileSync(moodF, 'utf8'), String(process.pid), 'mood writes STRIP_MOOD');
  assert(/strip: .*status hook/.test(r.content[0].text) && !/bulb: .*status hook/.test(r.content[0].text), 'hook note on strip only');
  r = await call('mood', { colors: ['red'] }); assert(r.isError);
  assert(fs.existsSync(moodF), 'a refused mood keeps the marker');

  r = await call('glow', { color: 'cyan', seconds: 30 });
  assert(!r.isError && sent.some((s) => s.m === 'start_cf' && s.p[0] === 3 && s.p[1] === 0));
  assert(/ends for good/.test(r.content[0].text), 'glow on a flowing light says the flow ends');
  assert(fs.existsSync(moodF) && moodClaim && moodClaim.timer, 'glow holds a timed claim');
  // tokens: an old claim's release must not remove a newer claim's marker
  const tOld = stripClaim(60000); const tNew = stripClaim();
  stripRelease(tOld); assert(fs.existsSync(moodF), 'stale token keeps newer marker');
  stripRelease(tNew); assert(!fs.existsSync(moodF), 'own token removes marker');
  const tMine = stripClaim(); fs.writeFileSync(moodF, String(process.ppid)); // another session's server took over
  stripRelease(tMine); assert(fs.existsSync(moodF), 'timed/effect release keeps another server\'s marker');
  stripRelease(); assert(!fs.existsSync(moodF), 'explicit release removes any marker');
  fs.writeFileSync(path.join(DIR, 'status-hook.js'), '// reads STRIP_MOOD\n');
  assert.strictEqual(hookNote(), '', 'no note once the hook honors STRIP_MOOD');
  fs.unlinkSync(path.join(DIR, 'status-hook.js'));
  assert.strictEqual(hookNote(), '', 'no note without a hook');

  for (const n of EFFECT_NAMES) {
    const fx = require('./effects').EFFECTS[n]();
    for (const tp of Object.values(fx)) for (const ch of y.chunkFlow(tp)) assert(msgSize('start_cf', [99, 0, y.flow([...ch, sleepTuple(PAD_MS)])]) <= MAX_MSG, `${n} chunk too long`);
  }
  r = await call('play_effect', { name: 'candle' });
  assert(!r.isError && /playing candle/.test(r.content[0].text));
  assert(fs.existsSync(moodF), 'effect on the strip claims STRIP_MOOD');
  r = await call('play_effect', { name: 'aurora' }); assert(r.isError, 'second effect refused');
  await wait(300);
  r = await call('stop', {});
  const stopAt = Date.now();
  assert(/cancelled/.test(r.content[0].text));
  assert(!fs.existsSync(moodF), 'stop removes STRIP_MOOD');
  sent.length = 0;
  await wait(2500);
  assert(!sent.some((s) => s.m === 'start_cf' && s.t >= stopAt), 'no chunk after stop');
  r = await call('play_effect', { name: 'nope' }); assert(r.isError);

  // Parallel play_effect calls: exactly one wins, and the start_cf sent is the winner's.
  sent.length = 0;
  const par = await Promise.all([callTool('play_effect', { name: 'candle' }), callTool('play_effect', { name: 'aurora' })]);
  log('parallel play_effect ->', par.map((x) => JSON.stringify(x.content[0].text)).join(' | '));
  assert.strictEqual(par.filter((x) => !x.isError).length, 1, 'exactly one parallel effect plays');
  const winner = par[0].isError ? 'aurora' : 'candle';
  assert(fxRun && fxRun.name === winner && new RegExp(`playing ${winner}`).test(par[par[0].isError ? 1 : 0].content[0].text));
  assert(/starting/.test(par[par[0].isError ? 0 : 1].content[0].text));
  assert(sent.filter((s) => s.m === 'start_cf').length >= 1 && sent.filter((s) => s.m === 'start_cf' && s.name === 'strip').length === 1, 'only the winner sent its first chunk');
  r = await call('stop', {});
  // A light change that lands while play_effect is still checking the lights wins over the effect.
  const pending = callTool('play_effect', { name: 'aurora' });
  const stopping = callTool('stop', {});
  const [pe] = await Promise.all([pending, stopping]);
  assert(pe.isError && /cancelled before/.test(pe.content[0].text) && !fxRun, 'stop during the gate cancels the effect');
  // An effect stops sending chunks to the strip once screen glow owns it.
  const tp20 = Array.from({ length: 20 }, () => y.tuple(100, 1, y.rgb(255, 0, 0), 50));
  assert(y.chunkFlow(tp20).length >= 2);
  sent.length = 0;
  const pc = playChunks('strip', tp20, fxGen);
  await wait(200);
  fs.writeFileSync(path.join(DIR, 'GLOW_ACTIVE'), String(process.pid));
  await pc;
  fs.unlinkSync(path.join(DIR, 'GLOW_ACTIVE'));
  assert.strictEqual(sent.filter((s) => s.m === 'start_cf').length, 1, 'no chunk after GLOW_ACTIVE appears');

  // JSON-RPC: bad id types are rejected without running anything; a request to notifications/* gets an error.
  sent.length = 0;
  let d = await dispatch({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' });
  assert(d && d.id === null && d.error.code === -32600);
  d = await dispatch({ jsonrpc: '2.0', id: true, method: 'tools/call', params: { name: 'stop', arguments: {} } });
  assert(d && d.error.code === -32600 && !sent.length, 'invalid id: tool not run');
  d = await dispatch({ jsonrpc: '2.0', id: 1, method: 'notifications/x' }); assert(d && d.id === 1 && d.error.code === -32601);
  d = await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }); assert.strictEqual(d, null);
  d = await dispatch({ jsonrpc: '2.0', id: 'a', method: 'ping' }); assert(d && d.id === 'a' && d.result);

  // An off bulb must only ever be read by the tools that don't take an explicit power argument.
  lights.bulb.power = 'off';
  lights.strip.flowing = '1';
  const bulbOnlyRead = () => sent.filter((s) => s.name === 'bulb').every((s) => s.m === 'get_prop') && !powerCmds().length;
  r = await call('mood', { colors: ['red', 'blue'] }); assert(bulbOnlyRead() && /bulb: skipped/.test(r.content[0].text));
  r = await call('glow', { color: 'red', light: 'both' }); assert(bulbOnlyRead() && /bulb: skipped/.test(r.content[0].text));
  r = await call('play_effect', { name: 'aurora' }); assert(bulbOnlyRead() && /bulb: skipped/.test(r.content[0].text));
  r = await call('stop', {}); assert(bulbOnlyRead() && /bulb: off/.test(r.content[0].text) && /strip: stopped/.test(r.content[0].text));
  r = await call('scene', { name: 'focus' }); assert(bulbOnlyRead());
  r = await call('set_light', { light: 'both', brightness: 50 }); assert(bulbOnlyRead());
  r = await call('set_light', { light: 'bulb', power: 'on', ct: 4000 });
  assert.deepStrictEqual(methods().filter((m) => !m.endsWith('get_prop')), ['bulb.set_power', 'bulb.set_ct_abx']);
  const manualBefore = manualCount();
  r = await call('set_light', { light: 'bulb', power: 'off' });
  assert.strictEqual(manualCount(), manualBefore, 'turning the bulb off: no markManual');
  r = await call('set_light', { light: 'bulb', power: 'on' });
  assert(!r.isError && lights.bulb.power === 'on' && manualCount() === manualBefore, 'bare power on: no markManual (daylight takes over)');
  r = await call('set_light', { light: 'bulb', power: 'off' });
  r = await call('set_light', { light: 'bulb', power: 'on', color: 'red' });
  assert(!r.isError && manualCount() === manualBefore + 1, 'set_light turning the bulb on calls daylight markManual');
  r = await call('set_light', { light: 'strip', power: 'off' });
  assert.strictEqual(lights.strip.power, 'off');
  fs.unlinkSync(dayStub);

  r = await call('daylight', { action: 'off' }); assert(fs.existsSync(path.join(DIR, 'DAYLIGHT_OFF')));
  r = await call('daylight', { action: 'on' }); assert(!fs.existsSync(path.join(DIR, 'DAYLIGHT_OFF')));
  r = await call('daylight', { action: 'status' }); assert(r.isError && /not installed/.test(r.content[0].text));
  r = await call('daylight', { action: 'resume' }); assert(r.isError);
  r = await call('screen_glow', { action: 'status' }); assert(/not running/.test(r.content[0].text));
  r = await call('screen_glow', { action: 'start' }); assert(r.isError && /cargo/.test(r.content[0].text));

  // screen_glow against a stub tray (node stub-tray.js ...); the real yeelight-tray.exe is never run.
  // The stub keeps its state in stub-state.json; "--glow on" in mode "glowing" owns GLOW_ACTIVE until "--glow off".
  const actF = path.join(DIR, 'GLOW_ACTIVE'), stopF = path.join(DIR, 'GLOW_STOP'), modeF = path.join(DIR, 'stub-mode.txt');
  const stub = path.join(DIR, 'stub-tray.js');
  fs.writeFileSync(stub, `const fs = require('fs'), path = require('path');
const S = path.join(__dirname, 'stub-state.json'), A = path.join(__dirname, 'GLOW_ACTIVE');
const rd = () => { try { return JSON.parse(fs.readFileSync(S, 'utf8')); } catch { return null; } };
const a = process.argv.slice(2);
if (a[0] === '--status') { const s = rd(); process.stdout.write(JSON.stringify(s && s.running ? s : { running: false }) + '\\n'); }
else if (a[0] === '--glow' && a[1] === 'on') {
  const mode = fs.readFileSync(path.join(__dirname, 'stub-mode.txt'), 'utf8').trim();
  fs.writeFileSync(S, JSON.stringify({ running: true, pid: process.pid, glow: true, paused: false, paused_until: null, state: mode, claude: false }));
  if (mode === 'glowing') {
    fs.writeFileSync(A, String(process.pid));
    setInterval(() => { if (!fs.existsSync(A)) process.exit(0); }, 100); setTimeout(() => process.exit(0), 8000);
  }
} else if (a[0] === '--glow' && a[1] === 'off') {
  const s = rd(); if (s) { s.glow = false; s.state = 'off'; fs.writeFileSync(S, JSON.stringify(s)); }
  try { if (s && fs.readFileSync(A, 'utf8').trim() === String(s.pid)) fs.unlinkSync(A); } catch {} // only its own
}
`);
  let spawns = 0;
  glowCmd.exe = () => process.execPath;
  glowCmd.args = (a) => { if (a[0] === '--glow' && a[1] === 'on') spawns++; return [stub, ...a]; };
  r = await call('screen_glow', { action: 'start' }); // strip is off here
  assert(r.isError && /strip is off/.test(r.content[0].text) && spawns === 0 && !powerCmds().length, 'off strip: refused, nothing spawned');
  lights.strip.power = 'on'; lights.strip.music_on = '1';
  r = await call('screen_glow', { action: 'start' });
  assert(r.isError && /music mode/.test(r.content[0].text) && spawns === 0, 'music mode: refused');
  lights.strip.music_on = '0';
  fs.writeFileSync(modeF, 'firewall');
  r = await call('screen_glow', { action: 'start' });
  assert(r.isError && /Firewall/.test(r.content[0].text) && spawns === 1, 'tray reports the firewall state');
  r = await call('screen_glow', { action: 'stop' }); assert(!r.isError && /stopped/.test(r.content[0].text), 'stop while waiting');
  r = await call('screen_glow', { action: 'status' }); assert(/screen glow off \(tray running/.test(r.content[0].text));
  fs.writeFileSync(modeF, 'no_strip');
  r = await call('screen_glow', { action: 'start' });
  assert(r.isError && /no strip found.*strip_host/.test(r.content[0].text) && spawns === 2, 'tray reports no_strip with a hint');
  r = await call('screen_glow', { action: 'stop' }); assert(!r.isError);
  fs.writeFileSync(modeF, 'glowing');
  r = await call('play_effect', { name: 'aurora' }); assert(!r.isError && fxRun);
  r = await call('screen_glow', { action: 'start' });
  assert(!r.isError && /screen glow started/.test(r.content[0].text) && !fxRun && spawns === 3, 'confirmed via --status; effect cancelled');
  r = await call('screen_glow', { action: 'start' }); assert(/already running/.test(r.content[0].text) && spawns === 3);
  r = await call('screen_glow', { action: 'status' }); assert(/screen glow running \(tray pid/.test(r.content[0].text));
  r = await call('screen_glow', { action: 'stop' });
  assert(!r.isError && /stopped/.test(r.content[0].text) && !fs.existsSync(actF), 'stop: --glow off, GLOW_ACTIVE released');
  // Another glow program owning the strip is stopped through GLOW_STOP.
  const legacy = spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(actF)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopF)})){fs.unlinkSync(${JSON.stringify(stopF)});fs.unlinkSync(${JSON.stringify(actF)});process.exit(0)}},100);setTimeout(()=>process.exit(0),8000)`], { cwd: DIR, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !glowPid(); i++) await wait(50);
  r = await call('screen_glow', { action: 'start' }); assert(/already running \(another glow program/.test(r.content[0].text) && spawns === 3, 'never starts over another glow program');
  r = await call('screen_glow', { action: 'stop' });
  assert(!r.isError && /stopped/.test(r.content[0].text) && !fs.existsSync(stopF) && !glowPid(), 'other glow program stopped via GLOW_STOP');
  await new Promise((res) => (legacy.exitCode !== null ? res() : legacy.once('exit', res)));
  await wait(300);

  fs.writeFileSync(path.join(DIR, 'GLOW_ACTIVE'), String(process.pid));
  lights.strip.power = 'on';
  r = await call('glow', { color: 'red' }); assert(/screen glow is driving/.test(r.content[0].text) && !sent.length);
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  log('SELFTEST PASSED');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest().then(() => process.exit(0), (e) => { log('SELFTEST FAILED:', e && e.stack || e); process.exit(1); });
  else serve();
}

module.exports = { TOOLS, handlers, callTool, dispatch, parseColor };
