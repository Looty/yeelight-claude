// Records every light's current state + sleep timer to snapshot-<timestamp>.json (only reads the lights).
// Usage: node snapshot.js                   -> writes a new snapshot
//        node snapshot.js --restore [file]  -> puts the lights back from [file], default snapshot-original.json
//                                              (the first snapshot ever taken)
const fs = require('fs');
const path = require('path');
const y = require('./yeelight');

async function take() {
  const out = { takenAt: new Date().toISOString(), lights: {} };
  for (const name of Object.keys(y.LIGHTS)) {
    const props = await y.getProps(name);
    const [cron] = await y.send(name, [['cron_get', [0]]]);
    out.lights[name] = { id: y.LIGHTS[name].id, host: y.hostOf(name), props, cron_get_0: cron };
  }
  const file = path.join(__dirname, `snapshot-${out.takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  // The very first snapshot is kept forever as snapshot-original.json (never overwritten).
  try { fs.writeFileSync(path.join(__dirname, 'snapshot-original.json'), JSON.stringify(out, null, 2), { flag: 'wx' }); } catch {}
  console.log(file);
  console.log(JSON.stringify(out, null, 2));
}

async function restore() {
  const file = process.argv[3] || path.join(__dirname, 'snapshot-original.json');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, l] of Object.entries(snap.lights)) {
    const cmds = [];
    if (l.props.flowing === '1') cmds.push(['stop_cf', []]);
    cmds.push(...y.restoreCmds(l.props));
    // A running sleep timer can't be restored to the exact second; re-arm it with the minutes left at snapshot time.
    if (l.props.power === 'on' && Number(l.props.delayoff) > 0) cmds.push(['cron_add', [0, Number(l.props.delayoff)]]);
    console.log(name, await y.send(name, cmds, 4000));
  }
}

(process.argv[2] === '--restore' ? restore() : take()).catch((e) => { console.error(e.message); process.exit(1); });
