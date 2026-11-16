// Builds a synthetic ten-block log and a monitor file from the clean template block, for end-to-end tests of the wrapper's
// Reserve mode. No secrets, no network.
// usage: node make_synth_log.js <artifact root> <template block log> <date YYYY-MM-DD> <failed blocks, comma separated> <out log> <out monitor>
'use strict';
const fs = require('fs');
const path = require('path');
const [root, templateFile, date, failedCsv, outLog, outMonitor] = process.argv.slice(2);
const M = require(path.join(root, 'scripts', 'lib', 'sepolia-modes.js'));
const SLOTS = ['08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'];
const [y, mo, d] = date.split('-').map(Number);
const slotMs = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(y, mo - 1, d, h, m) - 330 * 60000; };
const tpl = fs.readFileSync(templateFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const T = { header: tpl.find((r) => r.kind === 'header'), cold: tpl.find((r) => r.mode === 'cold'), data: tpl.filter((r) => r.kind === 'sepolia' && r.mode !== 'cold'), cache: tpl.find((r) => r.kind === 'cache_check'), footer: tpl.find((r) => r.kind === 'footer') };
const clone = (x) => JSON.parse(JSON.stringify(x));
const failed = failedCsv ? failedCsv.split(',').map(Number) : [];
const run = new Date(slotMs('07:45')).toISOString();
const rows = [{ ...clone(T.header), startedAt: run, slots: SLOTS }];
delete rows[0].onlyBlock; delete rows[0].at;
for (let b = 1; b <= 10; b++) {
  const base = { block: b, slot: SLOTS[b - 1], run };
  rows.push({ ...clone(T.cold), ...base, at: new Date(slotMs(SLOTS[b - 1]) + 1000).toISOString() });
  for (let it = 1; it <= 12; it++) {
    const order = it <= 2 ? M.orderFor({ block: b, index: it - 1, perBlock: 2 }) : M.orderFor({ block: b, index: it - 3, perBlock: 10 });
    for (const mode of order) {
      const r = { ...clone(T.data.find((x) => x.iteration === it && x.mode === mode)), ...base, iteration: it, warmup: it <= 2, pilot: false, order: order.join(',') };
      if (failed.includes(b) && it === 5 && mode === 'S') { r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; }
      rows.push(r);
    }
  }
  rows.push({ ...clone(T.cache), ...base });
}
rows.push({ ...clone(T.footer), run, finishedAt: new Date(slotMs('20:01')).toISOString() });
fs.writeFileSync(outLog, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
const ticks = [];
let rx = 5000000;
for (let ms = slotMs('07:45'); ms <= slotMs('20:05'); ms += 60000) {
  rx += 20000;
  // the fields of a real tick, including the wrapper id (wid), which the checker prefers to the pid
  ticks.push({ t: new Date(ms).toISOString(), w: 4242, wid: 'synthwid', gapSeconds: 60, power: 'Online', batteryPct: 100, wifiUp: true, ifaces: ['Wireless80211:Wi-Fi'], vpn: 0, gw: 'synthgw1', net: 'netA', saltId: 'salt0001', cpuPct: 3, node: { alive: true }, rxBytes: rx, txBytes: Math.round(rx / 4), restartPending: false });
}
fs.writeFileSync(outMonitor, `${ticks.map((t) => JSON.stringify(t)).join('\n')}\n`);
console.log(`wrote ${rows.length} log rows (failed blocks: ${failed.join(',') || 'none'}) and ${ticks.length} monitor ticks`);
