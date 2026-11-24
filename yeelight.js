// Minimal Yeelight LAN client (spec: Yeelight WiFi Light Inter-Operation Specification).
// No persistent-settings commands (set_default / set_name) are used anywhere.
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CACHE = path.join(DIR, 'ip-cache.json');
const CONFIG = path.join(DIR, 'config.json');

// Local settings (see config.example.json). Every part is optional; a missing or broken file means {}.
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}
const config = loadConfig();

// Devices are identified by their Yeelight id when config.json gives one, otherwise by model during
// discovery. IPs are cached in ip-cache.json and re-discovered if DHCP moves them.
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const LIGHTS = {};
for (const name of ['strip', 'bulb']) {
  const c = (config.lights && typeof config.lights === 'object' && config.lights[name]) || {};
  LIGHTS[name] = { id: str(c.id), host: str(c.host) };
}

const PROPS = ['power', 'bright', 'ct', 'rgb', 'hue', 'sat', 'color_mode', 'flowing',
  'delayoff', 'flow_params', 'music_on', 'name'];

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; }
}

// Cached IP, else the host from config.json, else undefined (not discovered yet).
function hostOf(name) {
  return str(loadCache()[name]) || (LIGHTS[name] && LIGHTS[name].host) || undefined;
}

// SSDP search on port 1982; resolves { id -> {host, headers} }.
function discover(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = {};
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n\r\n');
    sock.on('message', (buf) => {
      const h = {};
      for (const line of buf.toString().split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const m = /yeelight:\/\/([\d.]+):(\d+)/.exec(h.location || '');
      if (h.id && m) found[h.id] = { host: m[1], headers: h };
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      sock.send(msg, 1982, '239.255.255.250');
      setTimeout(() => sock.send(msg, 1982, '239.255.255.250'), 300);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, timeoutMs);
  });
}

// Names discovered devices ({ id -> {host, headers} } from discover()); resolves { name -> host }.
// Configured ids win. A name with a configured id that wasn't found stays unmatched. A name without an id
// takes the first unclaimed device by model: a model containing "strip" -> strip; a color bulb model
// (color, color1, colorc, bslamp, ...), else the first remaining non-strip device -> bulb.
function matchLights(found) {
  const devs = Object.entries(found).map(([id, d]) => ({ id: id.toLowerCase(), host: d.host, model: String((d.headers && d.headers.model) || '') }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const configured = new Set(Object.values(LIGHTS).map((l) => l.id && l.id.toLowerCase()).filter(Boolean));
  const out = {};
  const taken = new Set();
  for (const [name, l] of Object.entries(LIGHTS)) {
    const d = l.id && devs.find((x) => x.id === l.id.toLowerCase());
    if (d) { out[name] = d.host; taken.add(d.id); }
  }
  const free = (test) => devs.find((x) => !taken.has(x.id) && !configured.has(x.id) && test(x.model));
  const isStrip = (m) => /strip/i.test(m);
  const pick = {
    strip: () => free(isStrip),
    bulb: () => free((m) => /^(color|bslamp)/i.test(m)) || free((m) => !isStrip(m)),
  };
  for (const [name, l] of Object.entries(LIGHTS)) {
    if (l.id || !pick[name]) continue;
    const d = pick[name]();
    if (d) { out[name] = d.host; taken.add(d.id); }
  }
  return out;
}

async function rediscover() {
  const found = await discover();
  const cache = loadCache();
  const got = matchLights(found);
  Object.assign(cache, got);
  if (Object.keys(got).length) { try { fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2)); } catch {} }
  return cache;
}

let nextId = 1;

// Open one connection, run commands in order (each awaits its RESULT), close.
// cmds: [[method, params], ...]. Resolves array of results (or {error}).
function sendTo(host, cmds, timeoutMs = 2000) {
  // An undefined host would make net connect to localhost instead of failing.
  if (!host) return Promise.reject(new Error('light address unknown (not discovered yet)'));
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: 55443 });
    const results = [];
    let buf = '';
    let i = 0;
    let pendingId = null;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timeout talking to ${host}`)); }, timeoutMs);
    const next = () => {
      if (i >= cmds.length) { clearTimeout(timer); sock.end(); resolve(results); return; }
      const [method, params = []] = cmds[i++];
      pendingId = nextId++;
      sock.write(JSON.stringify({ id: pendingId, method, params }) + '\r\n');
    };
    sock.on('connect', next);
    sock.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === pendingId) { results.push(msg.result ?? { error: msg.error }); next(); }
        // 'props' notifications are ignored here.
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Send to a named light; on connection failure, rediscover its IP once and retry.
// With no known IP yet (no cache, no host in config.json), discover it first.
async function send(name, cmds, timeoutMs) {
  const host = hostOf(name);
  if (!host) {
    const cache = await rediscover();
    if (!cache[name]) throw new Error(`${name} not found on the LAN (set lights.${name}.host in config.json)`);
    return sendTo(cache[name], cmds, timeoutMs);
  }
  try {
    return await sendTo(host, cmds, timeoutMs);
  } catch (e) {
    const cache = await rediscover();
    if (!cache[name] || cache[name] === host) throw e;
    return sendTo(cache[name], cmds, timeoutMs);
  }
}

async function getProps(name) {
  const [vals] = await send(name, [['get_prop', PROPS]]);
  return Object.fromEntries(PROPS.map((p, i) => [p, vals[i]]));
}

const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
// One flow tuple: duration ms (>=50), mode 1=rgb 2=ct 7=sleep, value, brightness (-1 or 1..100)
const tuple = (ms, mode, value, bright) => `${Math.max(50, Math.round(ms))},${mode},${value},${bright}`;
const flow = (tuples) => tuples.join(',');

// Command that returns a light to a saved state (from getProps()).
function restoreCmds(s) {
  if (s.power === 'off') return [['set_power', ['off', 'smooth', 500]]];
  const b = Number(s.bright);
  const cmds = [['set_power', ['on', 'smooth', 300]]];
  if (s.color_mode === '2') cmds.push(['set_ct_abx', [Number(s.ct), 'smooth', 500]]);
  else if (s.color_mode === '3') cmds.push(['set_hsv', [Number(s.hue), Number(s.sat), 'smooth', 500]]);
  else cmds.push(['set_rgb', [Number(s.rgb), 'smooth', 500]]);
  cmds.push(['set_bright', [b, 'smooth', 500]]);
  return cmds;
}

// Measured on real devices (not in the spec): a command message over ~250 bytes is silently dropped
// (no reply), which caps one start_cf at ~15 tuples. Longer flows are split into chunks.
const MAX_MSG = 235;
const PAD_MS = 400;
const sleepTuple = (ms) => `${Math.max(50, Math.round(ms))},7,0,0`;
const tupleMs = (tp) => Number(tp.split(',')[0]);

function chunkFlow(tuples) {
  const fits = (arr) => JSON.stringify({ id: 99999, method: 'start_cf', params: [99, 0, flow([...arr, sleepTuple(PAD_MS)])] }).length <= MAX_MSG;
  const chunks = [];
  let cur = [];
  for (const tp of tuples) {
    if (cur.length && !fits([...cur, tp])) { chunks.push(cur); cur = []; }
    cur.push(tp);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Play an arbitrarily long flow. Every chunk uses action 0, and each next chunk starts while the
// previous one is still holding a padding sleep, so the light never sees a gap and the final
// recovery returns it to the state from before the whole effect.
async function playFlow(name, tuples) {
  const chunks = chunkFlow(tuples);
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const body = last ? chunks[i] : [...chunks[i], sleepTuple(PAD_MS)];
    const t0 = Date.now();
    const [res] = await send(name, [['start_cf', [body.length, 0, flow(body)]]], 2500);
    if (res && res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
    const ms = chunks[i].reduce((s, tp) => s + tupleMs(tp), 0);
    await new Promise((r) => setTimeout(r, Math.max(0, ms + (last ? 0 : 120) - (Date.now() - t0))));
  }
}

module.exports = { LIGHTS, PROPS, config, CONFIG, discover, rediscover, matchLights, send, sendTo, getProps, rgb, tuple, flow, restoreCmds, hostOf, playFlow, chunkFlow };
