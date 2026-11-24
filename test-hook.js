// Pipes sample Claude Code hook payloads into status-hook.js and prints what the strip reports.
// Usage: node test-hook.js   (takes ~16s: working glide, then the slow green finish)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const y = require('./yeelight');

const HOOK = path.join(__dirname, 'status-hook.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fire = (ev, extra = {}) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'pipe-test', hook_event_name: ev, ...extra }) });
  return `${ev}: exit=${r.status} out=${JSON.stringify(r.stdout.toString() + r.stderr.toString())} ${Date.now() - t}ms`;
};
const show = async (l) => { const p = await y.getProps('strip'); console.log('   ', l, 'rgb=' + p.rgb, 'bright=' + p.bright, 'flowing=' + p.flowing, 'flow=' + p.flow_params); };

(async () => {
  await show('before');
  console.log(fire('UserPromptSubmit')); await sleep(4000); await show('working');
  console.log(fire('PostToolUse', { tool_name: 'Bash' }) + ' (dedup, expect no send)');
  console.log(fire('Stop')); await sleep(3000); await show('finishing (green)');
  await sleep(7000); await show('after finish');
  console.log(fire('SessionEnd'));
  console.log(fs.readFileSync(path.join(__dirname, 'status-state.json'), 'utf8'));
})().catch((e) => console.error('ERR', e.message));
