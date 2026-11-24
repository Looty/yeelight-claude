// Previews candidate "Claude is working" effects on the strip, ~7s each, then restores.
// Usage: node preview-working.js [comet|scanner|embers ...]
//        --loop <name> | --stop | --drift <ms> | --demo-done fade|stay|slow | --demo-wait violet|cooldrift|cyan
const y = require('./yeelight');
const { rgb, tuple: t } = y;
const SLEEP = (ms) => `${ms},7,0,0`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AMBER = rgb(255, 122, 0), EMBER = rgb(255, 48, 0), DEEP = rgb(200, 20, 0);

const CANDIDATES = {
  // A light "passing by": sharp bright amber head, long red-orange tail fading out.
  comet: [t(80, 1, AMBER, 100), t(550, 1, EMBER, 30), t(450, 1, DEEP, 3), SLEEP(200)],
  // Scanner sweep rhythm: two quick passes (there and back), then a short rest.
  scanner: [t(200, 1, AMBER, 100), t(200, 1, EMBER, 8), t(200, 1, AMBER, 100), t(250, 1, EMBER, 8), t(500, 1, DEEP, 2)],
  // --- No-pulse options: brightness stays constant, only (slow) color changes. ---
  // Solid: steady orange, 1s fade in.
  solid: [t(1000, 1, rgb(255, 100, 0), 70), t(5000, 1, rgb(255, 100, 0), 70)],
  // Drift: glides between amber and deep orange, 4s each way, same brightness.
  drift: [t(4000, 1, rgb(255, 140, 0), 70), t(4000, 1, rgb(255, 60, 0), 70)],
  // Drift v2: golden yellow <-> red-orange, 2.5s each way, 70%.
  drift2: [t(2500, 1, rgb(255, 185, 0), 70), t(2500, 1, rgb(255, 40, 0), 70)],
  // Drift v3: golden yellow <-> orange (less red), 2.5s each way, 70%.
  drift3: [t(2500, 1, rgb(255, 185, 0), 70), t(2500, 1, rgb(255, 85, 0), 70)],
  // Drift v4: golden yellow <-> orange, 1.5s each way, 70%.
  drift4: [t(1500, 1, rgb(255, 185, 0), 70), t(1500, 1, rgb(255, 85, 0), 70)],
  // Orange-only working variants (no red end), 1.8s each way.
  // A: light orange <-> darker orange by color only, same brightness.
  oranges: [t(1800, 1, rgb(255, 165, 40), 70), t(1800, 1, rgb(255, 120, 0), 70)],
  // B: one orange, brightness glides 75% <-> 35% (light <-> dark).
  orangedim: [t(1800, 1, rgb(255, 130, 0), 75), t(1800, 1, rgb(255, 130, 0), 35)],
  // C (used by status-hook.js): light orange at 75% <-> deeper orange at 45%.
  orangemix: [t(1800, 1, rgb(255, 165, 40), 75), t(1800, 1, rgb(255, 120, 0), 45)],
  // Sunset drift: orange -> coral -> rose -> back, 6s per step, same brightness.
  sunset: [t(6000, 1, rgb(255, 100, 0), 70), t(6000, 1, rgb(255, 60, 60), 70), t(6000, 1, rgb(255, 40, 110), 70)],
  // Embers: irregular flickering through orange shades, never quite repeating within a cycle.
  embers: Array.from({ length: 10 }, (_, i) => t(90 + ((i * 53) % 170), 1, [AMBER, EMBER, rgb(255, 85, 0), DEEP][(i * 7) % 4], 20 + ((i * 37) % 81))),
};

if (require.main === module) (async () => {
  // --loop <name>: start it looping forever and exit; --stop: end it (strip restores itself).
  if (process.argv[2] === '--loop') {
    if (!CANDIDATES[process.argv[3]]) { console.log('unknown effect:', process.argv[3], '- one of', Object.keys(CANDIDATES).join(' ')); return; }
    const [r] = await y.send('strip', [['start_cf', [0, 0, y.flow(CANDIDATES[process.argv[3]])]]]);
    console.log(process.argv[3], 'looping', JSON.stringify(r));
    return;
  }
  // --drift <ms>: loop golden yellow <-> orange at 70% with the given glide time each way.
  if (process.argv[2] === '--drift') {
    const ms = Number(process.argv[3]);
    const [r] = await y.send('strip', [['start_cf', [0, 0, y.flow([t(ms, 1, rgb(255, 185, 0), 70), t(ms, 1, rgb(255, 85, 0), 70)])]]]);
    console.log(`drift ${ms}ms looping`, JSON.stringify(r));
    return;
  }
  // --demo-done <fade|stay|slow>: 4s of the working drift, then a "finished" variant.
  if (process.argv[2] === '--demo-done') {
    if (!['fade', 'stay', 'slow'].includes(process.argv[3])) { console.log('usage: --demo-done fade|stay|slow'); return; }
    const p = await y.getProps('strip'); // during a flow this reports the strip's own pre-flow state
    const back = p.color_mode === '2' ? t(1000, 2, Number(p.ct), Number(p.bright)) : t(1000, 1, Number(p.rgb), Number(p.bright));
    const backSlow = back.replace(/^1000,/, '2500,');
    const GREEN = rgb(0, 230, 90);
    await y.send('strip', [['start_cf', [0, 0, y.flow([t(1800, 1, rgb(255, 185, 0), 70), t(1800, 1, rgb(255, 85, 0), 70)])]]]);
    await sleep(4000);
    const v = {
      fade: [2, 0, y.flow([t(1000, 1, GREEN, 70), SLEEP(3000), back])],
      slow: [2, 0, y.flow([t(2500, 1, GREEN, 70), SLEEP(4000), backSlow])],
      stay: [0, 0, y.flow([t(1000, 1, GREEN, 70), SLEEP(60000)])],
    }[process.argv[3]];
    // count must cover every tuple: fade/slow have 3 tuples
    if (process.argv[3] !== 'stay') v[0] = 3;
    console.log(process.argv[3], JSON.stringify(await y.send('strip', [['start_cf', v]])));
    return;
  }
  // --demo-wait <violet|cooldrift|cyan>: 4s of the working drift, then a "needs approval" variant (loops).
  if (process.argv[2] === '--demo-wait') {
    if (!['violet', 'cooldrift', 'cyan'].includes(process.argv[3])) { console.log('usage: --demo-wait violet|cooldrift|cyan'); return; }
    await y.send('strip', [['start_cf', [0, 0, y.flow([t(1800, 1, rgb(255, 185, 0), 70), t(1800, 1, rgb(255, 85, 0), 70)])]]]);
    await sleep(4000);
    const VIOLET = rgb(140, 0, 255);
    const tuples = {
      violet: [t(1000, 1, VIOLET, 70), SLEEP(60000)],
      cooldrift: [t(1800, 1, rgb(0, 90, 255), 70), t(1800, 1, rgb(170, 0, 255), 70)],
      cyan: [t(1000, 1, rgb(0, 200, 255), 70), SLEEP(60000)],
    }[process.argv[3]];
    console.log(process.argv[3], JSON.stringify(await y.send('strip', [['start_cf', [0, 0, y.flow(tuples)]]])));
    return;
  }
  if (process.argv[2] === '--stop') { console.log(JSON.stringify(await y.send('strip', [['stop_cf', []]]))); return; }
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CANDIDATES);
  for (const n of names) {
    const tuples = CANDIDATES[n];
    if (!tuples) { console.log('unknown effect:', n); continue; }
    console.log(`▶ ${n}`);
    const [r] = await y.send('strip', [['start_cf', [0, 0, y.flow(tuples)]]]);
    if (r && r.error) { console.log('  error', JSON.stringify(r.error)); continue; }
    await sleep(7000);
    await y.send('strip', [['stop_cf', []]]);
    await sleep(1500);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = CANDIDATES;
