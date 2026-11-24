// Circadian ("daylight") controller for the BULB only. Run every 10 min by Task Scheduler: node daylight.js tick
// Follows the sun at location.lat/lon from config.json, on this PC's local clock: cool white by day, warm and
// dimmer through the evening. Slow 20s glides only. Without a location, tick does nothing.
//
// Safety rules:
//  - Never turns the bulb on or off: no set_power / set_scene. If the bulb is off, nothing is sent.
//  - No set_default / set_name / cron_* or any persistent-settings command.
//  - Leaves the bulb alone while an effect/flow or music mode is running.
//  - Manual change (color picked, or ct/bright moved by hand) -> paused until the bulb is next off
//    (seen off, or unreachable, e.g. a wall switch or power cut). Time without contact (PC asleep,
//    DAYLIGHT_OFF, a long effect) never counts as "off", so a manual choice is never overwritten.
//  - Other programs that set the bulb should call markManual() afterwards (mcp-server.js does, after
//    set_light sets a color / ct / brightness and after scene).
//  - Pause everything: create an empty file named DAYLIGHT_OFF next to this script.
//  - tick() never throws and `tick` always exits 0. `status` and `plan` exit 1 when no location is set.
//
// CLI: node daylight.js tick | status | plan [YYYY-MM-DD] | resume | manual | selftest
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const y = require('./yeelight');

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'daylight-state.json');
const OFF_FILE = path.join(DIR, 'DAYLIGHT_OFF');
const LIGHT = 'bulb';

// { lat, lon } in decimal degrees (north / east positive) from config.json, or null when not set or invalid.
const NO_LOCATION = 'no location set. Set location.lat and location.lon in config.json (see config.example.json).';
function locationFrom(c) {
  const l = c && c.location;
  if (!l || typeof l !== 'object') return null;
  const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  const lat = num(l.lat), lon = num(l.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}
const LOC = locationFrom(y.config);
function needLoc(loc) {
  if (!loc) throw new Error(NO_LOCATION);
  return loc;
}

const MORNING_START_H = 4; // 00:00..04:00 keeps the night look; the pre-sunrise band starts here
const GLIDE_MS = 20000;
const SETTLE_MS = GLIDE_MS + 15000; // don't read the bulb mid-glide (intermediate values look like manual changes)
const CONNECT_MS = 1500, CALL_MS = 1500;

// ---------- solar math (NOAA) ----------
const RAD = Math.PI / 180;
const sinD = (d) => Math.sin(d * RAD), cosD = (d) => Math.cos(d * RAD), tanD = (d) => Math.tan(d * RAD);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, f) => a + (b - a) * clamp(f, 0, 1);

// Declination (deg) and equation of time (min) at an instant.
function sunParams(ms) {
  const jc = (ms / 86400000 + 2440587.5 - 2451545) / 36525;
  const L = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = sinD(M) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + sinD(2 * M) * (0.019993 - 0.000101 * jc) + sinD(3 * M) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = L + C - 0.00569 - 0.00478 * sinD(omega);
  const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * cosD(omega);
  const dec = Math.asin(sinD(obliq) * sinD(appLong)) / RAD;
  const v = tanD(obliq / 2) ** 2;
  const eqT = 4 / RAD * (v * sinD(2 * L) - 2 * ecc * sinD(M) + 4 * ecc * v * sinD(M) * cosD(2 * L)
    - 0.5 * v * v * sinD(4 * L) - 1.25 * ecc * ecc * sinD(2 * M));
  return { dec, eqT };
}

// Apparent sun elevation (deg, with atmospheric refraction) at an instant, at loc = { lat, lon }.
function elevationAt(ms, loc) {
  const { lat, lon } = needLoc(loc);
  const { dec, eqT } = sunParams(ms);
  const utcMin = ((ms / 60000) % 1440 + 1440) % 1440;
  const tst = ((utcMin + eqT + 4 * lon) % 1440 + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const cz = clamp(sinD(lat) * sinD(dec) + cosD(lat) * cosD(dec) * cosD(ha), -1, 1);
  const e = 90 - Math.acos(cz) / RAD;
  let r; // refraction, arcsec
  if (e > 85) r = 0;
  else if (e > 5) r = 58.1 / tanD(e) - 0.07 / tanD(e) ** 3 + 0.000086 / tanD(e) ** 5;
  else if (e > -0.575) r = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  else r = -20.772 / tanD(e);
  return e + r / 3600;
}

// Time (ms) the sun crosses altitude `alt` (deg) on the given calendar day; rising or setting.
// Uses true altitude; -0.833 for sunrise/sunset is the standard refraction + disc correction.
function crossing(dayUtcMs, alt, rising, { lat, lon }) {
  let t = dayUtcMs + (720 - 4 * lon) * 60000;
  for (let i = 0; i < 3; i++) {
    const { dec, eqT } = sunParams(t);
    const noon = 720 - 4 * lon - eqT;
    const cosH = (sinD(alt) - sinD(lat) * sinD(dec)) / (cosD(lat) * cosD(dec));
    const H = Math.acos(clamp(cosH, -1, 1)) / RAD;
    t = dayUtcMs + (noon + (rising ? -4 : 4) * H) * 60000;
  }
  return t;
}

const dayCache = new Map();
// Sun events at loc for the local calendar day (y, m0 = 0-based month, d), as ms timestamps.
// The events are computed around the location's solar noon on that date, so they land on the local day
// as long as the PC's time zone roughly matches the location.
function sunDay(yr, m0, d, loc = LOC) {
  const { lat, lon } = needLoc(loc);
  const key = `${yr}-${m0}-${d}@${lat},${lon}`;
  if (dayCache.has(key)) return dayCache.get(key);
  const day = Date.UTC(yr, m0, d);
  const { eqT } = sunParams(day + (720 - 4 * lon) * 60000);
  const ev = {
    noon: day + (720 - 4 * lon - eqT) * 60000,
    sunrise: crossing(day, -0.833, true, loc),
    sunset: crossing(day, -0.833, false, loc),
    dawn: crossing(day, -4, true, loc), // sun at -4 deg (true altitude ~ apparent at that depth)
    dusk: crossing(day, -4, false, loc),
    morningStart: new Date(yr, m0, d, MORNING_START_H, 0).getTime(),
  };
  if (dayCache.size > 64) dayCache.clear();
  dayCache.set(key, ev);
  return ev;
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const t = new Date(ms); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };

// ---------- target curve ----------
function targetAt(date = new Date(), loc = LOC) {
  const dt = date instanceof Date ? date : new Date(date);
  const t = dt.getTime();
  const ev = sunDay(dt.getFullYear(), dt.getMonth(), dt.getDate(), loc);
  const e = elevationAt(t, loc);
  const twilightCt = () => lerp(3000, 5600, (e + 4) / 24);
  let ct, bright, phase;
  if (t < ev.noon) {
    if (e < -4 && t < ev.morningStart) { ct = 2200; bright = 40; phase = 'night'; } // late night, continues the evening
    else if (e < -4) { ct = 2700; bright = 60; phase = 'predawn'; }
    else if (e < 20) { ct = twilightCt(); bright = 100; phase = 'sunrise'; }
    else { ct = 5600; bright = 100; phase = 'day'; }
  } else {
    if (e >= 20) { ct = 5600; phase = 'day'; }
    else if (e >= -4) { ct = twilightCt(); phase = 'sunset'; }
    else {
      const end = ev.sunset + 3 * 3600e3;
      ct = lerp(2700, 2200, (t - ev.dusk) / Math.max(1, end - ev.dusk));
      phase = t < end ? 'evening' : 'night';
    }
    bright = t < ev.sunset ? 100 : lerp(100, 40, (t - ev.sunset) / (2.5 * 3600e3));
  }
  return { ct: Math.round(ct / 10) * 10, bright: Math.round(bright), elevation: Math.round(e * 10) / 10, phase };
}

function parseDay(date) {
  if (date == null) date = new Date();
  if (typeof date === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!m) throw new Error(`bad date "${date}", expected YYYY-MM-DD`);
    return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  }
  const d = date instanceof Date ? date : new Date(date);
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}

// Targets every 30 min for one local day.
function plan(date, loc = LOC) {
  needLoc(loc);
  const [yr, m0, d] = parseDay(date);
  const out = [];
  for (let i = 0; i < 48; i++) {
    const at = new Date(yr, m0, d, 0, 30 * i);
    if (at.getDate() !== d) break;
    if (at.getHours() * 60 + at.getMinutes() !== 30 * i) continue; // skipped by the spring DST jump
    const tg = targetAt(at, loc);
    out.push({ time: hhmm(at.getTime()), ct: tg.ct, bright: tg.bright });
  }
  return out;
}

// ---------- state ----------
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

function writeState(s) {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

// ---------- decision (pure: no I/O) ----------
// True when reading v is more than tol away from `last` (the value we set or read) and from `from`.
// `from` is set only after a tick that sent both ct and bright: if the second smooth command cut the first
// one short, that value stays near its pre-command reading, which is not a manual change. Values in between
// still count as manual. Unknown/corrupt `last` -> no verdict (false).
function drifted(v, last, from, tol) {
  const n = (x) => (x == null || x === '' ? NaN : Number(x));
  const near = (x) => Number.isFinite(x) && Math.abs(v - x) <= tol;
  const a = n(last);
  if (!Number.isFinite(a)) return false;
  return !near(a) && !near(n(from));
}

// st: saved state, p: get_prop values (strings), now: ms, tg: targetAt(now).
// Returns { state, cmds: [{method, params, key, value}], summary }. state assumes no command is acknowledged;
// the caller sets state[key] = value for each acknowledged command.
function decide(st, p, now, tg) {
  const s = { ...st };
  if (p.power !== 'on') {
    Object.assign(s, { lastPower: 'off', override: false, resume: false, lastCt: null, lastBright: null, fromCt: null, fromBright: null, lastSeenAt: now });
    return { state: s, cmds: [], summary: 'bulb off: nothing to do' };
  }
  // An effect, mood or music session owns the bulb. Leave lastPower alone so a bulb that was just
  // switched on still gets its fresh session once the effect ends.
  if (p.flowing === '1' || p.music_on === '1') return { state: s, cmds: [], summary: 'skip: effect running' };

  // Our own 20s glide may still be running (e.g. an MCP tick right after a scheduled one).
  const sinceSet = now - Number(s.lastSetAt);
  if (sinceSet >= 0 && sinceSet < SETTLE_MS) return { state: s, cmds: [], summary: 'skip: previous glide still settling' };

  const ct = Number(p.ct), br = Number(p.bright), ctMode = p.color_mode === '2';
  // New session only when the bulb was last seen off or unreachable ('unknown'), never seen, or on resume().
  // A long gap without contact is not a new session: drift then still means a manual change.
  const fresh = s.lastPower !== 'on' || s.resume === true;
  s.lastPower = 'on';
  s.lastSeenAt = now;
  s.resume = false;

  if (fresh) {
    s.override = false;
  } else if (s.override) {
    return { state: s, cmds: [], summary: 'paused: manual override (until the bulb is next off)' };
  } else if (!ctMode) {
    s.override = true;
    return { state: s, cmds: [], summary: 'manual color detected: paused until the bulb is next off' };
  } else if (drifted(ct, s.lastCt, s.fromCt, 100) || drifted(br, s.lastBright, s.fromBright, 3)) {
    s.override = true;
    return { state: s, cmds: [], summary: `manual change detected (ct ${ct}, bright ${br}): paused until the bulb is next off` };
  }

  s.lastCt = s.fromCt = ct;
  s.lastBright = s.fromBright = br;
  const cmds = [];
  if (!ctMode || Math.abs(tg.ct - ct) >= 50) cmds.push({ method: 'set_ct_abx', params: [tg.ct, 'smooth', GLIDE_MS], key: 'lastCt', value: tg.ct });
  if (Math.abs(tg.bright - br) >= 2) cmds.push({ method: 'set_bright', params: [tg.bright, 'smooth', GLIDE_MS], key: 'lastBright', value: tg.bright });
  if (cmds.length < 2) s.fromCt = s.fromBright = null; // one command can't be cut short by the other
  const why = fresh ? 'fresh session' : 'follow';
  const summary = cmds.length
    ? `${why}: ${cmds.map((c) => (c.method === 'set_ct_abx' ? `ct ${ct}->${tg.ct}` : `bright ${br}->${tg.bright}`)).join(', ')} (${tg.phase})`
    : `${why}: already at target ct ${tg.ct} bright ${tg.bright} (${tg.phase})`;
  return { state: s, cmds, summary };
}

// ---------- one-socket connection ----------
let nextId = 1;
function connect(host, port = 55443) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.setEncoding('utf8');
    const pending = new Map();
    let buf = '', closed = false, ready = false;
    const failAll = (err) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); } pending.clear(); };
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`connect timeout ${host}`)); }, CONNECT_MS);
    // Any transport failure (reset, close) leaves a sent command's outcome unknown: only an {error} reply is a
    // definite rejection.
    sock.on('error', (err) => { clearTimeout(timer); closed = true; failAll(Object.assign(err, { noReply: true })); if (!ready) reject(err); });
    sock.on('close', () => { closed = true; failAll(Object.assign(new Error('connection closed'), { noReply: true })); });
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id);
        if (!p) continue; // notifications
        pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      }
    });
    sock.on('connect', () => {
      clearTimeout(timer); ready = true;
      resolve({
        call(method, params) {
          return new Promise((res, rej) => {
            if (closed) return rej(new Error('connection closed'));
            const id = nextId++;
            const t = setTimeout(() => { pending.delete(id); rej(Object.assign(new Error(`${method}: no reply`), { noReply: true })); }, CALL_MS);
            pending.set(id, { resolve: res, reject: rej, timer: t });
            sock.write(JSON.stringify({ id, method, params }) + '\r\n');
          });
        },
        close() { closed = true; failAll(Object.assign(new Error('closed'), { noReply: true })); sock.destroy(); },
      });
    });
  });
}

// Connect to the bulb; if the cached IP fails, rediscover once (DHCP may have moved it).
// With no known IP yet (no cache, no host in config.json), discover it first.
async function connectBulb() {
  const host = y.hostOf(LIGHT);
  let err = new Error('bulb not found on the LAN');
  if (host) {
    try { return await connect(host); } catch (e) { err = e; }
  }
  let cache = {};
  try { cache = await y.rediscover(); } catch {}
  if (!cache[LIGHT] || cache[LIGHT] === host) throw err;
  return connect(cache[LIGHT]);
}

const READ = ['power', 'bright', 'ct', 'color_mode', 'flowing', 'music_on'];
const propsOf = (vals) => Object.fromEntries(READ.map((k, i) => [k, Array.isArray(vals) ? vals[i] : undefined]));

// ---------- public API ----------
// One tick over one connection. io = { open() -> conn, load() -> state, save(state), now() -> ms, loc, online() }.
async function runTick(io) {
  let conn;
  try { conn = await io.open(); } catch (err) {
    // Treated like an unseen power cycle (wall switch, power cut): the next contact starts a fresh session.
    // Not when the PC itself is off the LAN (e.g. just woke from sleep, Wi-Fi not back yet): that says
    // nothing about the bulb, so the state is left as it is.
    if (io.online && !io.online()) return `PC not on the LAN, bulb not checked: ${err.message}`;
    const summary = `bulb unreachable: ${err.message}`;
    io.save({ ...io.load(), lastPower: 'unknown', lastSeenAt: io.now(), lastResult: summary, lastTickAt: io.now() });
    return summary;
  }
  let res, loaded;
  try {
    const p = propsOf(await conn.call('get_prop', READ));
    if (!p.power) throw new Error('empty get_prop reply');
    const now = io.now();
    loaded = io.load();
    res = decide(loaded, p, now, targetAt(new Date(now), io.loc));
    const failed = [];
    for (const c of res.cmds) {
      try {
        await conn.call(c.method, c.params);
        res.state[c.key] = c.value;
        res.state.lastSetAt = now;
      } catch (err) {
        // No reply: it may have been applied, so don't use that value for manual-change detection next time.
        if (err.noReply) res.state[c.key] = null;
        failed.push(`${c.method} ${err.message}`);
      }
    }
    if (failed.length) res.summary += `; failed: ${failed.join('; ')}`;
  } finally { conn.close(); }
  // resume() / markManual() may have run in another process (MCP server) since load(): keep their request
  // instead of overwriting it. When both ran, the later one wins.
  const ext = io.load();
  const changed = (k) => ext[k] != null && ext[k] !== loaded[k];
  const patches = [];
  if (changed('resumeAt')) patches.push([ext.resumeAt, { resume: true, override: false, resumeAt: ext.resumeAt }]);
  if (changed('manualAt')) patches.push([ext.manualAt, { lastPower: 'on', override: true, resume: false, manualAt: ext.manualAt }]);
  patches.sort((a, b) => a[0] - b[0]).forEach(([, patch]) => Object.assign(res.state, patch));
  res.state.lastResult = res.summary;
  res.state.lastTickAt = io.now();
  io.save(res.state);
  return res.summary;
}

// True when this PC has an IPv4 address in the bulb's /24 (it does not while Wi-Fi is down or reconnecting).
// True as well when the bulb's IP isn't known yet (nothing to compare against). Assumes a /24 home network:
// on a larger subnet where the PC and the bulb differ in the third octet, an unreachable bulb is taken for
// "PC not on the LAN", so a wall-switch off is not recorded.
function onBulbLan() {
  try {
    const host = y.hostOf(LIGHT);
    if (!host) return true;
    const net24 = String(host).split('.').slice(0, 3).join('.') + '.';
    return Object.values(os.networkInterfaces()).flat()
      .some((a) => a && !a.internal && (a.family === 'IPv4' || a.family === 4) && a.address.startsWith(net24));
  } catch { return true; }
}

async function tick() {
  try {
    if (!LOC) return `nothing done: ${NO_LOCATION}`;
    if (fs.existsSync(OFF_FILE)) return 'disabled (DAYLIGHT_OFF)';
    return await runTick({ open: connectBulb, load: readState, save: writeState, now: Date.now, loc: LOC, online: onBulbLan });
  } catch (err) {
    return `error: ${err && err.message}`;
  }
}

// Read-only: reads the state file and get_prop. Writes nothing, sends nothing else.
// Throws when no location is set.
async function status() {
  needLoc(LOC);
  const st = readState();
  const now = new Date();
  const ev = sunDay(now.getFullYear(), now.getMonth(), now.getDate());
  let bulb = null;
  try {
    const host = y.hostOf(LIGHT);
    if (!host) throw new Error('bulb not discovered yet (the next tick looks for it)');
    const conn = await connect(host);
    try { bulb = propsOf(await conn.call('get_prop', READ)); } finally { conn.close(); }
  } catch (err) { bulb = { error: err.message }; }
  return {
    enabled: !fs.existsSync(OFF_FILE),
    override: st.override === true,
    lastCt: st.lastCt ?? null,
    lastBright: st.lastBright ?? null,
    now: targetAt(now),
    sunrise: hhmm(ev.sunrise),
    sunset: hhmm(ev.sunset),
    lastPower: st.lastPower ?? null,
    lastSetAt: st.lastSetAt ? new Date(st.lastSetAt).toISOString() : null,
    lastResult: st.lastResult ?? null,
    bulb,
  };
}

// Synchronous. Clears the override and makes the next tick behave like a fresh session.
function resume() {
  const s = readState();
  Object.assign(s, { override: false, resume: true, resumeAt: Date.now() });
  writeState(s);
  return 'override cleared; the next tick re-applies the daylight curve';
}

// Synchronous. Call after another program set the bulb's color/ct/brightness or turned it on at the user's
// request: daylight then leaves the bulb alone until it is next off. Sends nothing to the bulb.
function markManual() {
  const now = Date.now();
  const s = readState();
  Object.assign(s, { lastPower: 'on', override: true, resume: false, lastSeenAt: now, manualAt: now });
  writeState(s);
  return 'daylight paused for the bulb until it is next turned off';
}

module.exports = { targetAt, tick, status, resume, markManual, plan };

// ---------- offline self-test (no network, no file writes) ----------
function selftest() {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const utcMin = (ms) => ((ms / 60000) % 1440 + 1440) % 1440;
  const nearUtc = (ms, h, m, tolMin) => Math.abs(utcMin(ms) - (h * 60 + m)) <= tolMin;
  const hhmmUtc = (ms) => new Date(ms).toISOString().slice(11, 16);

  // Astronomy at a fixed reference point, compared in UTC, so it doesn't depend on this PC's time zone or on
  // config.json. Greenwich (51.48N 0.0E): Jun 21 sunrise ~03:43 / sunset ~20:21 UTC, Dec 21 ~08:04 / ~15:53 UTC.
  const GREENWICH = { lat: 51.48, lon: 0 };
  const jun = sunDay(2026, 5, 21, GREENWICH), dec = sunDay(2026, 11, 21, GREENWICH);
  ok(nearUtc(jun.sunrise, 3, 43, 4) && nearUtc(jun.sunset, 20, 21, 4), `June sun ${hhmmUtc(jun.sunrise)}/${hhmmUtc(jun.sunset)} UTC`);
  ok(nearUtc(dec.sunrise, 8, 4, 4) && nearUtc(dec.sunset, 15, 53, 4), `December sun ${hhmmUtc(dec.sunrise)}/${hhmmUtc(dec.sunset)} UTC`);
  ok(nearUtc(jun.noon, 12, 2, 2) && nearUtc(dec.noon, 11, 58, 2), `solar noon ${hhmmUtc(jun.noon)}/${hhmmUtc(dec.noon)} UTC`);
  // Day length: ~16h38m in June, ~7h49m in December at 51.5N.
  ok(Math.abs((jun.sunset - jun.sunrise) / 60000 - 998) < 6, `June day length ${(jun.sunset - jun.sunrise) / 60000}`);
  ok(Math.abs((dec.sunset - dec.sunrise) / 60000 - 469) < 6, `December day length ${(dec.sunset - dec.sunrise) / 60000}`);
  // Noon elevation vs 90 - lat + declination (+/-23.44 at the solstices), plus a little refraction.
  const eJun = elevationAt(jun.noon, GREENWICH), eDec = elevationAt(dec.noon, GREENWICH);
  ok(Math.abs(eJun - 61.97) < 0.3, `June noon elevation ${eJun.toFixed(2)}`);
  ok(Math.abs(eDec - 15.14) < 0.3, `December noon elevation ${eDec.toFixed(2)}`);
  ok(Math.abs(elevationAt(jun.sunset, GREENWICH) - -0.833) < 0.6, `elevation at sunset ${elevationAt(jun.sunset, GREENWICH).toFixed(2)}`);
  // Equator at the March equinox: ~12h07m of daylight (refraction and the sun's disc add a few minutes).
  const eq = sunDay(2026, 2, 20, { lat: 0, lon: 0 });
  ok(Math.abs((eq.sunset - eq.sunrise) / 60000 - 727) < 5, `equinox day length at the equator ${(eq.sunset - eq.sunrise) / 60000}`);

  // The configured location (if any) should have its solar noon around midday on this PC's clock; if not, the
  // longitude sign (east positive) or the time zone is probably wrong.
  if (LOC) {
    const n = new Date(), noon = new Date(sunDay(n.getFullYear(), n.getMonth(), n.getDate()).noon);
    const m = noon.getHours() * 60 + noon.getMinutes();
    ok(m >= 9 * 60 && m <= 16 * 60, `config.json location: solar noon at ${hhmm(noon.getTime())} local; check location.lon (east positive) and the PC's time zone`);
  }

  // The curve checks need local midnight to be night, so they use a place whose longitude matches this PC's
  // UTC offset on that day (solar time ~ clock time), at a mid latitude in each hemisphere.
  const localRef = (yr, m0, d, lat) => ({ lat, lon: -new Date(yr, m0, d, 12).getTimezoneOffset() / 4 });

  // Curve: every 5 min, morning start -> noon non-decreasing, noon -> midnight non-increasing, values in range.
  const today = (() => { const n = new Date(); return [n.getFullYear(), n.getMonth(), n.getDate()]; })();
  for (const day of [[2026, 5, 21], [2026, 11, 21], [2026, 2, 20], [2026, 8, 23], today]) for (const lat of [35, -35]) {
    const loc = localRef(...day, lat);
    const ev = sunDay(...day, loc);
    let prev = null, maxStep = 0;
    for (let min = 0; min < 1440; min += 5) {
      const at = new Date(day[0], day[1], day[2], 0, min);
      if (at.getDate() !== day[2]) break;
      const tg = targetAt(at, loc);
      const tag = `${day.join('-')} lat ${lat} ${hhmm(at.getTime())}`;
      ok(tg.ct >= 2200 && tg.ct <= 5600 && tg.bright >= 40 && tg.bright <= 100, `range ${tag}`);
      if (prev && at.getTime() > ev.morningStart) {
        const morning = at.getTime() <= ev.noon;
        if (morning) ok(tg.ct >= prev.ct && tg.bright >= prev.bright, `morning not monotonic ${tag}`);
        else if (prev.t >= ev.noon) ok(tg.ct <= prev.ct && tg.bright <= prev.bright, `evening not monotonic ${tag}`);
        if (prev.t >= ev.noon) maxStep = Math.max(maxStep, Math.abs(tg.ct - prev.ct));
      }
      if (min === 0) ok(tg.ct === 2200 && tg.bright === 40, `midnight should be night ${tag}`);
      prev = { ...tg, t: at.getTime() };
    }
    ok(maxStep <= 450, `evening ct step ${maxStep} per 5 min on ${day.join('-')} lat ${lat}`);
  }

  // decide()
  const T = 1e12, tg = { ct: 3000, bright: 80, phase: 'sunset' };
  const P = (o) => ({ power: 'on', bright: '100', ct: '4000', color_mode: '2', flowing: '0', music_on: '0', ...o });
  const apply = (r) => { const s = { ...r.state }; for (const c of r.cmds) s[c.key] = c.value; return s; };
  const methods = (r) => r.cmds.map((c) => c.method).join(',');
  const banned = /set_power|set_scene|set_default|set_name|cron_/;
  const all = [];
  const D = (...a) => { const r = decide(...a); all.push(r); return r; };

  let r = D({}, P({ power: 'off' }), T, tg);
  ok(!r.cmds.length && r.state.lastPower === 'off' && r.state.override === false, 'off');
  r = D({ lastPower: 'on', override: true, lastSeenAt: T }, P({ power: 'off' }), T, tg);
  ok(r.state.override === false, 'off clears override');
  r = D({ lastPower: 'off' }, P({ flowing: '1' }), T, tg);
  ok(!r.cmds.length && r.state.lastPower === 'off', 'flowing skip keeps lastPower');
  r = D({ lastPower: 'on', lastSeenAt: T }, P({ music_on: '1' }), T, tg);
  ok(!r.cmds.length, 'music skip');
  r = D({}, P({ color_mode: '1' }), T, tg); // unknown state, color mode -> fresh session applies
  ok(methods(r) === 'set_ct_abx,set_bright' && apply(r).lastCt === 3000 && apply(r).lastBright === 80, 'fresh session applies');
  r = D({ lastPower: 'off', override: true }, P(), T, tg);
  ok(r.state.override === false && r.cmds.length === 2, 'fresh session clears override');
  const on = { lastPower: 'on', lastSeenAt: T - 600e3, lastCt: 4000, lastBright: 100, override: false };
  r = D(on, P({ color_mode: '1' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'color pick -> override');
  r = D(on, P({ ct: '4200' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'ct drift -> override');
  r = D(on, P({ bright: '90' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'bright drift -> override');
  r = D({ ...on, override: true }, P(), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'override persists');
  r = D(on, P({ ct: '4080', bright: '102' }), T, tg);
  ok(r.cmds.length === 2 && r.state.override === false, 'small drift follows');
  r = D({ ...on, lastCt: 3000, lastBright: 80 }, P({ ct: '3020', bright: '81' }), T, tg);
  ok(!r.cmds.length && r.state.lastCt === 3020 && r.state.lastBright === 81, 'sub-threshold: no send, records actual');
  r = D({ ...on, lastCt: 3000 }, P({ ct: '3040' }), T, tg);
  ok(!r.cmds.some((c) => c.method === 'set_ct_abx'), 'ct delta < 50 not sent');
  r = D({ ...on, override: true, resume: true }, P({ ct: '6000', color_mode: '1' }), T, tg);
  ok(r.cmds.length === 2 && r.state.override === false && r.state.resume === false, 'resume acts like fresh');
  // Long gaps (PC asleep, DAYLIGHT_OFF) never overwrite a manual choice.
  r = D({ ...on, lastCt: 2490, lastBright: 66, lastSeenAt: T - 40 * 60e3 }, P({ ct: '4000', bright: '66' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, '40 min gap + manual 4000K -> override, not resync');
  r = D({ ...on, lastSeenAt: T - 3 * 3600e3 }, P({ color_mode: '3' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'long gap + color mode -> override');
  r = D({ ...on, lastSeenAt: T - 3 * 3600e3, override: true }, P(), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'long gap keeps override');
  r = D({ ...on, lastSeenAt: T - 5 * 3600e3, override: true }, P({ color_mode: '1' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, '5 h gap keeps override and the user color');
  r = D({ ...on, lastSeenAt: T - 10 * 3600e3 }, P({ ct: '4000', bright: '100' }), T, tg);
  ok(r.cmds.length === 2 && r.state.override === false, 'long gap, no drift -> follows');
  // Unreachable (power cut / wall switch) -> next contact is a fresh session.
  r = D({ ...on, lastPower: 'unknown', override: true }, P({ ct: '6000', bright: '30' }), T, tg);
  ok(r.cmds.length === 2 && r.state.override === false && r.state.lastPower === 'on', 'unknown -> fresh session, override dropped');
  // markManual() state -> paused even though the bulb was just turned on.
  r = D({ lastPower: 'on', override: true, lastSeenAt: T - 60e3, manualAt: T - 60e3 }, P({ ct: '2700' }), T, tg);
  ok(!r.cmds.length && r.state.override === true, 'markManual pauses');
  // Previous tick sent ct 6500->3000 and bright 100->80; the glides cut each other short.
  const sent = apply(D({ lastPower: 'on', lastSeenAt: T - 600e3 }, P({ ct: '6500', bright: '100' }), T - 600e3, tg));
  ok(sent.lastCt === 3000 && sent.fromCt === 6500 && sent.lastBright === 80 && sent.fromBright === 100, `from recorded ${JSON.stringify(sent)}`);
  r = D(sent, P({ ct: '6440', bright: '80' }), T, tg);
  ok(!r.state.override && r.cmds.some((c) => c.method === 'set_ct_abx'), 'ct glide cut short (near from) -> no override, resent');
  r = D(sent, P({ ct: '3000', bright: '99' }), T, tg);
  ok(!r.state.override && r.cmds.some((c) => c.method === 'set_bright'), 'bright glide cut short -> no override, resent');
  r = D(sent, P({ ct: '4000', bright: '80' }), T, tg);
  ok(r.state.override === true && !r.cmds.length, 'manual 4000K after a fresh glide -> override');
  r = D(sent, P({ ct: '3000', bright: '90' }), T, tg);
  ok(r.state.override === true, 'manual bright between from and target -> override');
  r = D(sent, P({ ct: '2000' }), T, tg);
  ok(r.state.override === true, 'ct outside glide range -> override');
  r = D({ ...on, lastCt: 4000, lastBright: 80, fromCt: 6500, fromBright: 100 }, P({ ct: '4000', bright: '80' }), T, tg);
  ok(r.cmds.length === 1 && r.state.fromCt === null && r.state.fromBright === null, 'from cleared when only one command sent');
  r = D({ ...on, lastCt: 3000, lastBright: 80, fromCt: null }, P({ ct: '4000', bright: '80' }), T, tg);
  ok(r.state.override === true, 'single-command tick: drift detected as before');
  r = D({ ...sent }, P({ power: 'off' }), T, tg);
  ok(r.state.fromCt === null && r.state.fromBright === null, 'off clears from');
  r = D({ ...on, lastSetAt: T - 10e3 }, P({ ct: '3500', bright: '90' }), T, tg);
  ok(!r.cmds.length && !r.state.override, 'mid-glide tick skipped, no false override');
  r = D({ ...on, lastSetAt: T - 10e3 }, P({ power: 'off' }), T, tg);
  ok(r.state.lastPower === 'off', 'off still recorded mid-glide');
  r = D({ lastPower: 'on', lastSeenAt: 'garbage', lastCt: 'x' }, P(), T, tg); // corrupt-ish state
  ok(r.cmds.length === 2, 'corrupt state does not crash');
  ok(all.every((x) => x.cmds.every((c) => !banned.test(c.method) && c.params[1] === 'smooth' && c.params[2] === GLIDE_MS)), 'only smooth set_ct_abx/set_bright');

  // Contract shape.
  const pl = plan('2026-06-21', localRef(2026, 5, 21, 35));
  ok(pl.length === 48 && pl.every((x) => Object.keys(x).join() === 'time,ct,bright'), 'plan shape');
  // Every day of the year, so whatever DST change this PC's time zone has is covered: times strictly increase.
  for (let i = 0; i < 365; i++) {
    const dd = new Date(2026, 0, 1 + i);
    const times = plan(dd, localRef(dd.getFullYear(), dd.getMonth(), dd.getDate(), 35)).map((x) => x.time);
    if (!times.every((x, j) => !j || x > times[j - 1])) { ok(false, `DST plan ${dd.toDateString()} ${times.slice(3, 7)}`); break; }
  }
  const tn = targetAt(new Date(), localRef(...today, 35));
  ok(Object.keys(tn).join() === 'ct,bright,elevation,phase', 'targetAt shape');
  let threw = null;
  try { targetAt(new Date(), null); } catch (err) { threw = err.message; }
  ok(threw === NO_LOCATION, `no location -> ${threw}`);
  return fails;
}

// runTick() against a scripted fake bulb on 127.0.0.1 (never the real lights).
async function selftestNet() {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const T0 = new Date(2026, 0, 15, 18, 0).getTime();
  const loc = { lat: 35, lon: -new Date(T0).getTimezoneOffset() / 4 }; // reference place, not config.json
  const tg = targetAt(new Date(T0), loc);
  const ON = ['on', '100', '6500', '2', '0', '0']; // power, bright, ct, color_mode, flowing, music_on
  const run = async (props, reply, state = {}, load = () => ({ ...state })) => {
    const methods = []; let conns = 0, rest = '';
    const srv = net.createServer((sock) => {
      conns++; sock.setEncoding('utf8'); sock.on('error', () => {});
      sock.on('data', (d) => {
        rest += d;
        let nl;
        while ((nl = rest.indexOf('\r\n')) >= 0) {
          const m = JSON.parse(rest.slice(0, nl)); rest = rest.slice(nl + 2);
          methods.push(m.method);
          const r = m.method === 'get_prop' ? { id: m.id, result: props } : reply(m, sock);
          if (r) sock.write(JSON.stringify(r) + '\r\n');
        }
      });
    });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    let saved = null;
    const summary = await runTick({ open: () => connect('127.0.0.1', srv.address().port), load, save: (s) => { saved = s; }, now: () => T0, loc });
    await new Promise((res) => srv.close(res));
    ok(conns === 1 && rest === '' && methods[0] === 'get_prop' && methods.every((x) => /^(get_prop|set_ct_abx|set_bright)$/.test(x)), `wire: ${conns} conn, ${methods}, rest "${rest}"`);
    return { summary, saved, methods };
  };
  const ack = (m) => ({ id: m.id, result: ['ok'] });

  let r = await run(ON, ack);
  ok(r.methods.join() === 'get_prop,set_ct_abx,set_bright' && r.saved.lastCt === tg.ct && r.saved.lastBright === tg.bright && r.saved.lastSetAt === T0, `acked: ${r.summary}`);
  r = await run(ON, (m) => (m.method === 'set_ct_abx' ? { id: m.id, error: { code: -1, message: 'quota' } } : ack(m)));
  ok(r.saved.lastCt === 6500 && r.saved.lastBright === tg.bright && /failed/.test(r.summary), `error reply: ${JSON.stringify(r.saved)}`);
  r = await run(ON, () => null);
  ok(r.saved.lastCt === null && r.saved.lastBright === null && /no reply/.test(r.summary), `no reply: ${JSON.stringify(r.saved)}`);
  r = await run(ON, (m, sock) => { sock.destroy(); return null; });
  ok(r.saved.lastCt === null && r.saved.lastBright === 100, `closed after get_prop: ${JSON.stringify(r.saved)}`);
  r = await run(['off', '100', '6500', '2', '0', '0'], ack, { lastPower: 'on', override: true });
  ok(r.methods.join() === 'get_prop' && r.saved.lastPower === 'off' && r.saved.override === false, 'off: only get_prop');
  r = await run(['on', '100', '6500', '2', '1', '0'], ack, { lastPower: 'off' });
  ok(r.methods.join() === 'get_prop' && r.saved.lastPower === 'off', 'flowing: only get_prop');
  r = await run(['on', '100', '6500', '1', '0', '0'], ack, { lastPower: 'on', lastSeenAt: T0 - 600e3, lastCt: 3000, lastBright: 70 });
  ok(r.methods.join() === 'get_prop' && r.saved.override === true, 'color mode: override, nothing sent');
  // Bulb applies set_ct_abx, then resets the connection (RST): outcome unknown -> lastCt null, no false override.
  r = await run(ON, (m, sock) => { if (m.method === 'set_ct_abx') { sock.resetAndDestroy(); return null; } return ack(m); });
  ok(r.saved.lastCt === null && r.saved.lastBright === 100 && r.methods.join() === 'get_prop,set_ct_abx', `RST after set: ${JSON.stringify(r.saved)}`);
  // resume() / markManual() from another process during the tick survive the tick's save.
  let n = 0;
  const base = { lastPower: 'on', lastSeenAt: T0 - 600e3, lastCt: 3000, lastBright: 70, override: true };
  r = await run(ON, ack, base, () => (n++ ? { ...base, override: false, resume: true, resumeAt: T0 } : { ...base }));
  ok(r.methods.join() === 'get_prop' && r.saved.resume === true && r.saved.override === false, `resume race: ${JSON.stringify(r.saved)}`);
  n = 0;
  r = await run(['off', '100', '6500', '2', '0', '0'], ack, {}, () => (n++ ? { lastPower: 'on', override: true, manualAt: T0 } : {}));
  ok(r.saved.lastPower === 'on' && r.saved.override === true && r.saved.manualAt === T0, `markManual race: ${JSON.stringify(r.saved)}`);
  n = 0;
  r = await run(ON, ack, {}, () => (n++ ? { resume: true, resumeAt: T0 - 5, override: false, manualAt: T0 } : {}));
  ok(r.saved.override === true && r.saved.lastPower === 'on', `later markManual wins over resume: ${JSON.stringify(r.saved)}`);

  const closedPort = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  let saved = null;
  const io = (online) => ({ open: () => connect('127.0.0.1', closedPort), load: () => ({ lastPower: 'on', override: true, lastCt: 4000 }), save: (s) => { saved = s; }, now: () => T0, loc, online });
  let summary = await runTick(io(() => true));
  ok(/unreachable/.test(summary) && saved && saved.lastPower === 'unknown' && saved.lastSeenAt === T0 && saved.override === true, `unreachable: ${summary} ${JSON.stringify(saved)}`);
  saved = null;
  summary = await runTick(io(() => false));
  ok(/not on the LAN/.test(summary) && saved === null, `PC offline: ${summary} ${JSON.stringify(saved)}`);
  ok(typeof onBulbLan() === 'boolean', 'onBulbLan');
  return fails;
}

// ---------- CLI ----------
if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const done = (out) => { if (out !== undefined) process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out, null, 2)) + '\n'); process.exit(0); };
  const fail = (msg) => { process.stderr.write(`daylight: ${msg}\n`); process.exit(1); };
  (async () => {
    if (cmd === 'tick') return done(await tick());
    if ((cmd === 'status' || cmd === 'plan') && !LOC) return fail(NO_LOCATION);
    if (cmd === 'status') return done(await status());
    if (cmd === 'resume') return done(resume());
    if (cmd === 'manual') return done(markManual());
    if (cmd === 'plan') {
      const [yr, m0, d] = parseDay(arg);
      const ev = sunDay(yr, m0, d);
      const lines = [`${yr}-${pad(m0 + 1)}-${pad(d)}  sunrise ${hhmm(ev.sunrise)}  sunset ${hhmm(ev.sunset)}  (dawn/dusk at -4 deg: ${hhmm(ev.dawn)} / ${hhmm(ev.dusk)})`];
      for (const p of plan(arg)) {
        const [h, mi] = p.time.split(':').map(Number);
        const tg = targetAt(new Date(yr, m0, d, h, mi));
        lines.push(`${p.time}  ${String(p.ct).padStart(4)}K  ${String(p.bright).padStart(3)}%  elev ${String(tg.elevation).padStart(5)}  ${tg.phase}`);
      }
      return done(lines.join('\n'));
    }
    if (cmd === 'selftest') {
      const fails = [...selftest(), ...await selftestNet()];
      return done(fails.length ? `FAIL (${fails.length})\n${fails.join('\n')}` : 'selftest ok');
    }
    return done('usage: node daylight.js tick | status | plan [YYYY-MM-DD] | resume | manual | selftest');
  })().catch((err) => done(`error: ${err && err.message}`));
}
