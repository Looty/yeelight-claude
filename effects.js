// Show-off effects for the light strip + color bulb.
// Every effect is an on-device color flow (start_cf) with a finite count and action 0,
// so each light restores its own previous state when the effect ends. 1 command per light.
// Usage: node effects.js [name ...]   (no args = list, "all" = play everything)
const y = require('./yeelight');

const { rgb, tuple: t, flow } = y;
const SLEEP = (ms) => `${Math.max(50, Math.round(ms))},7,0,0`;
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hsv2rgb = (h, s = 1, v = 1) => {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgb(Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255));
};
const dur = (tuples) => tuples.reduce((s, x) => s + Number(x.split(',')[0]), 0);

// Each effect returns { strip?: tuples[], bulb?: tuples[] }
const EFFECTS = {
  // A ball of light bouncing between the bulb and the strip, speeding up, then a white "goal" flash.
  pingpong() {
    const C = rgb(0, 220, 255), strip = [], bulb = [];
    for (let p = 650; p >= 110; p *= 0.86) {
      bulb.push(t(60, 1, C, 100), SLEEP(p - 60), t(60, 1, C, 1), SLEEP(p - 60));
      strip.push(t(60, 1, C, 1), SLEEP(p - 60), t(60, 1, C, 100), SLEEP(p - 60));
    }
    const goal = [t(60, 2, 6500, 100), SLEEP(250), t(400, 2, 6500, 1), SLEEP(300)];
    return { strip: [...strip, ...goal], bulb: [...bulb, ...goal] };
  },

  // Slow northern lights: teal/green/violet drifting, bulb and strip out of phase.
  aurora() {
    const pal = [rgb(0, 255, 160), rgb(30, 255, 60), rgb(120, 0, 255), rgb(0, 70, 255), rgb(0, 255, 200)];
    const mk = (off) => Array.from({ length: 8 }, (_, i) => t(rand(1800, 2600), 1, pal[(i + off) % pal.length], Math.round(rand(25, 85))));
    return { strip: mk(0), bulb: mk(2) };
  },

  // Thunderstorm on the bulb: dark blue night with random lightning; strip glows faintly after each strike.
  storm() {
    const bulb = [], strip = [];
    const NIGHT = rgb(10, 20, 90);
    for (let i = 0; i < 7; i++) {
      const wait = rand(500, 2200);
      bulb.push(t(300, 1, NIGHT, 4), SLEEP(wait));
      strip.push(t(300, 1, NIGHT, 2), SLEEP(wait));
      const flashes = Math.random() < 0.5 ? 2 : 1;
      for (let f = 0; f < flashes; f++) {
        bulb.push(t(50, 2, 6500, 100), t(90, 1, NIGHT, 3));
        strip.push(SLEEP(140));
      }
      bulb.push(SLEEP(250));
      strip.push(t(120, 2, 6000, 35), t(130, 1, NIGHT, 2));
    }
    return { bulb, strip };
  },

  // Candle: warm, irregular flicker on both lights.
  candle() {
    const mk = () => Array.from({ length: 70 }, () => t(rand(70, 220), 2, Math.round(rand(1700, 2000)), Math.round(rand(18, 55))));
    return { bulb: mk(), strip: mk() };
  },

  // Heartbeat: red lub-dub that slows down, like calming down.
  heartbeat() {
    const RED = rgb(255, 0, 20), out = [];
    for (let gap = 350; gap <= 1100; gap += 110) {
      out.push(t(70, 1, RED, 100), t(140, 1, RED, 8), t(70, 1, RED, 70), t(200, 1, RED, 3), SLEEP(gap));
    }
    return { strip: out, bulb: out };
  },

  // Rainbow wheel, strip chasing the bulb by a third of the wheel.
  rainbow() {
    const mk = (off) => Array.from({ length: 24 }, (_, i) => t(420, 1, hsv2rgb((i * 30 + off) % 360), 90));
    return { bulb: mk(0), strip: mk(120) };
  },

  // Fast sunrise on the bulb (the real one takes ~20 min; this is 16s), strip as the horizon glow.
  sunrise() {
    const bulb = [t(50, 1, rgb(60, 0, 0), 1), t(2500, 1, rgb(255, 30, 0), 8), t(3000, 1, rgb(255, 90, 0), 25),
      t(3500, 2, 2200, 50), t(3500, 2, 3500, 80), t(3000, 2, 5000, 100), SLEEP(1500)];
    const strip = [t(50, 1, rgb(40, 0, 60), 1), t(3000, 1, rgb(255, 0, 60), 20), t(3500, 1, rgb(255, 70, 0), 60),
      t(4000, 1, rgb(255, 160, 40), 90), t(3000, 2, 4000, 70), SLEEP(2000)];
    return { bulb, strip };
  },
};

async function play(name) {
  const fx = EFFECTS[name]();
  const ms = Math.max(...Object.values(fx).map(dur));
  const parts = Object.entries(fx).map(([l, tp]) => `${l} ${y.chunkFlow(tp).length} chunk(s)`).join(', ');
  console.log(`▶ ${name} (${(ms / 1000).toFixed(1)}s; ${parts})`);
  await Promise.all(Object.entries(fx).map(([light, tuples]) => y.playFlow(light, tuples)));
  await sleep(1200);
}

module.exports = { EFFECTS, play };

if (require.main === module) (async () => {
  let names = process.argv.slice(2);
  if (!names.length) { console.log('effects:', Object.keys(EFFECTS).join(', '), '| all'); return; }
  if (names[0] === 'all') names = ['pingpong', 'aurora', 'storm', 'candle', 'heartbeat', 'rainbow', 'sunrise'];
  for (const n of names) {
    if (!EFFECTS[n]) { console.log('unknown effect', n); continue; }
    await play(n);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
