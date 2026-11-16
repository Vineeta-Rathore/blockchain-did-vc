// Tests of check_sepolia_run.js on synthetic logs built from one real clean block (template_clean_block.jsonl). Each scenario
// damages the log in one specific way and states what the checker must do. Nothing here contacts a network.
//
// SECRETS: the test never reads a real env file. It writes its own fake env file (a made-up key on the Sepolia provider's host,
// so that the provider-label gate behaves as on the day) into a fresh temporary folder, works only there, and deletes the
// folder when it ends. The scenario "a URL part in a row" injects a part of the FAKE url. A real env file must not be passed in.
//
//   node test_check_sepolia_run.js <artifact root> <deployment record>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const [root, recordFile] = process.argv.slice(2);
if (!root || !recordFile || process.argv.length !== 4) {
  console.error('usage: node test_check_sepolia_run.js <artifact root> <deployment record>   (no env file: the test makes its own fake one)');
  process.exit(2);
}
const R = require(path.join(root, 'scripts', 'lib', 'rpc.js'));
const M = require(path.join(root, 'scripts', 'lib', 'sepolia-modes.js'));
const A = require(path.join(root, 'scripts', 'analyze-latency.js')); // exports analyzeSepolia; requiring it runs nothing
const checker = path.join(__dirname, '..', 'check_sepolia_run.js');
const SELF_SHA = require('crypto').createHash('sha256').update(fs.readFileSync(checker)).digest('hex');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r2_checker_test_'));
const envFile = path.join(scratch, 'fake.env');
fs.writeFileSync(envFile, 'SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/TESTONLYabcd1234TESTONLYabcd1234\n');
fs.writeFileSync(path.join(scratch, 'empty.env'), '# no URL here\n');
fs.writeFileSync(path.join(scratch, 'bad_record.json'), '{ this is not json');
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* nothing to clean */ } });

const SLOTS = ['08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'];
const slotMs = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 10, 11, h, m) - 330 * 60000; };
const template = fs.readFileSync(path.join(__dirname, 'template_clean_block.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const T = {
  header: template.find((r) => r.kind === 'header'),
  cold: template.find((r) => r.kind === 'sepolia' && r.mode === 'cold'),
  data: template.filter((r) => r.kind === 'sepolia' && r.mode !== 'cold'),
  cache: template.find((r) => r.kind === 'cache_check'),
  footer: template.find((r) => r.kind === 'footer'),
};
const clone = (x) => JSON.parse(JSON.stringify(x));

// One invocation: main (all ten blocks, unless `blocks` is given) or reserve (one block, in a slot).
function invocation({ run, reserveBlock = null, at = null, blocks = null, delay = 1, header = {}, footer = {} }) {
  const rows = [];
  const h = { ...clone(T.header), startedAt: run, slots: reserveBlock ? [] : SLOTS, ...header };
  delete h.at; delete h.onlyBlock;
  if (reserveBlock) { h.onlyBlock = reserveBlock; h.at = at; }
  rows.push(h);
  const list = reserveBlock ? [reserveBlock] : (blocks || SLOTS.map((s, i) => i + 1));
  for (const b of list) {
    const slot = reserveBlock ? at : SLOTS[b - 1];
    const base = { block: b, slot, run, ...(reserveBlock ? { reserve: true } : {}) };
    rows.push({ ...clone(T.cold), ...base, at: new Date(slotMs(slot) + delay * 1000).toISOString() });
    for (let it = 1; it <= 12; it++) {
      const order = it <= 2 ? M.orderFor({ block: b, index: it - 1, perBlock: 2 }) : M.orderFor({ block: b, index: it - 3, perBlock: 10 });
      for (const mode of order) {
        const src = T.data.find((r) => r.iteration === it && r.mode === mode);
        rows.push({ ...clone(src), ...base, iteration: it, warmup: it <= 2, pilot: false, order: order.join(',') });
      }
    }
    rows.push({ ...clone(T.cache), ...base });
  }
  const finished = reserveBlock ? (at === '20:40' ? '2026-11-11T15:12:00.000Z' : '2026-11-11T15:52:00.000Z') : '2026-11-11T14:31:00.000Z';
  rows.push({ ...clone(T.footer), run, finishedAt: finished, ...footer });
  return rows;
}
const rowsOf = (rows, block, kind) => rows.filter((r) => r.block === block && (!kind || r.kind === kind));
const dataRow = (rows, block, mode, it) => rows.find((r) => r.block === block && r.kind === 'sepolia' && r.mode === mode && r.iteration === it);
const MAIN = '2026-11-11T02:29:50.000Z';

function monitor({ gapAt = null, gwChangeAt = null, wifiDownAt = null, vpnAt = null, powerOffAt = null, reserveWrapper = false, restartAt = null, cpuAt = null, rxAt = null, netChangeAt = null, netBlipAt = null, netEmptyAt = null, noNet = false, reserveNet = 'netA', reserveSalt = 'salt0001' } = {}) {
  const ticks = [];
  let gw = 'synthgw1';
  let rx = 5000000; // cumulative bytes received on the uplink: 20 KB a minute, as an idle laptop
  for (let ms = slotMs('07:45'); ms <= slotMs('20:05'); ms += 60000) {
    rx += 20000;
    if (rxAt && ms === slotMs(rxAt)) rx += 2000000; // a 2 MB download in the minute of this tick
    const t = { t: new Date(ms).toISOString(), w: 4242, wid: 'aaaaaaaa', gapSeconds: 60, power: 'Online', batteryPct: 100, wifiUp: true, ifaces: ['Wireless80211:Wi-Fi'], vpn: 0, gw, cpuPct: cpuAt && Math.abs(ms - slotMs(cpuAt)) < 61000 ? 40 : 3, node: { alive: true }, rxBytes: rx, txBytes: Math.round(rx / 4), restartPending: !!(restartAt && Math.abs(ms - slotMs(restartAt)) < 61000) };
    if (!noNet) {
      // the hashed name of the connected network and the id of the salt it was hashed with (the wrappers of one day share it)
      t.saltId = 'salt0001';
      t.net = netChangeAt && ms >= slotMs(netChangeAt) ? 'netB' : (netBlipAt && Math.abs(ms - slotMs(netBlipAt)) < 61000 ? 'netB' : 'netA');
      if (netEmptyAt && Math.abs(ms - slotMs(netEmptyAt)) < 61000) t.net = '';
    }
    if (gapAt && Math.abs(ms - slotMs(gapAt)) < 61000 && ms >= slotMs(gapAt)) t.gapSeconds = 3600;
    if (gwChangeAt && ms >= slotMs(gwChangeAt)) { gw = 'synthgw2'; t.gw = gw; }
    if (wifiDownAt && Math.abs(ms - slotMs(wifiDownAt)) < 61000) t.wifiUp = false;
    if (vpnAt && Math.abs(ms - slotMs(vpnAt)) < 61000) t.vpn = 1;
    if (powerOffAt && Math.abs(ms - slotMs(powerOffAt)) < 61000) t.power = 'Offline';
    ticks.push(t);
  }
  if (reserveWrapper) {
    // a second wrapper for the reserve slot at 20:40: it REUSES the pid of the first (a pid can be reused), has its own id and
    // its own gateway hash (each wrapper salts its own), and its first tick lies inside the block's window
    for (let ms = slotMs('20:39') + 20000; ms <= slotMs('20:45'); ms += 60000) {
      ticks.push({ t: new Date(ms).toISOString(), w: 4242, wid: 'bbbbbbbb', gapSeconds: ms === slotMs('20:39') + 20000 ? 0 : 60, power: 'Online', batteryPct: 100, wifiUp: true, ifaces: ['Wireless80211:Wi-Fi'], vpn: 0, gw: 'synthgw9', cpuPct: 3, node: { alive: true }, ...(noNet ? {} : { net: reserveNet, saltId: reserveSalt }) });
    }
  }
  return ticks;
}

const url = (() => { delete process.env.SEPOLIA_RPC_URL; return R.readRpcUrl(envFile); })();
const urlParts = [...R.secretParts(url)]; // every part of the FAKE url
const urlPart = urlParts.filter((p) => p !== url).sort((a, b) => b.length - a.length)[0];

let n = 0;
let failed = 0;
function fixtureMonitor(rows) {
  const ticks = [];
  let wrapper = 0;
  const make = (t) => ({ t, w: wrapper, wid: 'fixture-' + wrapper, gapSeconds: 60,
    power: 'Online', wifiUp: true, vpn: 0, gw: 'synthetic', ifaces: ['wifi'],
    net: 'netA', saltId: 'salt0001' });
  for (const row of rows) {
    if (row.kind === 'header') { wrapper++; ticks.push(make(row.startedAt)); }
    if (row.mode === 'cold' && row.at) ticks.push(make(row.at));
  }
  return ticks;
}
function scenario(name, rows, { ticks = null, expect }) {
  n += 1;
  const log = path.join(scratch, `s${n}.jsonl`);
  fs.writeFileSync(log, `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
  const args = [checker, '--root', root, '--env', expect.noUrl ? path.join(scratch, 'empty.env') : envFile, '--deployment', expect.badRecord ? path.join(scratch, 'bad_record.json') : recordFile, '--log', log, '--date', '2026-11-11'];
  if (expect.noDateArg) args.splice(args.indexOf('--date'), 2);
  else args[args.indexOf('--date') + 1] = expect.date || '2026-11-11';
  args.push('--now', expect.now !== undefined ? expect.now : '2026-11-11T14:35:00Z');
  // The guard against a run that is still going is off unless a scenario turns it on (the logs here are all freshly written).
  if (!expect.noWindowArg) args.push('--in-progress-window', String(expect.inProgressWindow !== undefined ? expect.inProgressWindow : 0));
  const autoMonitor = ticks === null && !expect.rehearsal && expect.noMonitorFlag !== false && !expect.waiveMonitor && !expect.monitorFile;
  if (autoMonitor) ticks = fixtureMonitor(rows);
  if (expect.monitorFile === 'missing') args.push('--monitor', path.join(scratch, 'does_not_exist.jsonl'));
  else if (ticks && expect.monitorSplit) {
    // the ticks of the main wrapper and of the reserve wrapper in two files, both given with --monitor
    const half = ticks.filter((t) => t.wid !== 'bbbbbbbb'); const rest = ticks.filter((t) => t.wid === 'bbbbbbbb');
    for (const [k, part] of [['a', half], ['b', rest]]) { const mf = path.join(scratch, `s${n}.monitor.${k}.jsonl`); fs.writeFileSync(mf, `${part.map((t) => JSON.stringify(t)).join('\n')}\n`); args.push('--monitor', mf); }
  } else if (ticks) { const mf = path.join(scratch, `s${n}.monitor.jsonl`); fs.writeFileSync(mf, `${ticks.map((t) => (typeof t === 'string' ? t : JSON.stringify(t))).join('\n')}\n`); args.push('--monitor', mf); }
  else if (!expect.rehearsal && expect.noMonitorFlag !== false) args.push('--no-monitor');
  if (expect.rehearsal) args.push('--rehearsal');
  if (expect.planSlot) args.push('--plan-slot', expect.planSlot);
  if (expect.extraArgs) args.push(...expect.extraArgs);
  const blocksFile = path.join(scratch, `s${n}.blocks.json`);
  if (expect.blocksJson) args.push('--blocks-json', blocksFile);
  // Age the files (the guard reads their modification times): the log and the monitor files.
  const setAge = (file, seconds) => { const t = new Date(Date.now() - seconds * 1000); fs.utimesSync(file, t, t); };
  if (expect.logAgeS !== undefined) setAge(log, expect.logAgeS);
  if (autoMonitor && expect.logAgeS !== undefined && expect.monitorAgeS === undefined) args.forEach((a, i) => { if (a === '--monitor') setAge(args[i + 1], expect.logAgeS); });
  if (expect.monitorAgeS !== undefined) args.forEach((a, i) => { if (a === '--monitor' && fs.existsSync(args[i + 1])) setAge(args[i + 1], expect.monitorAgeS); });
  const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8' });
  const text = `${r.stdout}${r.stderr}`;
  const problems = [];
  if (r.status !== expect.exit) problems.push(`exit ${r.status}, expected ${expect.exit}`);
  if (expect.firstLine !== undefined && r.stdout.split('\n')[0] !== expect.firstLine) problems.push(`first line "${r.stdout.split('\n')[0].slice(0, 80)}"`);
  if (expect.stdout !== undefined && r.stdout.trim() !== expect.stdout) problems.push(`stdout "${r.stdout.trim()}", expected "${expect.stdout}"`);
  for (const s of expect.has || []) if (!text.includes(s)) problems.push(`missing "${s}"`);
  for (const s of expect.hasNot || []) if (text.includes(s)) problems.push(`unexpected "${s}"`);
  // no part of the (fake) url may appear in the output, except in the scenario that plants one in the log and expects a scan failure
  for (const p of urlParts) if (text.includes(p)) problems.push('THE CHECKER PRINTED A URL PART');
  if (expect.blocksJson) {
    if (!fs.existsSync(blocksFile)) problems.push('no --blocks-json file was written');
    else {
      const raw = fs.readFileSync(blocksFile, 'utf8');
      for (const p of urlParts) if (raw.includes(p)) problems.push('THE BLOCKS JSON HOLDS A URL PART');
      try { for (const msg of expect.blocksJson(JSON.parse(raw), { log })) problems.push(msg); } catch (e) { problems.push(`blocks json: ${e.message}`); }
    }
  }
  if (problems.length) failed += 1;
  console.log(`${problems.length ? 'WRONG' : 'right'}  ${String(n).padStart(2)}. ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  if (problems.length && process.env.R2_MUTATION_FAIL_FAST === '1') process.exit(1);
  if (problems.length) console.log(text.split('\n').filter((l) => /FAIL|failed|plan|slot|missing|gate failures/.test(l)).slice(0, 12).map((l) => `        ${l}`).join('\n'));
}

// ---- scenarios ---------------------------------------------------------------------------------------------------------
{
  const rows = invocation({ run: MAIN });
  scenario('a clean day: ten clean blocks', rows, { expect: { exit: 0, has: ['blocks with a clean run: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (10 of 10)', 'reserve plan: none', 'P 100, S 100, C 100, Bt 100', 'gate failures: 0'], hasNot: ['FAIL'] } });
  scenario('a clean day with a clean monitor file', rows, { ticks: monitor(), expect: { exit: 0, has: ['gate failures: 0', 'monitor: 741 ticks'], hasNot: ['FAIL', 'failed:'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 3, 'S', 5).error = 'SERVER_ERROR/ECONNRESET'; dataRow(rows, 3, 'S', 5).total_ms = null;
  scenario('block 3: an ECONNRESET row (RPC or HTTP error)', rows, { expect: { exit: 1, has: ['failed: ERROR:SERVER_ERROR/ECONNRESET', '20:40  block 3', 'blocks with a clean run: 1, 2, 4, 5, 6, 7, 8, 9, 10 (9 of 10)'], hasNot: ['21:20  block'] } });
}
{
  const rows = invocation({ run: MAIN });
  for (const b of [2, 5, 7]) { const r = dataRow(rows, b, 'C', 4); r.error = 'HTTP_429'; r.total_ms = null; }
  scenario('blocks 2, 5 and 7 fail (HTTP 429): two slots, lowest first, block 7 gets none', rows, { expect: { exit: 1, has: ['20:40  block 2', '21:20  block 5', 'no slot for block(s) 7', 'ERROR:HTTP_429; HTTP_429'], hasNot: ['20:40  block 5'] } });
}
{
  const rows = invocation({ run: MAIN, blocks: [1, 2, 3, 5, 6, 7, 8, 9, 10] });
  rows.splice(rows.findIndex((r) => r.block === 5), 0, { kind: 'block_missed', run: MAIN, block: 4, slot: '12:00', late: true });
  scenario('block 4 missed (started too late: the laptop slept)', rows, { expect: { exit: 1, has: ['BLOCK_MISSED:started too late', '20:40  block 4'] } });
}
{
  const rows = invocation({ run: MAIN, blocks: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  scenario('block 10 has no rows at all (the process ended early)', rows, { expect: { exit: 1, has: ['missing: NO_ROWS', '20:40  block 10'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 6, 'S', 7).total_ms = 12000;
  scenario('block 6: a request over 10 s', rows, { expect: { exit: 1, has: ['REQUEST_OVER_10S', '20:40  block 6'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 8, 'P', 4).requests = { eth_blockNumber: 1, eth_call: 3 };
  scenario('block 8: a P row with three eth_call (request-count check)', rows, { expect: { exit: 1, has: ['REQUEST_COUNT:P:eth_call=3'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 8, 'Bt', 4).requests = { eth_blockNumber: 1, batch: 1, eth_chainId: 1 };
  scenario('block 8: an eth_chainId request during timing', rows, { expect: { exit: 1, has: ['REQUEST_COUNT:Bt:unexpected eth_chainId'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 2, 'C', 6).sane = false;
  dataRow(rows, 2, 'P', 6).valid = false;
  scenario('block 2: sanity checks fail', rows, { expect: { exit: 1, has: ['SANITY:C reads not as expected', 'SANITY:P not valid'] } });
}
{
  const rows = invocation({ run: MAIN, delay: 1 });
  const cold = rowsOf(rows, 9, 'sepolia').find((r) => r.mode === 'cold');
  cold.at = new Date(slotMs('18:40') + 150 * 1000).toISOString();
  scenario('block 9 started 150 s after its slot', rows, { expect: { exit: 1, has: ['START_OUTSIDE_WINDOW:150 s', 'blocks with a clean run: 1, 2, 3, 4, 5, 6, 7, 8, 10 (9 of 10)', '20:40  block 9'] } });
}
{
  const rows = invocation({ run: MAIN });
  rowsOf(rows, 4, 'sepolia').find((r) => r.mode === 'cold').error = 'TIMEOUT';
  scenario('block 4: the cold-start request failed', rows, { expect: { exit: 1, has: ['ERROR:TIMEOUT'] } });
}
{
  const rows = invocation({ run: MAIN });
  rows.splice(rows.findIndex((r) => r.block === 5 && r.kind === 'sepolia' && r.iteration === 7), 1);
  scenario('block 5: one row missing (incomplete block)', rows, { expect: { exit: 1, has: ['INCOMPLETE:47/48 rows'] } });
}
{
  const rows = invocation({ run: MAIN });
  // block 7, iteration 3 is expected to run in the order P,S,C,Bt (orderFor): write another one
  dataRow(rows, 7, 'S', 3).order = 'C,Bt,P,S';
  scenario('block 7: a wrong order field (structure: the script misbehaved)', rows, { expect: { exit: 1, has: ['STRUCTURE: iteration 3: order field C,Bt,P,S', 'gate failures: 1'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 7, 'S', 1).warmup = false;
  scenario('block 7: warm-up flag wrong', rows, { expect: { exit: 1, has: ['STRUCTURE: iteration 1: warm-up flag false'] } });
}
{
  const rows = invocation({ run: MAIN });
  rows.pop();
  scenario('no footer (the process was killed)', rows, { expect: { exit: 1, has: ['FAIL footer present'] } });
}
{
  const rows = invocation({ run: MAIN });
  rows[0].commit = '73b4cca16e7c-dirty';
  scenario('header commit marked dirty', rows, { expect: { exit: 1, has: ['FAIL commit 73b4cca16e7c-dirty'] } });
}
{
  const rows = invocation({ run: MAIN, footer: { nonceUnchanged: false, deployerNonceEnd: 5 } });
  scenario('deployer nonce changed during the run', rows, { expect: { exit: 1, has: ['FAIL deployer nonce unchanged at the end (5)'] } });
}
{
  const rows = invocation({ run: MAIN });
  rows[0].blockLag = 1;
  scenario('header block lag 1 instead of 0', rows, { expect: { exit: 1, has: ['FAIL block lag 1'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 3, 'C', 2).note = urlPart;
  scenario('a part of the RPC URL appears in a row', rows, { expect: { exit: 1, has: ['FAIL self-scan of the log'] } });
}
{
  const rows = invocation({ run: MAIN });
  rows.push('{"this is not json');
  scenario('a corrupt line in the log', rows, { expect: { exit: 1, has: ['FAIL every log line is valid JSON'] } });
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 1, 'P', 3).pilot = true;
  scenario('a pilot row inside a run', rows, { expect: { exit: 1, has: ['FAIL no pilot row in the log', 'STRUCTURE: pilot row in a run'] } });
}
// monitor-based failures
scenario('monitor: a gap of an hour at block 5 (laptop slept)', invocation({ run: MAIN }), { ticks: monitor({ gapAt: '13:20' }), expect: { exit: 1, has: ['SLEEP_OR_PAUSE', '20:40  block 5', 'blocks with a clean run: 1, 2, 3, 4, 6, 7, 8, 9, 10 (9 of 10)'] } });
scenario('monitor: default gateway changes before block 6', invocation({ run: MAIN }), { ticks: monitor({ gwChangeAt: '14:39' }), expect: { exit: 1, has: ['NETWORK_CHANGE:default gateway changed', '20:40  block 6', 'blocks with a clean run: 1, 2, 3, 4, 5, 7, 8, 9, 10 (9 of 10)'] } });
scenario('monitor: Wi-Fi down at block 7', invocation({ run: MAIN }), { ticks: monitor({ wifiDownAt: '16:00' }), expect: { exit: 1, has: ['NETWORK_CHANGE:Wi-Fi down'] } });
scenario('monitor: a VPN adapter up at block 8', invocation({ run: MAIN }), { ticks: monitor({ vpnAt: '17:20' }), expect: { exit: 1, has: ['NETWORK_CHANGE:VPN adapter up'] } });
scenario('monitor: mains lost at block 9 (a note only, no failure)', invocation({ run: MAIN }), { ticks: monitor({ powerOffAt: '18:40' }), expect: { exit: 0, has: ['mains lost (note only)', 'blocks with a clean run: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (10 of 10)'], hasNot: ['FAIL'] } });
// reserve slots
{
  const main = invocation({ run: MAIN });
  dataRow(main, 3, 'S', 5).error = 'SERVER_ERROR/ECONNRESET'; dataRow(main, 3, 'S', 5).total_ms = null;
  const reserve = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' });
  scenario('block 3 failed and was repeated cleanly at 20:40: covered, exit 0', [...main, ...reserve], { expect: { exit: 0, has: ['clean only through a reserve slot: 3', 'blocks without a clean run: none', 'gate failures: 0'], hasNot: ['FAIL'] } });
}
{
  const main = invocation({ run: MAIN });
  dataRow(main, 3, 'S', 5).error = 'SERVER_ERROR/ECONNRESET'; dataRow(main, 3, 'S', 5).total_ms = null;
  const reserve = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' });
  dataRow(reserve, 3, 'P', 4).error = 'TIMEOUT'; dataRow(reserve, 3, 'P', 4).total_ms = null;
  scenario('block 3 failed and its one repetition failed too: stays missing, not repeated again', [...main, ...reserve], { expect: { exit: 1, has: ['blocks without a clean run: 3', 'every planned reserve is terminal'], hasNot: ['21:20  block 3'] } });
}
{
  const main = invocation({ run: MAIN });
  for (const b of [2, 5]) { const r = dataRow(main, b, 'C', 4); r.error = 'HTTP_429'; r.total_ms = null; }
  const reserve = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 2, at: '20:40' });
  scenario('blocks 2 and 5 failed, block 2 repeated at 20:40: the plan offers 21:20 for block 5', [...main, ...reserve], { expect: { exit: 1, has: ['21:20  block 5', 'clean only through a reserve slot: 2', '20:40  block 2: repeated'], hasNot: ['20:40  block 2:  powershell'] } });
}
{
  const main = invocation({ run: MAIN });
  const reserve = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '19:00' });
  scenario('a reserve header with a slot that is not 20:40 or 21:20', [...main, ...reserve], { expect: { exit: 1, has: ['FAIL reserve invocation for block 3 in slot 19:00'] } });
}
// the monitor file is evidence and fails closed
{
  const rows = invocation({ run: MAIN });
  scenario('no monitor flags: no reliable plan or final decision', rows, { expect: { exit: 1, noMonitorFlag: false, has: ['FAIL a monitor file is required', 'reserve plan: NOT RELIABLE (no monitor evidence)', 'NOT FINAL: no monitor file given'], blocksJson: d => d.day_rule.final === false ? [] : ['missing monitor finalised'] } });
  scenario('--no-monitor is a reviewable gate', rows, { expect: { exit: 1, waiveMonitor: true, has: ['NO_MONITOR_WAIVER'], blocksJson: d => d.gate_failures === 1 && d.fatal_gate_failures === 0 ? [] : ['waiver gate'] } });
  scenario('an empty monitor file: a failed gate, not a silent pass', rows, { ticks: [], expect: { exit: 1, has: ['FAIL monitor file: 0 ticks'] } });
  scenario('a monitor file with garbage only: a failed gate', rows, { ticks: ['not json', '{"t":"nope"}'], expect: { exit: 1, has: ['FAIL monitor file: 0 ticks, 2 unreadable'] } });
  scenario('a monitor file that does not exist: a failed gate', rows, { expect: { monitorFile: 'missing', exit: 1, has: ['FAIL monitor file: 0 ticks, 1 unreadable'] } });
  scenario('a monitor file that stops at 14:00: the later blocks fail closed', rows, { ticks: monitor().filter((t) => Date.parse(t.t) < slotMs('14:00')), expect: { exit: 1, has: ['NO_MONITOR_TICK_NEAR_BLOCK', '20:40  block 6'] } });
}
// the reserve-slot pre-commitment is enforced, not advisory
{
  const failed = (blocks) => { const m = invocation({ run: MAIN }); for (const b of blocks) { const r = dataRow(m, b, 'S', 5); r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; } return m; };
  const RES1 = '2026-11-11T15:10:00.000Z';
  const RES2 = '2026-11-11T15:50:00.000Z';
  const res = (block, at, run) => invocation({ run, reserveBlock: block, at });
  scenario('the same block repeated in both slots: gates fail', [...failed([3]), ...res(3, '20:40', RES1), ...res(3, '21:20', RES2)], { expect: { exit: 1, has: ['FAIL no block is repeated more than once', 'FAIL the reserve invocation at 21:20 repeats block 3; the plan names no block'] } });
  scenario('a clean block repeated although nothing failed: gate fails', [...invocation({ run: MAIN }), ...res(4, '20:40', RES1)], { expect: { exit: 1, has: ['FAIL the reserve invocation at 20:40 repeats block 4; the plan names no block'] } });
  scenario('a mistyped reserve block (8 instead of 3): gate fails', [...failed([3]), ...res(8, '20:40', RES1)], { expect: { exit: 1, has: ['FAIL the reserve invocation at 20:40 repeats block 8; the plan names block 3'] } });
  scenario('two main invocations in one log: gate fails', [...invocation({ run: MAIN }), ...invocation({ run: '2026-11-11T09:00:00.000Z' })], { expect: { exit: 1, has: ['FAIL exactly one main invocation in the log (2)'] } });
  scenario('a reserve invocation that started before the main run ended: gate fails', [...failed([3]), ...res(3, '20:40', '2026-11-09T15:10:00.000Z')], { expect: { exit: 1, has: ['FAIL the reserve invocation at 20:40 started after the main invocation ended'] } });
  scenario('blocks 2 and 5 failed and were repeated in order, both cleanly: covered, exit 0', [...failed([2, 5]), ...res(2, '20:40', RES1), ...res(5, '21:20', RES2)], { expect: { exit: 0, has: ['clean only through a reserve slot: 2, 5', 'every planned reserve is terminal', 'gate failures: 0'], hasNot: ['FAIL'] } });
  scenario('blocks 2 and 5 failed; they were repeated in the wrong slots: gates fail', [...failed([2, 5]), ...res(5, '20:40', RES1), ...res(2, '21:20', RES2)], { expect: { exit: 1, has: ['FAIL the reserve invocation at 20:40 repeats block 5; the plan names block 2', 'FAIL the reserve invocation at 21:20 repeats block 2; the plan names block 5'] } });
  scenario('two wrappers: the reserve wrapper has its own pid and gateway hash, no false network change', [...failed([3]), ...res(3, '20:40', RES1)], { ticks: monitor({ reserveWrapper: true }), expect: { exit: 0, has: ['clean only through a reserve slot: 3'], hasNot: ['FAIL', 'NETWORK_CHANGE'] } });
  const planned = failed([2, 5]);
  scenario('--plan-slot 20:40 names block 2', planned, { expect: { planSlot: '20:40', exit: 0, stdout: 'PLAN 20:40 2' } });
  scenario('--plan-slot 21:20 names block 5', planned, { expect: { planSlot: '21:20', exit: 0, stdout: 'PLAN 21:20 5' } });
  scenario('--plan-slot with no failed block: none, exit 4', invocation({ run: MAIN }), { expect: { planSlot: '20:40', exit: 4, stdout: 'PLAN 20:40 none' } });
  scenario('--plan-slot 19:00 is a usage error', planned, { expect: { planSlot: '19:00', exit: 2 } });
}
// the versions the run used
{
  const a = invocation({ run: MAIN }); a[0].node = 'v20.11.0';
  scenario('header node version differs from the frozen one', a, { expect: { exit: 1, has: ['FAIL node v20.11.0 (expected v22.10.0)'] } });
  const b = invocation({ run: MAIN }); b[0].ethers = 'ethers/5.7.2';
  scenario('header ethers version differs from the frozen one', b, { expect: { exit: 1, has: ['FAIL ethers ethers/5.7.2 (expected ethers/5.8.0)'] } });
}
// COR-01: the 10 s rule covers every request a row records
{
  const damaged = (name, mutate, has) => { const rows = invocation({ run: MAIN }); mutate(rows); scenario(name, rows, { expect: { exit: 1, has } }); };
  damaged('block 4: the eth_blockNumber before an S timer took 12 s', (r) => { dataRow(r, 4, 'S', 6).b0_ms = 12000; }, ['REQUEST_OVER_10S', '20:40  block 4']);
  damaged('block 4: the eth_blockNumber before a C timer took 29 s', (r) => { dataRow(r, 4, 'C', 6).b0_ms = 29000; }, ['REQUEST_OVER_10S']);
  damaged('block 4: the eth_blockNumber before a Bt timer took 11 s', (r) => { dataRow(r, 4, 'Bt', 6).b0_ms = 11000; }, ['REQUEST_OVER_10S']);
  damaged('block 4: the cold start took 15 s', (r) => { rowsOf(r, 4, 'sepolia').find((x) => x.mode === 'cold').cold_ms = 15000; }, ['REQUEST_OVER_10S']);
  damaged('block 4: the cache check read took 20 s', (r) => { const c = rowsOf(r, 4, 'cache_check')[0]; c.fresh_ms = 20000; c.known_ms = 18000; }, ['REQUEST_OVER_10S']);
}
// the structure and header rules, one damaged log each (every rule of the checker has a failing test)
{
  const damaged = (name, mutate, has) => { const rows = invocation({ run: MAIN }); mutate(rows); scenario(name, rows, { expect: { exit: 1, has } }); };
  damaged('header: another script', (r) => { r[0].script = 'other.js'; }, ['FAIL header: measure-sepolia.js']);
  damaged('header: label pilot', (r) => { r[0].label = 'pilot'; }, ['FAIL header: measure-sepolia.js, label pilot']);
  damaged('header: chain 1', (r) => { r[0].chainId = 1; }, ['FAIL chain 1']);
  damaged('header: three warm-up iterations', (r) => { r[0].warmup = 3; }, ['FAIL warm-up 3 and timed 10']);
  damaged('header: five timed iterations', (r) => { r[0].timed = 5; }, ['FAIL warm-up 2 and timed 5']);
  damaged('header: another contract', (r) => { r[0].contract = '0x0000000000000000000000000000000000000001'; }, ['FAIL contract equals the deployment record']);
  damaged('header: another credential B', (r) => { r[0].credentialB = 'urn:uuid:00000000-0000-0000-0000-000000000000'; }, ['FAIL credential B equals the deployment record']);
  damaged('header: another deployer', (r) => { r[0].deployer = '0x0000000000000000000000000000000000000002'; }, ['FAIL deployer and nonce at the start']);
  damaged('header: deployer nonce 3 at the start', (r) => { r[0].deployerNonceStart = 3; }, ['FAIL deployer and nonce at the start (3)']);
  damaged('header: another provider label', (r) => { r[0].provider = 'other-host.example'; }, ['FAIL provider label in the log: other-host.example']);
  damaged('header: time zone offset 0', (r) => { r[0].timezoneOffsetMinutes = 0; }, ['FAIL time zone offset 0 min']);
  damaged('header: keep-alive off', (r) => { r[0].agents.keepAlive = false; }, ['FAIL keep-alive agents']);
  damaged('header: last-in-first-out scheduling', (r) => { r[0].agents.scheduling = 'lifo'; }, ['FAIL keep-alive agents']);
  damaged('header: nine slots', (r) => { r[0].slots = r[0].slots.slice(0, 9); }, ['FAIL ten slots as fixed in the plan']);
  damaged('header: a request timeout of 1000 ms', (r) => { r[0].requestTimeoutMs = 1000; }, ['FAIL request timeout 1000 ms']);
  damaged('a row of another run', (r) => { dataRow(r, 2, 'P', 3).run = '2026-11-11T00:00:00.000Z'; }, ['FAIL every row carries this invocation\'s run id (1 foreign)']);
  damaged('a row before the first header', (r) => { r.unshift({ kind: 'sepolia', mode: 'P', block: 1 }); }, ['FAIL no row before the first header (1)']);
  damaged('block 4: no cold-start row', (r) => { r.splice(r.findIndex((x) => x.block === 4 && x.mode === 'cold'), 1); }, ['STRUCTURE: 0 cold-start rows']);
  damaged('block 4: no cache-check row', (r) => { r.splice(r.findIndex((x) => x.block === 4 && x.kind === 'cache_check'), 1); }, ['STRUCTURE: 0 cache-check rows']);
  damaged('block 4: a cache-check row with an error', (r) => { rowsOf(r, 4, 'cache_check')[0].error = 'TIMEOUT'; }, ['ERROR:TIMEOUT']);
  damaged('block 4: a P row without its step times', (r) => { delete dataRow(r, 4, 'P', 4).steps.V6; }, ['P row without the nine step times']);
  damaged('block 4: a row without a time and without an error', (r) => { dataRow(r, 4, 'C', 4).total_ms = null; }, ['NO_TIME']);
  damaged('block 4: P valid but its reason is not VALID', (r) => { dataRow(r, 4, 'P', 4).reason = 'CREDENTIAL_REVOKED'; }, ['SANITY:P not valid']);
  damaged('block 4: a row without its block number', (r) => { delete dataRow(r, 4, 'Bt', 4).blockNumber; }, ['NO_BLOCK_NUMBER']);
  damaged('block 4: two rows of an iteration in the wrong sequence', (r) => {
    const i = r.findIndex((x) => x.block === 4 && x.kind === 'sepolia' && x.iteration === 5 && x.mode !== 'cold');
    [r[i], r[i + 1]] = [r[i + 1], r[i]];
  }, ['STRUCTURE: iteration 5: modes']);
  damaged('block 4: a cold-start row without a start time', (r) => { delete rowsOf(r, 4, 'sepolia').find((x) => x.mode === 'cold').at; }, ['NO_START_TIME']);
  damaged('block 4: started 5 s before its slot', (r) => { rowsOf(r, 4, 'sepolia').find((x) => x.mode === 'cold').at = new Date(slotMs('12:00') - 5000).toISOString(); }, ['START_OUTSIDE_WINDOW:-5 s']);
}
// the monitor rules at their boundaries
{
  const rows = invocation({ run: MAIN });
  const at = (ticks, hhmm, change) => { const t = ticks.find((x) => Date.parse(x.t) === slotMs(hhmm)); Object.assign(t, change); return ticks; };
  scenario('monitor: a gap of exactly 90 s is not a sleep', rows, { ticks: at(monitor(), '13:20', { gapSeconds: 90 }), expect: { exit: 0, hasNot: ['SLEEP_OR_PAUSE'] } });
  scenario('monitor: a gap of 91 s is a sleep', rows, { ticks: at(monitor(), '13:20', { gapSeconds: 91 }), expect: { exit: 1, has: ['SLEEP_OR_PAUSE:gap 91 s'] } });
  // COR-02: a suspend that starts 10 s into block 5 and lasts 10 minutes: the tick that shows it is written after the window
  const t = monitor().filter((x) => Date.parse(x.t) < slotMs('13:20') + 10000 || Date.parse(x.t) > slotMs('13:30') + 10000);
  t.push({ t: new Date(slotMs('13:30') + 10000).toISOString(), w: 4242, wid: 'aaaaaaaa', gapSeconds: 600, power: 'Online', batteryPct: 100, wifiUp: true, ifaces: ['Wireless80211:Wi-Fi'], vpn: 0, gw: 'synthgw1', cpuPct: 3, node: { alive: true } });
  scenario('monitor: a 10-minute suspend that starts inside block 5 (its tick is written after the window)', rows, { ticks: t.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)), expect: { exit: 1, has: ['SLEEP_OR_PAUSE:gap 600 s', '20:40  block 5'] } });
  // a gap tick whose interval ended long before the block does not count
  scenario('monitor: a 10-minute sleep between blocks 4 and 5 (12:40-12:50) fails neither', rows, { ticks: at(monitor(), '12:50', { gapSeconds: 600 }), expect: { exit: 0, hasNot: ['SLEEP_OR_PAUSE'] } });
  // the set of uplink interfaces changes with the gateway unchanged
  const ifc = monitor().map((x) => (Date.parse(x.t) >= slotMs('14:39') ? { ...x, ifaces: ['Wireless80211:Wi-Fi', 'Ethernet:Other'] } : x));
  scenario('monitor: the interfaces that are up change, the gateway does not', rows, { ticks: ifc, expect: { exit: 1, has: ['NETWORK_CHANGE:interfaces up changed', '20:40  block 6'] } });
  // COR-06: the ticks of two wrappers in two files, both given
  const failed = invocation({ run: MAIN }); dataRow(failed, 3, 'S', 5).error = 'SERVER_ERROR/ECONNRESET'; dataRow(failed, 3, 'S', 5).total_ms = null;
  scenario('two --monitor files (main wrapper, reserve wrapper): the repetition is clean', [...failed, ...invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' })], { ticks: monitor({ reserveWrapper: true }), expect: { monitorSplit: true, exit: 0, has: ['clean only through a reserve slot: 3', 'repeated, clean'], hasNot: ['FAIL', 'NETWORK_CHANGE'] } });
  scenario('only the main wrapper\'s monitor file after a reserve run: the repetition has no tick (documented: give every file)', [...failed, ...invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' })], { ticks: monitor(), expect: { exit: 1, has: ['NO_MONITOR_TICK_NEAR_BLOCK'] } });
  scenario('a monitor file with valid ticks and one garbage line: a failed gate', rows, { ticks: [...monitor().slice(0, 5), 'garbage'], expect: { exit: 1, has: ['FAIL monitor file: 5 ticks, 1 unreadable'] } });
}
// the checker without a URL, and a reserve header that is not what the script writes
scenario('no URL in the env file: the self-scan cannot run, a failed gate', invocation({ run: MAIN }), { expect: { noUrl: true, exit: 1, has: ['FAIL self-scan of the log for parts of the RPC URL and banned strings: URL not loaded'] } });
{
  const main = invocation({ run: MAIN });
  const reserve = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' });
  reserve[0].at = 2040;
  scenario('a reserve header whose slot is a number, not a string: no crash, a failed gate', [...main, ...reserve], { expect: { exit: 1, has: ['FAIL reserve invocation for block 3 in slot 2040'], hasNot: ['TypeError'] } });
}
// ---- review 18 (PM-09): one scenario for each gap that a mutation run of the checker found ----------------------------------
{
  const damaged = (name, mutate, has, extra = {}) => { const rows = invocation({ run: MAIN }); mutate(rows); scenario(name, rows, { expect: { exit: 1, has, ...extra } }); };
  const clean = (name, mutate, hasNot = ['FAIL', 'REQUEST_OVER_10S', 'START_OUTSIDE_WINDOW']) => { const rows = invocation({ run: MAIN }); mutate(rows); scenario(name, rows, { expect: { exit: 0, hasNot } }); };
  const coldOf = (r, b) => rowsOf(r, b, 'sepolia').find((x) => x.mode === 'cold');
  // a retry must fail, not only a missing request
  damaged('block 8: a P row with five eth_call (a retry)', (r) => { dataRow(r, 8, 'P', 4).requests = { eth_blockNumber: 1, eth_call: 5 }; }, ['REQUEST_COUNT:P:eth_call=5']);
  damaged('block 8: an S row with two eth_blockNumber (the block-number read was repeated)', (r) => { dataRow(r, 8, 'S', 4).requests = { eth_blockNumber: 2, eth_call: 4 }; }, ['REQUEST_COUNT:S:eth_blockNumber=2']);
  damaged('block 8: a Bt row with two batches', (r) => { dataRow(r, 8, 'Bt', 4).requests = { eth_blockNumber: 1, batch: 2 }; }, ['REQUEST_COUNT:Bt:batch=2']);
  damaged('block 8: a Bt row with an eth_call besides its batch', (r) => { dataRow(r, 8, 'Bt', 4).requests = { eth_blockNumber: 1, batch: 1, eth_call: 1 }; }, ['REQUEST_COUNT:Bt:unexpected eth_call']);
  damaged('block 8: chainIdDuringTimer is 1 although the request table is clean', (r) => { dataRow(r, 8, 'C', 4).chainIdDuringTimer = 1; }, ['CHAIN_ID_DURING_TIMER']);
  // structure
  damaged('block 4: a block number that is a string', (r) => { dataRow(r, 4, 'P', 4).blockNumber = '12099364'; }, ['NO_BLOCK_NUMBER']);
  damaged('block 4: a block number that is null', (r) => { dataRow(r, 4, 'P', 5).blockNumber = null; }, ['NO_BLOCK_NUMBER']);
  damaged('block 4: a second cold-start row', (r) => { const c = coldOf(r, 4); r.splice(r.indexOf(c) + 1, 0, clone(c)); }, ['STRUCTURE: 2 cold-start rows']);
  damaged('block 4: a second cache-check row', (r) => { const c = rowsOf(r, 4, 'cache_check')[0]; r.splice(r.indexOf(c) + 1, 0, clone(c)); }, ['STRUCTURE: 2 cache-check rows']);
  damaged('block 4: 49 data rows (one row twice)', (r) => { const c = dataRow(r, 4, 'C', 9); r.splice(r.indexOf(c) + 1, 0, clone(c)); }, ['INCOMPLETE:49/48 rows']);
  damaged('block 4: a P row without V8', (r) => { delete dataRow(r, 4, 'P', 4).steps.V8; }, ['P row without the nine step times']);
  damaged('block 4: a P row without B0', (r) => { delete dataRow(r, 4, 'P', 4).steps.B0; }, ['P row without the nine step times']);
  damaged('block 6: an S row with one read over 10 s that its total does not show (the reads_ms rule alone)', (r) => { dataRow(r, 6, 'S', 7).reads_ms = [141, 12000, 178, 144]; }, ['REQUEST_OVER_10S']);
  // the 10 s limit and the start window at their edges
  clean('block 6: an S row of exactly 10000 ms is not over 10 s', (r) => { dataRow(r, 6, 'S', 7).total_ms = 10000; });
  damaged('block 6: an S row of 10001 ms is over 10 s', (r) => { dataRow(r, 6, 'S', 7).total_ms = 10001; }, ['REQUEST_OVER_10S']);
  clean('block 6: a C block-number read of exactly 10000 ms is not over 10 s', (r) => { dataRow(r, 6, 'C', 7).b0_ms = 10000; });
  const startAt = (r, block, hhmm, deltaS) => { coldOf(r, block).at = new Date(slotMs(hhmm) + deltaS * 1000).toISOString(); };
  clean('block 9 started exactly 120 s after its slot', (r) => startAt(r, 9, '18:40', 120));
  damaged('block 9 started 121 s after its slot', (r) => startAt(r, 9, '18:40', 121), ['START_OUTSIDE_WINDOW:121 s']);
  clean('block 9 started 1 s before its slot (clock granularity)', (r) => startAt(r, 9, '18:40', -1));
}
// the monitor window at its edges: the first tick that shows a new gateway decides, and only if it lies in [start - 90 s, start + 120 s]
{
  const rows = invocation({ run: MAIN });
  const gwChangeShownAt = (ms) => {
    const t = monitor().map((x) => (Date.parse(x.t) > ms ? { ...x, gw: 'synthgw2' } : x));
    const before = t.filter((x) => Date.parse(x.t) <= ms).pop();
    t.push({ ...before, t: new Date(ms).toISOString(), gw: 'synthgw2' });
    return t.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  };
  const s5 = slotMs('13:20') + 1000; // block 5 starts 1 s after its slot in these logs
  scenario('monitor: a change of gateway first shown 100 s after the start of block 5 fails it', rows, { ticks: gwChangeShownAt(s5 + 100000), expect: { exit: 1, has: ['NETWORK_CHANGE:default gateway changed', '20:40  block 5'] } });
  scenario('monitor: a change of gateway first shown 130 s after the start of block 5 does not', rows, { ticks: gwChangeShownAt(s5 + 130000), expect: { exit: 0, hasNot: ['NETWORK_CHANGE'] } });
  scenario('monitor: a change of gateway first shown 80 s before the start of block 5 fails it', rows, { ticks: gwChangeShownAt(s5 - 80000), expect: { exit: 1, has: ['NETWORK_CHANGE:default gateway changed', '20:40  block 5'] } });
  scenario('monitor: a change of gateway first shown 100 s before the start of block 5 does not', rows, { ticks: gwChangeShownAt(s5 - 100000), expect: { exit: 0, hasNot: ['NETWORK_CHANGE'] } });
}
// the footer and the reserve count
scenario('footer: nonceUnchanged true although the nonce at the end is 5', invocation({ run: MAIN, footer: { nonceUnchanged: true, deployerNonceEnd: 5 } }), { expect: { exit: 1, has: ['FAIL deployer nonce unchanged at the end (5)'] } });
scenario('footer: nonce 4 at the end but nonceUnchanged false', invocation({ run: MAIN, footer: { nonceUnchanged: false, deployerNonceEnd: 4 } }), { expect: { exit: 1, has: ['FAIL deployer nonce unchanged at the end (4)'] } });
{
  const m = invocation({ run: MAIN });
  for (const b of [2, 5, 7]) { const r = dataRow(m, b, 'S', 5); r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; }
  const res = (block, at, run) => invocation({ run, reserveBlock: block, at });
  scenario('three reserve invocations: the count gate fails', [...m, ...res(2, '20:40', '2026-11-11T15:10:00.000Z'), ...res(5, '21:20', '2026-11-11T15:50:00.000Z'), ...res(7, '21:20', '2026-11-11T16:30:00.000Z')], { expect: { exit: 1, has: ['FAIL at most 2 reserve invocations (3)'] } });
}
// the guard against a run that is still going (exit 5)
{
  const going = () => { const r = invocation({ run: MAIN, blocks: [1, 2, 3] }); r.pop(); return r; }; // header, blocks 1-3, no footer
  scenario('a run in progress (no footer, the log written just now): no verdict, no plan, exit 5', going(), { expect: { inProgressWindow: 120, exit: 5, has: ['RUN STILL IN PROGRESS', 'No verdict and no plan yet'], hasNot: ['Start-Process', 'reserve plan', 'FAIL'] } });
  scenario('the same log written 10 minutes ago (the process was killed): the failure verdict and the plan, exit 1', going(), { expect: { inProgressWindow: 120, logAgeS: 600, exit: 1, has: ['FAIL footer present', '20:40  block 4'] } });
  scenario('log written an hour ago, monitor file just now (a wrapper waits for the next slot): in progress, exit 5', going(), { ticks: monitor(), expect: { inProgressWindow: 120, logAgeS: 3600, monitorAgeS: 0, exit: 5, has: ['RUN STILL IN PROGRESS'] } });
  scenario('log and monitor file both written an hour ago: the verdict, exit 1', going(), { ticks: monitor(), expect: { inProgressWindow: 120, logAgeS: 3600, monitorAgeS: 3600, exit: 1, has: ['FAIL footer present'] } });
  scenario('a finished run written just now is not held back by the guard', invocation({ run: MAIN }), { expect: { inProgressWindow: 120, exit: 0, hasNot: ['RUN STILL IN PROGRESS'] } });
  scenario('a rehearsal log without a footer is judged, not held back', template.filter((r) => r.kind !== 'footer'), { expect: { rehearsal: true, inProgressWindow: 120, exit: 1, has: ['FAIL footer present'], hasNot: ['RUN STILL IN PROGRESS'] } });
  scenario('--in-progress-window abc is a usage error', invocation({ run: MAIN }), { expect: { inProgressWindow: 'abc', exit: 2 } });
  scenario('--in-progress-window -5 is a usage error', invocation({ run: MAIN }), { expect: { inProgressWindow: -5, exit: 2 } });
}
// the checker's own failure modes and identity
scenario('a corrupt deployment record: the checker ends with exit 3 and a stack, and prints no URL part', invocation({ run: MAIN }), { expect: { badRecord: true, exit: 3, has: ['SyntaxError'] } });
scenario('the first line of the output is the checker\'s own SHA-256', invocation({ run: MAIN }), { expect: { exit: 0, has: [`check_sepolia_run.js SHA-256 ${SELF_SHA}`] } });
// instruments that are notes and never failures
{
  const rows = invocation({ run: MAIN });
  scenario('monitor: a Windows restart pending in the minute of block 3 is a note, not a failure', rows, { ticks: monitor({ restartAt: '10:40' }), expect: { exit: 0, has: ['Windows restart pending (note only)'], hasNot: ['FAIL'] } });
  scenario('monitor: 40 % CPU in a tick of block 3 is a note, not a failure', rows, { ticks: monitor({ cpuAt: '10:40' }), expect: { exit: 0, has: ['CPU 40% in a tick (note only)'], hasNot: ['FAIL'] } });
  scenario('monitor: 2 MB received in the minute of a tick of block 3 is a note, not a failure', rows, { ticks: monitor({ rxAt: '10:40' }), expect: { exit: 0, has: ['KB received in the minute of a tick (note only)'], hasNot: ['FAIL'] } });
  scenario('monitor: an idle laptop (20 KB a minute, 3 % CPU, no restart pending) gives no note about traffic, CPU or restarts', rows, { ticks: monitor(), expect: { exit: 0, hasNot: ['received in the minute', 'in a tick (note only)', 'restart pending'] } });
}
// PM-11: the count the checker prints on the day must equal the n that the analysis script will use for the paper
function compareWithAnalysis(name, rows, { counts, clusters }) {
  n += 1;
  const log = path.join(scratch, `s${n}.jsonl`);
  fs.writeFileSync(log, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
  const r = cp.spawnSync(process.execPath, [checker, '--root', root, '--env', envFile, '--deployment', recordFile, '--log', log, '--date', '2026-11-11', '--no-monitor', '--in-progress-window', '0'], { encoding: 'utf8' });
  const m = /per mode \(what the analysis counts\): P (\d+), S (\d+), C (\d+), Bt (\d+)/.exec(r.stdout);
  const theirs = A.analyzeSepolia(JSON.parse(JSON.stringify(rows))).out;
  const problems = [];
  if (!m) problems.push('no count line in the checker output');
  else {
    ['P', 'S', 'C', 'Bt'].forEach((mode, i) => {
      const analysisN = theirs.modes[mode] ? theirs.modes[mode].n : 0;
      if (Number(m[i + 1]) !== analysisN) problems.push(`${mode}: checker ${m[i + 1]}, analysis ${analysisN}`);
      if (Number(m[i + 1]) !== counts[mode]) problems.push(`${mode}: ${m[i + 1]}, expected ${counts[mode]}`);
    });
  }
  if (theirs.clusters.P.k !== clusters) problems.push(`P clusters ${theirs.clusters.P.k}, expected ${clusters}`);
  if (problems.length) failed += 1;
  console.log(`${problems.length ? 'WRONG' : 'right'}  ${String(n).padStart(2)}. ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  if (problems.length && process.env.R2_MUTATION_FAIL_FAST === '1') process.exit(1);
}
{
  compareWithAnalysis('n per mode, a clean day: the checker and analyze-latency.js agree (100 each, 10 clusters)', invocation({ run: MAIN }), { counts: { P: 100, S: 100, C: 100, Bt: 100 }, clusters: 10 });
  const f = invocation({ run: MAIN }); dataRow(f, 3, 'S', 5).error = 'SERVER_ERROR/ECONNRESET'; dataRow(f, 3, 'S', 5).total_ms = null;
  compareWithAnalysis('n per mode, block 3 failed and repeated cleanly: every successful row counts (S 109, 11 clusters)', [...f, ...invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' })], { counts: { P: 110, S: 109, C: 110, Bt: 110 }, clusters: 11 });
  const g = invocation({ run: MAIN });
  dataRow(g, 2, 'P', 6).valid = false;
  dataRow(g, 4, 'C', 5).total_ms = null;
  const e = dataRow(g, 6, 'Bt', 7); e.error = 'TIMEOUT'; e.total_ms = null;
  dataRow(g, 7, 'S', 8).sane = false;
  dataRow(g, 8, 'C', 6).error = 'TIMEOUT'; // an error code on a row that still has a finite time and sane reads: both exclude it
  compareWithAnalysis('n per mode: an invalid P row, two C rows lost (no time; an error code with a time), a Bt error row and an S row that is not sane', g, { counts: { P: 99, S: 99, C: 98, Bt: 99 }, clusters: 10 });
}
// review 19 (M-01, M-02, M-04): no latency value in the day's output, the short-first plan order, the day rule
{
  scenario('default output: no latency value (no cold-start time, no CU estimate), usable row counts instead', invocation({ run: MAIN }), { expect: { exit: 0, has: ['usable timed rows P S C Bt', ' 10  10  10  10', 'THE DAY STANDS', '10 of 10 slots covered'], hasNot: ['cold ms', 'est. CU/s', 'estimated draw'] } });
  scenario('--values prints the cold-start time and the CU estimate', invocation({ run: MAIN }), { expect: { exit: 0, extraArgs: ['--values'], has: ['cold ms', 'est. CU/s', 'estimated draw on the throughput limit'], hasNot: ['usable timed rows P S C Bt'] } });
  // the plan order: short blocks first (fewer than 5 usable timed rows in some mode, or no rows), then the lowest block number
  const withErrors = (rows, block, mode, iterations) => { for (const it of iterations) { const r = dataRow(rows, block, mode, it); r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; } };
  {
    const rows = invocation({ run: MAIN, blocks: [1, 2, 3, 4, 5, 6, 8, 9, 10] });
    rows.splice(rows.findIndex((r) => r.block === 8), 0, { kind: 'block_missed', run: MAIN, block: 7, slot: '16:00', late: true });
    withErrors(rows, 2, 'S', [5]); withErrors(rows, 5, 'S', [5]);
    scenario('plan order: block 7 has no rows, blocks 2 and 5 one error row each: block 7 gets 20:40, block 2 gets 21:20, block 5 none', rows, { expect: { exit: 1, has: ['20:40  block 7', '21:20  block 2', 'no slot for block(s) 5'], hasNot: ['20:40  block 2'] } });
  }
  {
    const rows = invocation({ run: MAIN });
    withErrors(rows, 3, 'S', [3, 4, 5, 6, 7, 8]); withErrors(rows, 2, 'S', [5]);
    scenario('plan order: block 3 has only 4 usable S rows (short), block 2 one error row: block 3 first', rows, { expect: { exit: 1, has: ['20:40  block 3', '21:20  block 2'], hasNot: ['20:40  block 2'] } });
  }
  {
    const rows = invocation({ run: MAIN });
    withErrors(rows, 3, 'S', [3, 4, 5, 6, 7]); withErrors(rows, 2, 'S', [5]);
    scenario('plan order: block 3 has exactly 5 usable S rows (not short), block 2 one error row: lowest number first', rows, { expect: { exit: 1, has: ['20:40  block 2', '21:20  block 3'], hasNot: ['20:40  block 3'] } });
  }
  // the day rule: at least 8 of 10 slots covered and at least 80 usable timed rows in every mode of the primary dataset
  const missing = (rows, block, slot, before) => { const i = rows.findIndex((r) => r.block === before); rows.splice(i, 0, { kind: 'block_missed', run: MAIN, block, slot, late: true }); };
  {
    const rows = invocation({ run: MAIN, blocks: [1, 2, 3, 5, 6, 7, 8, 10] });
    missing(rows, 4, '12:00', 5); missing(rows, 9, '18:40', 10);
    scenario('day rule: two blocks missing, repetitions still to run: 8 slots covered, 80 rows, but NOT FINAL (no verdict yet)', rows, { expect: { exit: 1, has: ['8 of 10 slots covered (8 needed; 0 represented by a repetition)', 'P 80, S 80, C 80, Bt 80 (80 needed in each mode): NOT FINAL', '4 (20:40), 9 (21:20)'], hasNot: ['THE DAY STANDS', 'THE DAY IS FAILED'] } });
    // both planned repetitions have run and are short too (4 usable S rows): nothing can change, the verdict is final
    const reps = (blocks) => blocks.flatMap(([b, at, run]) => { const r = invocation({ run, reserveBlock: b, at }); withErrors(r, b, 'S', [3, 4, 5, 6, 7, 8]); return r; });
    scenario('day rule: two blocks missing, both repetitions judged (short too): 8 slots covered, 80 rows in every mode: the day stands (exactly at the limits)', [...rows, ...reps([[4, '20:40', '2026-11-11T15:10:00.000Z'], [9, '21:20', '2026-11-11T15:50:00.000Z']])], { expect: { exit: 1, has: ['8 of 10 slots covered (8 needed; 0 represented by a repetition)', 'P 80, S 80, C 80, Bt 80 (80 needed in each mode): THE DAY STANDS'], hasNot: ['NOT FINAL'] } });
  }
  {
    const rows = invocation({ run: MAIN, blocks: [1, 2, 3, 5, 6, 7, 8, 10] });
    missing(rows, 4, '12:00', 5); missing(rows, 9, '18:40', 10);
    withErrors(rows, 1, 'S', [5]);
    scenario('day rule: 8 slots covered but S has 79 usable rows, repetitions still to run: NOT FINAL', rows, { expect: { exit: 1, has: ['8 of 10 slots covered', 'P 80, S 79, C 80, Bt 80 (80 needed in each mode): NOT FINAL'], hasNot: ['THE DAY IS FAILED'] } });
    const repsFor = (blocks) => blocks.flatMap(([b, at, run]) => { const r = invocation({ run, reserveBlock: b, at }); withErrors(r, b, 'S', [3, 4, 5, 6, 7, 8]); return r; });
    scenario('day rule: 8 slots covered but S has 79 usable rows, both repetitions judged (short too): the day is failed', [...rows, ...repsFor([[4, '20:40', '2026-11-11T15:10:00.000Z'], [9, '21:20', '2026-11-11T15:50:00.000Z']])], { expect: { exit: 1, has: ['8 of 10 slots covered', 'P 80, S 79, C 80, Bt 80 (80 needed in each mode): THE DAY IS FAILED'], hasNot: ['NOT FINAL'] } });
  }
  {
    const rows = invocation({ run: MAIN, blocks: [1, 2, 4, 5, 6, 8, 9, 10] });
    missing(rows, 3, '10:40', 4); missing(rows, 7, '16:00', 8);
    scenario('day rule: two blocks missing, no repetition yet: 8 covered, NOT FINAL (the repetitions can still change it)', rows, { expect: { exit: 1, has: ['8 of 10 slots covered', 'NOT FINAL'], hasNot: ['THE DAY STANDS'] } });
    const three = invocation({ run: MAIN, blocks: [1, 2, 4, 5, 6, 8, 10] });
    missing(three, 3, '10:40', 4); missing(three, 7, '16:00', 8); missing(three, 9, '18:40', 10);
    scenario('day rule: three blocks missing, repetitions still to run: 7 slots covered, NOT FINAL', three, { expect: { exit: 1, has: ['7 of 10 slots covered (8 needed', 'P 70, S 70, C 70, Bt 70 (80 needed in each mode): NOT FINAL'], hasNot: ['THE DAY IS FAILED'] } });
    const threeReps = [[3, '20:40', '2026-11-11T15:10:00.000Z'], [7, '21:20', '2026-11-11T15:50:00.000Z']].flatMap(([b, at, run]) => { const r = invocation({ run, reserveBlock: b, at }); withErrors(r, b, 'S', [3, 4, 5, 6, 7, 8]); return r; });
    scenario('day rule: three blocks missing, both repetitions judged (short too): 7 slots covered, 70 rows: the day is failed', [...three, ...threeReps], { expect: { exit: 1, has: ['7 of 10 slots covered (8 needed', 'P 70, S 70, C 70, Bt 70 (80 needed in each mode): THE DAY IS FAILED (RUN_DAY.md: run 12 Nov once, in full)'], hasNot: ['NOT FINAL'] } });
  }
  {
    const rows = invocation({ run: MAIN });
    for (const b of [1, 2, 3, 4, 5]) withErrors(rows, b, 'S', [3, 4, 5, 6, 7]);
    scenario('day rule: every slot covered (5 usable S rows each in five blocks) but S has 75 usable rows: the day is failed', rows, { expect: { exit: 1, has: ['10 of 10 slots covered', 'P 100, S 75, C 100, Bt 100 (80 needed in each mode): THE DAY IS FAILED'] } });
  }
  {
    const main = invocation({ run: MAIN, blocks: [1, 2, 3, 5, 6, 7, 8, 9, 10] });
    missing(main, 4, '12:00', 5);
    scenario('day rule: block 4 missed and repeated cleanly at 20:40: the repetition stands for the slot (10 of 10, 100 rows each)', [...main, ...invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 4, at: '20:40' })], { expect: { exit: 0, has: ['10 of 10 slots covered (8 needed; 1 represented by a repetition)', 'P 100, S 100, C 100, Bt 100 (80 needed in each mode): THE DAY STANDS'] } });
    const bad = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 4, at: '20:40' });
    withErrors(bad, 4, 'S', [3, 4, 5, 6, 7, 8]);
    scenario('day rule: block 4 missed, its repetition is short too: it does not stand for the slot (9 of 10 covered)', [...main, ...bad], { expect: { exit: 1, has: ['9 of 10 slots covered (8 needed; 0 represented by a repetition)', 'P 90, S 90, C 90, Bt 90 (80 needed in each mode): THE DAY STANDS'] } });
  }
  {
    const main = invocation({ run: MAIN });
    withErrors(main, 3, 'S', [5]);
    scenario('day rule: block 3 has one error row (not short) and a clean repetition: the repetition does not replace it (S 99)', [...main, ...invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' })], { expect: { exit: 0, has: ['10 of 10 slots covered (8 needed; 0 represented by a repetition)', 'P 100, S 99, C 100, Bt 100 (80 needed in each mode): THE DAY STANDS'] } });
  }
  scenario('day rule: not printed for a rehearsal', template, { expect: { rehearsal: true, exit: 0, hasNot: ['day rule'] } });
}
// round 5 (loop-2 correctness review C2-01 to C2-11): the network identity, the verdict file, the options, the analysis refusals
{
  const rows = invocation({ run: MAIN });
  const ruleLine = 'NETWORK_CHANGE:network differs from the start of the run';
  scenario('network identity: the network name changes for good at 15:30 (between blocks 6 and 7): blocks 7-10 fail, are off-net and unfit; the day rule is NOT FINAL', rows, { ticks: monitor({ netChangeAt: '15:30' }), expect: { exit: 1, has: [`failed: ${ruleLine}`, 'off-net', '20:40  block 7', '21:20  block 8', 'NOT FINAL: the planned repetition(s) of unfit block(s) 7 (20:40), 8 (21:20)', 'network identity (note):', 'blocks with a clean run: 1, 2, 3, 4, 5, 6 (6 of 10)'] } });
  scenario('network identity: the gateway changes for good under the same network name (a restarted hotspot): no failure, the day-level line says the same network', rows, { ticks: monitor({ gwChangeAt: '15:30' }), expect: { exit: 0, has: ['network identity: the same at all 741 ticks'], hasNot: ['off-net', 'FAIL', 'NETWORK_CHANGE'] } });
  scenario('network identity: another network name for 3 ticks around block 5: block 5 fails and is off-net, the others are clean', rows, { ticks: monitor({ netBlipAt: '13:20' }), expect: { exit: 1, has: [`failed: ${ruleLine}`, '3 of 741 ticks show another network', '20:40  block 5'], hasNot: ['20:40  block 6'] } });
  scenario('network identity: all ticks in block 5 have no profile', rows, { ticks: monitor().map(t => Math.abs(Date.parse(t.t) - slotMs('13:20')) <= 120000 ? { ...t, net: '' } : t), expect: { exit: 1, has: ['failed: NETWORK_IDENTITY_UNKNOWN:no comparable network identity', '20:40  block 5', 'ticks with no network profile'], hasNot: ['off-net', 'ticks show another network'] } });
  scenario('network identity: ticks without a network name: baseline fails and all blocks are unknown', rows, { ticks: monitor({ noNet: true }), expect: { exit: 1, has: ['network identity: not available', 'FAIL network identity baseline missing'], hasNot: ['off-net'] } });
  const failed3 = invocation({ run: MAIN }); { const r = dataRow(failed3, 3, 'S', 5); r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; }
  const rep3 = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 3, at: '20:40' });
  scenario('network identity: the reserve wrapper is on another network (same salt): its repetition fails and is off-net', [...failed3, ...rep3], { ticks: monitor({ reserveWrapper: true, reserveNet: 'netB' }), expect: { exit: 1, has: ['off-net', `failed: ${ruleLine}`] } });
  scenario('network identity: the reserve wrapper has another salt: repetition is unknown and unfit', [...failed3, ...rep3], { ticks: monitor({ reserveWrapper: true, reserveNet: 'netZ', reserveSalt: 'salt0002' }), expect: { exit: 1, has: ['NETWORK_IDENTITY_UNKNOWN', 'blocks without a clean run: 3'], hasNot: ['off-net'] } });
  // the verdict file, the options, the first line
  scenario('a verdict file that cannot be written (a directory): a failed gate, and the report is still printed', rows, { expect: { exit: 1, extraArgs: ['--blocks-json', scratch], has: ['FAIL the verdict file was NOT written (EISDIR)', 'day rule', 'blocks with a clean run'] } });
  for (const bad of ['', ' 7', '1e3', '0x10', '1.5']) scenario(`--in-progress-window "${bad}" is a usage error (digits only)`, rows, { expect: { inProgressWindow: bad, exit: 2 } });
  const going = invocation({ run: MAIN, blocks: [1, 2, 3] }); going.pop();
  scenario('the documented command without --in-progress-window uses the default (120 s): a fresh log without a footer is in progress, exit 5', going, { expect: { noWindowArg: true, exit: 5, has: ['RUN STILL IN PROGRESS'] } });
  scenario('the first line of the output is the checker\'s SHA-256 (also in the exit-5 text)', going, { expect: { noWindowArg: true, exit: 5, firstLine: `check_sepolia_run.js SHA-256 ${SELF_SHA}` } });
  scenario('the first line of a full report is the checker\'s SHA-256', rows, { expect: { exit: 0, firstLine: `check_sepolia_run.js SHA-256 ${SELF_SHA}` } });
}
{
  const RES = '2026-11-11T15:10:00.000Z';
  const missed = invocation({ run: MAIN, blocks: [1, 2, 3, 5, 6, 7, 8, 9, 10] });
  missed.splice(missed.findIndex((r) => r.block === 5), 0, { kind: 'block_missed', run: MAIN, block: 4, slot: '12:00', late: true });
  analysisRun('analysis: a verdict that is not final (the planned repetition of unfit block 4 has not run) is refused with exit 2', missed, () => [], { expectExit: 2, stderrHas: 'the verdict is not final' });
  const foreign = invocation({ run: MAIN }); dataRow(foreign, 2, 'P', 3).run = '2026-11-11T00:00:00.000Z';
  analysisRun('analysis: a verdict with a failed gate is refused with exit 2, and accepted with --accept-gate-failures (the gate line shows)', foreign, () => [], { expectExit: 2, stderrHas: 'failed gate' });
  const dirty = invocation({ run: MAIN }); dirty[0].commit = '73b4cca16e7c-dirty';
  analysisRun('analysis: a dirty-commit gate failure is refused with exit 2', dirty, () => [], { expectExit: 2, stderrHas: 'failed gate' });
  analysisRun('analysis: --accept-gate-failures cannot override a dirty commit', dirty, () => [], { expectExit: 2, flags: ['--accept-gate-failures'], stderrHas: 'fatal failed gate' });
  analysisRun('analysis: even with --accept-gate-failures, counts that differ from the verdict (a foreign run id) are refused', foreign, () => [], { expectExit: 2, flags: ['--accept-gate-failures'], stderrHas: 'fatal failed gate' });
  const nofoot = invocation({ run: MAIN }); nofoot.pop();
  analysisRun('analysis: an invocation without a footer is refused with exit 2', nofoot, () => [], { expectExit: 2, stderrHas: 'no footer' });
  // exactly 5 and exactly 4 usable rows: the cluster rule; valid:false and sane:false rows with a finite time; drift and rows over 10 s
  const lostRows = (rows, block, mode, its) => { for (const it of its) { const r = dataRow(rows, block, mode, it); r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; } };
  const five = invocation({ run: MAIN });
  lostRows(five, 3, 'S', [3, 4, 5, 6, 7]); // exactly 5 usable S rows: it enters the range between blocks
  dataRow(five, 2, 'P', 6).valid = false; dataRow(five, 2, 'P', 7).valid = false; // not valid, a finite time, no error code
  dataRow(five, 4, 'S', 8).sane = false;
  dataRow(five, 6, 'C', 9).total_ms = 12000; // a row over 10 s stays in
  dataRow(five, 8, 'Bt', 4).error = 'TIMEOUT'; // an error code on a row with a finite time and sane reads: not usable
  const fiveRep = invocation({ run: RES, reserveBlock: 2, at: '20:40' }); // block 2 is not unfit (8 usable P rows), so no substitution; the plan names block 2 first (lowest failed)
  analysisRun('analysis: exactly 5 usable S rows enter the range between blocks; valid:false and sane:false rows are counted as not usable without an error code; a row over 10 s is counted', [...five], (sum, text) => {
    const bad = [];
    const x = sum.results.primary.modes;
    if (x.S.between_blocks.clusters !== 10 || x.S.between_blocks.small_clusters !== 0) bad.push(`S between ${x.S.between_blocks.clusters}, small ${x.S.between_blocks.small_clusters}`);
    if (x.P.not_usable_without_error_code !== 2 || x.S.not_usable_without_error_code !== 1 || x.P.usable !== 98) bad.push(`P not usable ${x.P.not_usable_without_error_code}, S ${x.S.not_usable_without_error_code}`);
    if (x.C.rows_over_10s !== 1) bad.push(`C rows over 10 s ${x.C.rows_over_10s}`);
    if (sum.results.primary.drift.of_block_mode_pairs !== 40) bad.push(`drift pairs ${sum.results.primary.drift.of_block_mode_pairs}, expected 40 (10 blocks x 4 modes)`);
    if (x.Bt.usable !== 99 || x.Bt.attempted !== 100) bad.push(`Bt usable ${x.Bt.usable} of ${x.Bt.attempted}: an error code makes a row not usable`);
    if (!/not usable without an error code[^;]*: 2;/.test(text)) bad.push('the printed table lacks the not-usable count');
    return bad;
  });
  void fiveRep;
  const four = invocation({ run: MAIN });
  lostRows(four, 3, 'S', [3, 4, 5, 6, 7, 8]);
  const fourShort = invocation({ run: RES, reserveBlock: 3, at: '20:40' }); lostRows(fourShort, 3, 'S', [3, 4, 5, 6, 7, 8]);
  analysisRun('analysis: exactly 4 usable S rows keep the block out of the range between blocks and list it by name', [...four, ...fourShort], (sum, text) => {
    const bad = [];
    const b = sum.results.primary.modes.S.between_blocks;
    if (b.clusters !== 9 || b.small_clusters !== 1) bad.push(`S between ${b.clusters}, small ${b.small_clusters}`);
    if (!/block 3 of main invocation 1; their rows stay in the pooled statistics/.test(text)) bad.push('the small block is not listed by name');
    return bad;
  });
}
// 7 slots covered but 82 usable rows in every mode needed: the slot condition alone fails the day (final: both repetitions judged, short too)
{
  const rows = invocation({ run: MAIN });
  const lose = (r, b) => { for (const it of [3, 4, 5, 6, 7, 8]) { const x = dataRow(r, b, 'S', it); x.error = 'SERVER_ERROR/ECONNRESET'; x.total_ms = null; } };
  for (const b of [1, 2, 3]) lose(rows, b);
  const reps = [[1, '20:40', '2026-11-11T15:10:00.000Z'], [2, '21:20', '2026-11-11T15:50:00.000Z']].flatMap(([b, at, run]) => { const r = invocation({ run, reserveBlock: b, at }); lose(r, b); return r; });
  scenario('day rule: 7 slots covered with 82 usable S rows (80 needed) and every repetition judged: the slot condition alone fails the day', [...rows, ...reps], { expect: { exit: 1, has: ['7 of 10 slots covered (8 needed; 0 represented by a repetition)', 'P 100, S 82, C 100, Bt 100 (80 needed in each mode): THE DAY IS FAILED'], hasNot: ['NOT FINAL'] } });
}
// the verdict as JSON (--blocks-json) and the sensitivity analysis that reads it
{
  const main = invocation({ run: MAIN });
  for (const b of [2, 5]) { const r = dataRow(main, b, 'C', 4); r.error = 'HTTP_429'; r.total_ms = null; }
  scenario('--blocks-json: blocks 2 and 5 failed, block 2 repeated cleanly at 20:40', [...main, ...invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 2, at: '20:40' })], {
    expect: {
      exit: 1,
      blocksJson: (d, ctx) => {
        const bad = [];
        if (d.checker_sha256 !== SELF_SHA) bad.push('checker hash');
        if (d.log_sha256 !== require('crypto').createHash('sha256').update(fs.readFileSync(ctx.log)).digest('hex')) bad.push('log_sha256');
        if (JSON.stringify(d.unfit_main_blocks) !== '[]') bad.push(`unfit_main_blocks ${JSON.stringify(d.unfit_main_blocks)}`);
        if (d.day_rule.final !== true || JSON.stringify(d.day_rule.pending) !== '[]' || d.gate_failures !== 1 && d.gate_failures !== 0) bad.push(`day_rule final ${d.day_rule.final}, pending ${JSON.stringify(d.day_rule.pending)}, gate_failures ${d.gate_failures}`);
        if (d.no_monitor !== false || !Array.isArray(d.monitor_files) || d.monitor_files.length !== 1) bad.push('monitor_files or no_monitor');
        if (!d.day_rule || d.day_rule.stands !== true || d.day_rule.covered_slots !== 10 || d.day_rule.slot_clusters.length !== 10 || d.day_rule.slot_clusters.some((c) => c.used !== 'main' || c.run !== MAIN || c.covered !== true)) bad.push(`day_rule ${JSON.stringify(d.day_rule).slice(0, 160)}`);
        else if (JSON.stringify(d.day_rule.primary_usable_rows) !== '{"P":100,"S":100,"C":98,"Bt":100}') bad.push(`primary_usable_rows ${JSON.stringify(d.day_rule.primary_usable_rows)}`);
        if (JSON.stringify(d.failed_main_blocks) !== '[2,5]') bad.push(`failed_main_blocks ${JSON.stringify(d.failed_main_blocks)}`);
        if (JSON.stringify(d.plan) !== '{"20:40":2,"21:20":5}') bad.push(`plan ${JSON.stringify(d.plan)}`);
        if (!/^s\d+\.jsonl$/.test(d.log) || d.date !== '2026-11-11' || d.rehearsal !== false) bad.push('log, date or rehearsal field');
        if (d.invocations.length !== 2) { bad.push(`${d.invocations.length} invocations`); return bad; }
        const [m, rsv] = d.invocations;
        if (m.kind !== 'main' || m.run !== MAIN || m.only_block !== null || m.reserve_slot !== null || m.footer !== true) bad.push('main invocation fields');
        const st = m.blocks.map((b) => `${b.block}:${b.status}`).join(',');
        if (st !== '1:clean,2:failed,3:clean,4:clean,5:failed,6:clean,7:clean,8:clean,9:clean,10:clean') bad.push(`main statuses ${st}`);
        if (!m.blocks[1].reasons.includes('ERROR:HTTP_429') || !m.blocks[1].reasons.includes('HTTP_429')) bad.push(`block 2 reasons ${JSON.stringify(m.blocks[1].reasons)}`);
        if (rsv.kind !== 'reserve' || rsv.only_block !== 2 || rsv.reserve_slot !== '20:40' || rsv.blocks.length !== 1 || rsv.blocks[0].status !== 'clean') bad.push('reserve invocation fields');
        if (m.blocks[0].started_at === null || m.blocks[0].rows !== 50) bad.push(`block 1 started_at ${m.blocks[0].started_at}, rows ${m.blocks[0].rows}`);
        if (m.blocks[1].usable.C !== 9 || m.blocks[1].usable.P !== 10 || m.blocks[1].short !== false) bad.push(`block 2 usable ${JSON.stringify(m.blocks[1].usable)}, short ${m.blocks[1].short}`);
        if (m.blocks.some((b) => 'cold_ms' in b || 'est_cu_per_s' in b)) bad.push('latency values in the verdict JSON');
        return bad;
      },
    },
  });
  scenario('--blocks-json without a file name is a usage error', invocation({ run: MAIN }), { expect: { exit: 2, extraArgs: ['--blocks-json'] } });
}
// analysis_primary.js: the primary dataset, S1 to S3, the cluster rule, the paired difference, the agreement test, the checks on its input
function analysisRun(name, rows, check, { tamper = null, ticks = null, expectExit = 0, flags = [], stderrHas = null, acceptClock = true, waiveMonitor = false, checkerArgs = [], now = '2026-11-11T14:35:00Z' } = {}) {
  n += 1;
  const log = path.join(scratch, `s${n}.jsonl`);
  const verdictFile = path.join(scratch, `s${n}.verdict.json`);
  const outFile = path.join(scratch, `s${n}.summary.json`);
  fs.writeFileSync(log, `${rows.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join('\n')}\n`);
  const args = [checker, '--root', root, '--env', envFile, '--deployment', recordFile, '--log', log, '--date', '2026-11-11', '--in-progress-window', '0', '--blocks-json', verdictFile, '--now', now];
  if (!ticks && !waiveMonitor) ticks = fixtureMonitor(rows);
  if (ticks) { const mf = path.join(scratch, `s${n}.monitor.jsonl`); fs.writeFileSync(mf, `${ticks.map((t) => JSON.stringify(t)).join('\n')}\n`); args.push('--monitor', mf); } else args.push('--no-monitor');
  const c = cp.spawnSync(process.execPath, [...args, ...checkerArgs], { encoding: 'utf8' });
  if (tamper === 'log') fs.appendFileSync(log, `${JSON.stringify({ kind: 'note' })}\n`);
  if (tamper === 'name') { const v = JSON.parse(fs.readFileSync(verdictFile, 'utf8')); v.log = 'another_log.jsonl'; fs.writeFileSync(verdictFile, JSON.stringify(v)); }
  if (tamper === 'verdictjunk') fs.writeFileSync(verdictFile, 'SEPOLIA_RPC_URL=JUNKMARKER-not-json');
  if (tamper === 'nofields') { const v = JSON.parse(fs.readFileSync(verdictFile, 'utf8')); delete v.expect_overrides; delete v.clock_override; fs.writeFileSync(verdictFile, JSON.stringify(v)); }
  if (tamper === 'counts') {
    const verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
    verdict.day_rule.primary_usable_rows.P += 1;
    fs.writeFileSync(verdictFile, JSON.stringify(verdict));
  }
  const s = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'analysis_primary.js'), '--root', root, '--log', log, '--verdict', verdictFile, '--out', outFile, ...(acceptClock ? ['--accept-clock-override'] : []), ...flags], { encoding: 'utf8' });
  const problems = [];
  if (expectExit === 2 && /\n\s+at /.test(s.stderr || '')) problems.push('a refusal printed a stack');
  if (stderrHas && !(s.stderr || '').includes(stderrHas)) problems.push(`stderr lacks "${stderrHas}"`);
  if (!fs.existsSync(verdictFile)) problems.push(`no verdict file (checker exit ${c.status})`);
  else if (s.status !== expectExit) problems.push(`analysis exit ${s.status}, expected ${expectExit}: ${(s.stderr || '').slice(0, 200)}`);
  else if (expectExit === 0) {
    const sum = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    try { for (const msg of check(sum, s.stdout)) problems.push(msg); } catch (e) { problems.push(`check threw: ${e.message}`); }
  }
  for (const p of urlParts) if (`${s.stdout}${s.stderr}`.includes(p)) problems.push('A URL PART IN THE OUTPUT');
  if (tamper === 'verdictjunk' && `${s.stdout}${s.stderr}`.includes('JUNKMARKER')) problems.push('the text of the bad verdict file was echoed');
  if (problems.length) failed += 1;
  console.log(`${problems.length ? 'WRONG' : 'right'}  ${String(n).padStart(2)}. ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  if (problems.length && process.env.R2_MUTATION_FAIL_FAST === '1') process.exit(1);
}
{
  const RES = '2026-11-11T15:10:00.000Z';
  const med = (xs) => { const x = [...xs].sort((a, b) => a - b); const k = x.length; return k % 2 ? x[(k - 1) / 2] : (x[k / 2 - 1] + x[k / 2]) / 2; };
  const usableRows = (rows, block, mode) => rows.filter((r) => r.kind === 'sepolia' && r.block === block && r.mode === mode && r.warmup === false && !r.error && Number.isFinite(r.total_ms) && (mode === 'P' ? r.valid === true : r.sane === true));
  const scaleBlock = (rows, block, factor) => { for (const r of rows) if (r.kind === 'sepolia' && r.block === block && r.mode !== 'cold') { if (Number.isFinite(r.total_ms)) r.total_ms *= factor; if (Number.isFinite(r.b0_ms)) r.b0_ms *= factor; } };
  const close = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
  const lost = (rows, block, mode, iterations) => { for (const it of iterations) { const r = dataRow(rows, block, mode, it); r.error = 'SERVER_ERROR/ECONNRESET'; r.total_ms = null; } };

  {
    const rows = invocation({ run: MAIN });
    for (let b = 1; b <= 10; b++) scaleBlock(rows, b, 1 + 0.05 * b);
    analysisRun('analysis: a clean day: the primary range between blocks is ranks 2 and 9 of the ten block medians; S1, S2 and S3 equal the primary and agree', rows, (sum) => {
      const bad = [];
      for (const m of ['P', 'S', 'C', 'Bt']) {
        const medians = Array.from({ length: 10 }, (_, i) => med(usableRows(rows, i + 1, m).map((r) => r.total_ms))).sort((a, b) => a - b);
        const x = sum.results.primary.modes[m];
        const bb = x.between_blocks;
        if (bb.clusters !== 10 || !bb.interval) { bad.push(`${m}: ${bb.clusters} clusters`); continue; }
        if (!close(bb.interval.lower, medians[1]) || !close(bb.interval.upper, medians[8]) || JSON.stringify(bb.interval.ranks) !== '[2,9]') bad.push(`${m}: range ${bb.interval.lower}-${bb.interval.upper} ranks ${bb.interval.ranks}, expected ${medians[1]}-${medians[8]} ranks 2,9`);
        const all = []; for (let b = 1; b <= 10; b++) all.push(...usableRows(rows, b, m).map((r) => r.total_ms));
        if (x.usable !== 100 || x.attempted !== 100 || !close(x.median, med(all))) bad.push(`${m}: usable ${x.usable}, attempted ${x.attempted}, pooled median ${x.median} vs ${med(all)}`);
        for (const k of ['S1', 'S2', 'S3']) { if (sum.results[k].modes[m].usable !== 100) bad.push(`${k} ${m}: usable ${sum.results[k].modes[m].usable}`); if (sum.agreement[k][m] !== true) bad.push(`${k} ${m}: agreement ${sum.agreement[k][m]}`); }
      }
      return bad;
    });
  }
  {
    const main = invocation({ run: MAIN });
    lost(main, 3, 'S', [5]);
    const rep = invocation({ run: RES, reserveBlock: 3, at: '20:40' });
    scaleBlock(rep, 3, 3);
    analysisRun('analysis: block 3 failed (one S error row) and was repeated cleanly: the primary keeps the main block (S 99 of 100), S1 adds the repetition (S 109, 11 blocks), S2 replaces the block by it (S 100); S1 does not agree', [...main, ...rep], (sum) => {
      const bad = [];
      const pr = sum.results.primary; const s1 = sum.results.S1; const s2 = sum.results.S2;
      if (pr.clusters !== 10 || pr.modes.S.usable !== 99 || pr.modes.S.attempted !== 100 || JSON.stringify(pr.modes.S.error_rows) !== '{"SERVER_ERROR/ECONNRESET":1}') bad.push(`primary ${pr.clusters} blocks, S ${pr.modes.S.usable}/${pr.modes.S.attempted}, errors ${JSON.stringify(pr.modes.S.error_rows)}`);
      if (s1.clusters !== 11 || s1.modes.S.usable !== 109 || s1.modes.P.usable !== 110) bad.push(`S1 ${s1.clusters} blocks, S ${s1.modes.S.usable}, P ${s1.modes.P.usable}`);
      if (s2.clusters !== 10 || s2.modes.S.usable !== 100 || s2.modes.P.usable !== 100) bad.push(`S2 ${s2.clusters} blocks, S ${s2.modes.S.usable}, P ${s2.modes.P.usable}`);
      if (!pr.cold_start || pr.cold_start.n !== 10 || !s1.cold_start || s1.cold_start.n !== 11 || !s2.cold_start || s2.cold_start.n !== 10) bad.push('cold start n');
      if (!pr.cache_check || pr.cache_check.n !== 10 || s1.cache_check.n !== 11) bad.push('cache check n');
      if (sum.agreement.S1.P !== null) bad.push(`S1 P agreement ${sum.agreement.S1.P}, expected null (ten identical blocks: a degenerate range)`);
      return bad;
    });
  }
  {
    const main = invocation({ run: MAIN, blocks: [1, 2, 3, 5, 6, 7, 8, 9, 10] });
    main.splice(main.findIndex((r) => r.block === 5), 0, { kind: 'block_missed', run: MAIN, block: 4, slot: '12:00', late: true });
    const rep = invocation({ run: RES, reserveBlock: 4, at: '20:40' });
    analysisRun('analysis: block 4 missed and repeated cleanly: the repetition stands for slot 4 in the primary (10 blocks, 100 usable rows each)', [...main, ...rep], (sum) => {
      const bad = [];
      const c4 = sum.day_rule.slot_clusters[3];
      if (c4.block !== 4 || c4.used !== 'reserve' || c4.run !== RES) bad.push(`slot 4 cluster ${JSON.stringify(c4)}`);
      for (const k of ['primary', 'S1', 'S2']) if (sum.results[k].clusters !== 10 || ['P', 'S', 'C', 'Bt'].some((m) => sum.results[k].modes[m].usable !== 100)) bad.push(`${k}: ${sum.results[k].clusters} blocks, rows ${JSON.stringify(['P', 'S', 'C', 'Bt'].map((m) => sum.results[k].modes[m].usable))}`);
      return bad;
    });
  }
  {
    const rows = invocation({ run: MAIN });
    lost(rows, 3, 'S', [3, 4, 5, 6, 7, 8]); // block 3 keeps 4 usable S rows: short; its repetition at 20:40 is short too, so it does not stand for it
    const shortRep = invocation({ run: RES, reserveBlock: 3, at: '20:40' });
    lost(shortRep, 3, 'S', [3, 4, 5, 6, 7, 8]);
    analysisRun('analysis: a block with 4 usable S rows stays in the pooled S statistics (94 rows) but not in the range between blocks (9 blocks)', [...rows, ...shortRep], (sum) => {
      const bad = [];
      const x = sum.results.primary.modes.S;
      if (x.usable !== 94 || x.attempted !== 100 || x.between_blocks.clusters !== 9 || x.between_blocks.small_clusters !== 1) bad.push(`S usable ${x.usable}, attempted ${x.attempted}, between ${x.between_blocks.clusters} blocks, small ${x.between_blocks.small_clusters}`);
      if (sum.results.primary.modes.P.between_blocks.clusters !== 10) bad.push('P between-block clusters');
      return bad;
    });
  }
  {
    const rows = invocation({ run: MAIN });
    for (let b = 1; b <= 10; b++) scaleBlock(rows, b, 1 + 0.03 * b);
    analysisRun('analysis: the paired quantities (S/C, S/Bt, P - B0 - S) equal independent computations over their 100 pairs', rows, (sum) => {
      const bad = [];
      const want = { 'S/C': [], 'S/Bt': [], 'P-B0-S': [] };
      for (let b = 1; b <= 10; b++) {
        for (let it = 3; it <= 12; it++) {
          const p = dataRow(rows, b, 'P', it); const sv = dataRow(rows, b, 'S', it); const c = dataRow(rows, b, 'C', it); const bt = dataRow(rows, b, 'Bt', it);
          want['S/C'].push(sv.total_ms / c.total_ms); want['S/Bt'].push(sv.total_ms / bt.total_ms); want['P-B0-S'].push((p.total_ms - p.b0_ms) - sv.total_ms);
        }
      }
      for (const k of Object.keys(want)) {
        const x = sum.results.primary.paired[k];
        if (!x || x.n !== 100 || !close(x.median, med(want[k]))) bad.push(`${k}: n ${x && x.n}, median ${x && x.median}, expected ${med(want[k])}`);
        else if (x.between.clusters !== 10) bad.push(`${k}: ${x.between.clusters} blocks in the range`);
      }
      return bad;
    });
  }
  {
    const rows = invocation({ run: MAIN });
    for (const [b, it] of [[2, 4], [5, 6], [8, 9]]) dataRow(rows, b, 'C', it).newSocketsDuringTimer = 1;
    const expectC = rows.filter((r) => r.kind === 'sepolia' && r.mode === 'C' && r.warmup === false && r.sane === true && !(r.newSocketsDuringTimer > 0)).length;
    analysisRun('analysis: S3 leaves out the timed rows whose timer opened a new connection (C 97 or fewer), the other datasets keep them', rows, (sum) => {
      const bad = [];
      if (sum.results.primary.modes.C.usable !== 100 || sum.results.S3.modes.C.usable !== expectC || expectC > 97) bad.push(`C usable: primary ${sum.results.primary.modes.C.usable}, S3 ${sum.results.S3.modes.C.usable}, expected ${expectC}`);
      if (sum.results.S3.modes.P.usable !== sum.results.primary.modes.P.usable - rows.filter((r) => r.kind === 'sepolia' && r.mode === 'P' && r.warmup === false && r.newSocketsDuringTimer > 0).length) bad.push('S3 P usable');
      return bad;
    });
  }
  {
    const rows = invocation({ run: MAIN });
    const t = monitor({ restartAt: '10:40' });
    analysisRun('analysis: monitor notes are printed before any latency value', rows, (sum, text) => {
      const bad = [];
      const iNote = text.indexOf('Windows restart pending (note only)');
      const iFirstValue = text.indexOf('== primary analysis');
      if (iNote < 0 || iFirstValue < 0 || iNote > iFirstValue) bad.push(`note at ${iNote}, primary section at ${iFirstValue}`);
      if (text.indexOf('== monitor notes') > text.indexOf('== rows:')) bad.push('notes section after the rows section');
      return bad;
    }, { ticks: t });
  }
  {
    const rows = invocation({ run: MAIN });
    analysisRun('analysis: a log changed after the verdict (another SHA-256) is refused with exit 2', rows, () => [], { tamper: 'log', expectExit: 2 });
    analysisRun('analysis: a verdict made for another log name is refused with exit 2', rows, () => [], { tamper: 'name', expectExit: 2 });
  }
}
// Review 21: reserve terminal states, with a fixed clock independent of the host date.
{
  const main = invocation({ run: MAIN, blocks: [1, 2, 3, 4, 5, 6, 7, 8] });
  const verify = (final, closed, states) => (d) => {
    const bad = [];
    if (d.day_rule.final !== final) bad.push('final');
    if (JSON.stringify(d.closed_slots.map(q => q.slot)) !== JSON.stringify(closed)) bad.push('closed slots');
    if (JSON.stringify(d.day_rule.reserve_states.map(q => q.state)) !== JSON.stringify(states)) bad.push('terminal states');
    if (d.day_rule.primary_usable_rows.S !== 80) bad.push('closed slots invented rows');
    return bad;
  };
  scenario('closure: exact first deadline stays pending', main, { expect: { exit: 1, now: '2026-11-11T15:12:00Z', blocksJson: verify(false, [], ['pending', 'pending']) } });
  scenario('closure: missed first reserve closes strictly after its deadline; second pending', main, { expect: { exit: 1, now: '2026-11-11T15:12:00.001Z', blocksJson: verify(false, ['20:40'], ['closed unused', 'pending']), has: ['day rule closed slots: 20:40'] } });
  scenario('closure: both unused reserves close, final day at eight/eighty', main, { expect: { exit: 1, now: '2026-11-11T15:52:00.001Z', blocksJson: verify(true, ['20:40', '21:20'], ['closed unused', 'closed unused']), has: ['THE DAY STANDS'] } });
  const aborted = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 9, at: '20:40', blocks: [] }).filter(r => r.kind === 'header'); // header only, no rows or footer
  scenario('closure: aborted first reserve is judged and forfeited second closes', [...main, ...aborted], { expect: { exit: 1, now: '2026-11-11T15:52:01Z', blocksJson: verify(true, ['21:20'], ['aborted', 'closed unused']), has: ['THE DAY STANDS', 'FAIL footer present'] } });
  scenario('closure: closed slot has no executable plan', main, { expect: { exit: 4, now: '2026-11-11T15:52:01Z', planSlot: '21:20', stdout: 'PLAN 21:20 none' } });
  for (const now of ['bad', '', '2026-11-11', '2026-11-11T15:52:01']) scenario('closure: invalid --now ' + JSON.stringify(now), main, { expect: { exit: 2, now } });
}
{
  const rows = invocation({ run: MAIN });
  const inspect = (state, unfit, covered) => d => {
    const b = d.invocations[0].blocks[2];
    return b.network_state === state && b.unfit === unfit && d.day_rule.covered_slots === covered ? [] : ['network state/fitness/coverage'];
  };
  for (const field of ['net', 'saltId']) for (const value of [undefined, '', null, 23]) {
    const ticks = monitor(); ticks[0][field] = value;
    scenario('tri-state: first invalid tick followed by valid baseline ' + field + '=' + value, rows, { ticks, expect: { exit: 0, blocksJson: inspect('SAME', false, 10) } });
    const middle = monitor(); middle.find(t => t.t === new Date(slotMs('10:40')).toISOString())[field] = value;
    scenario('tri-state: single invalid in-window tick leaves SAME ' + field + '=' + value, rows, { ticks: middle, expect: { exit: 0, blocksJson: inspect('SAME', false, 10) } });
  }
  scenario('tri-state: same profile is fit', rows, { ticks: monitor(), expect: { exit: 0, blocksJson: inspect('SAME', false, 10) } });
  scenario('tri-state: different profile is unfit', rows, { ticks: monitor({ netBlipAt: '10:40' }), expect: { exit: 1, blocksJson: inspect('DIFFERENT', true, 9) } });
  const ticks = monitor({ netBlipAt: '10:40' });
  ticks.find(t => t.t === new Date(slotMs('10:41')).toISOString()).net = '';
  scenario('tri-state: observed DIFFERENT is not erased by UNKNOWN', rows, { ticks, expect: { exit: 1, blocksJson: inspect('DIFFERENT', true, 9) } });
}
{
  const rows = invocation({ run: MAIN });
  for (const absent of ['empty', 'missing']) scenario('tri-state: ' + absent + ' monitor cannot preserve coverage', rows, {
    ticks: absent === 'empty' ? [] : null,
    expect: { exit: 1, monitorFile: absent === 'missing' ? 'missing' : undefined, blocksJson: d =>
      d.day_rule.covered_slots === 0 && d.invocations[0].blocks.every(b => b.unfit && b.network_state === 'UNKNOWN') ? [] : ['unknown monitor preserved coverage'] }
  });
}
{
  const main = invocation({ run: MAIN });
  const ticks = monitor({ netChangeAt: '18:00' });
  scenario('primary: two unreplaced DIFFERENT blocks are excluded, eight slots/eighty rows stand', main, { ticks, expect: {
    exit: 1, now: '2026-11-11T15:55:00Z', blocksJson: d => {
      const bad = [];
      if (d.day_rule.stands !== true || d.day_rule.primary_usable_rows.P !== 80) bad.push('day totals');
      if (JSON.stringify(d.day_rule.slot_clusters.filter(c => c.excluded).map(c => c.block)) !== '[9,10]') bad.push('excluded identities');
      return bad;
    }
  } });
  analysisRun('primary: off-network exclusion is honoured by analysis; S1 retains evidence', main, sum =>
    sum.results.primary.modes.P.usable === 80 && sum.results.S1.modes.P.usable === 100 && sum.results.primary.clusters === 8 ? [] : ['exclusion counts'],
    { ticks, now: '2026-11-11T15:55:00Z' });
  const rep = invocation({ run: '2026-11-11T15:10:00.000Z', reserveBlock: 9, at: '20:40' });
  const repairedTicks = monitor({ netChangeAt: '18:00', reserveWrapper: true });
  analysisRun('primary: fit reserve replaces DIFFERENT block, other DIFFERENT block stays excluded', [...main, ...rep], sum => {
    const c = sum.day_rule.slot_clusters;
    return c[8].used === 'reserve' && c[8].excluded === false && c[9].excluded === true && sum.results.primary.modes.P.usable === 90 ? [] : ['repair exclusion'];
  }, { ticks: repairedTicks, now: '2026-11-11T15:55:00Z' });
}
{
  const mutations = [
    ['CONFIG_SCRIPT_LABEL', r => { r[0].script = 'other.js'; }],
    ['CONFIG_SCRIPT_LABEL', r => { r[0].label = 'pilot'; }],
    ['CONFIG_CHAIN', r => { r[0].chainId = 1; }],
    ['CONFIG_COMMIT', r => { r[0].commit += '-dirty'; }],
    ['CONFIG_BLOCK_LAG', r => { r[0].blockLag = 1; }],
    ['CONFIG_ITERATIONS', r => { r[0].warmup = 3; }],
    ['CONFIG_ITERATIONS', r => { r[0].timed = 9; }],
    ['CONFIG_CONTRACT', r => { r[0].contract = 'different'; }],
    ['CONFIG_CREDENTIAL', r => { r[0].credentialB = 'different'; }],
    ['CONFIG_DEPLOYER_START', r => { r[0].deployer = 'different'; }],
    ['CONFIG_DEPLOYER_START', r => { r[0].deployerNonceStart += 1; }],
    ['CONFIG_DEPLOYER_END', r => { r[r.length - 1].nonceUnchanged = false; }],
    ['CONFIG_DEPLOYER_END', r => { r[r.length - 1].deployerNonceEnd += 1; }],
    ['CONFIG_PROVIDER', r => { r[0].provider = 'different'; }],
    ['CONFIG_NODE', r => { r[0].node = 'v0.0.0'; }],
    ['CONFIG_ETHERS', r => { r[0].ethers = 'ethers/0.0.0'; }],
    ['CONFIG_TIMEZONE', r => { r[0].timezoneOffsetMinutes = 0; }],
    ['CONFIG_AGENTS', r => { r[0].agents.keepAlive = false; }],
    ['CONFIG_AGENTS', r => { r[0].agents.scheduling = 'lifo'; }],
    ['CONFIG_TIMEOUT', r => { r[0].requestTimeoutMs = 1; }],
    ['CONFIG_SLOTS', r => { r[0].slots = []; }],
    ['PILOT_ROWS', r => { r.splice(r.length - 1, 0, { kind: 'note', run: MAIN, pilot: true }); }],
    ['FOREIGN_RUN_IDS', r => { r.splice(r.length - 1, 0, { kind: 'note', run: 'foreign' }); }],
  ];
  for (const [id, change] of mutations) {
    const rows = invocation({ run: MAIN }); change(rows);
    scenario('fatal gate overrides sufficient data: ' + id, rows, { expect: { exit: 1, has: ['THE DAY IS FAILED'], blocksJson: d =>
      d.fatal_gate_failures > 0 && d.day_rule.stands === false && d.day_rule.data_sufficient === true && d.gates.some(g => g.id === id && !g.ok && g.fatal) ? [] : ['fatal gate classification or precedence']
    } });
    analysisRun('fatal gate cannot be accepted: ' + id, rows, () => [], { flags: ['--accept-gate-failures'], expectExit: 2, stderrHas: 'fatal failed gate' });
  }
  const nofoot = invocation({ run: MAIN }); nofoot.pop();
  analysisRun('reviewable missing footer can be accepted and is recorded', nofoot, (sum, text) =>
    sum.accepted_gate_failures === true && text.includes('ACCEPTED with --accept-gate-failures') ? [] : ['acceptance not recorded'],
    { flags: ['--accept-gate-failures'] });
}
{
  const rows = invocation({ run: MAIN });
  for (const [mode, its] of [['S', [3,4,5]], ['C', [6,7,8]]]) for (const it of its) {
    const r = dataRow(rows,3,mode,it); r.error = 'TEST_ERROR'; r.total_ms = null;
  }
  analysisRun('paired report: four common pairs are listed; sensitivity errors and independence label print', rows, (sum,text) => {
    const bad=[];
    if (sum.results.primary.paired['S/C'].between.small_clusters !== 1) bad.push('paired small count');
    if (!text.includes('paired clusters below five: 1 (block 3 of main invocation 1')) bad.push('paired small list');
    if (!text.includes('pairs taken as independent; seed')) bad.push('independence label');
    if ((text.match(/S error rows: TEST_ERROR x3/g)||[]).length !== 2) bad.push('S1 and S3 errors');
    return bad;
  });
}
{
  const rows = invocation({ run: MAIN });
  for (const r of rows) if (r.kind === 'sepolia' && r.mode === 'P') r.total_ms = 100;
  analysisRun('containment: equal endpoints are indeterminate even for identical datasets', rows, (sum,text) =>
    ['S1','S2','S3'].every(k => sum.agreement[k].P === null) && text.includes('descriptive containment: indeterminate') && text.includes('containment is not equivalence') ? [] : ['degenerate containment']);
  for (const keepHigh of [true,false]) {
    const r = invocation({ run: MAIN });
    for (const x of r) if (x.kind === 'sepolia' && x.mode === 'P') x.total_ms = x.block*10;
    for(let b=1;b<=10;b++) if (keepHigh ? b<=8 : b>=3) dataRow(r,b,'S',1).error='TEST_ERROR';
    analysisRun('containment: S2 outside ' + (keepHigh?'upper':'lower') + ' primary bound',r,sum =>
      sum.agreement.S2.P === false && sum.agreement.S1.P === true ? [] : ['containment bounds']);
  }
  const none = invocation({run:MAIN});
  for(const r of none) if(r.kind==='sepolia' && ['P','S','C','Bt'].includes(r.mode)) {r.error='TEST_ERROR';r.total_ms=null;}
  analysisRun('containment: no primary range is indeterminate',none,sum =>
    ['S1','S2','S3'].every(k=>sum.agreement[k].P===null) ? [] : ['no-range containment'],
    {now:'2026-11-11T15:55:00Z'});
}
{
  for(const date of ['2026-11-12','2026-11-13']){
    const rows=JSON.parse(JSON.stringify(invocation({run:MAIN,blocks:[1,2,3,4,5,6,7]})).replaceAll('2026-11-11',date));
    scenario('run date '+date+': failed-day action honours the two-day cap',rows,{expect:{
      exit:1,date,now:date+'T16:00:00Z',
      has:[date==='2026-11-12'?'run 13 Nov once, in full':'no third day; no headline'],
      hasNot:['run 14 Nov']
    }});
  }
  const clean=JSON.parse(JSON.stringify(invocation({run:MAIN})).replaceAll('2026-11-11','2026-11-12'));
  scenario('default operational date is 12 Nov without --date',clean,{expect:{
    exit:0,noDateArg:true,now:'2026-11-12T14:35:00Z',has:['THE DAY STANDS']
  }});
}
{
  const rows = invocation({ run: MAIN });
  dataRow(rows, 3, 'S', 5).error = 'SYNTHETIC:' + urlPart;
  analysisRun('analysis refuses a failed self-scan even with acceptance', rows, () => [], {
    flags: ['--accept-gate-failures'], expectExit: 2, stderrHas: 'log self-scan did not pass'
  });
  const pending = invocation({ run: MAIN, blocks: [1,2,3,4,5,6,7,8] });
  pending[0].node = 'v0.0.0';
  scenario('fatal gate records failure while pending slots keep the verdict provisional', pending, { expect: {
    exit: 1, has: ['NOT FINAL'], hasNot: ['THE DAY IS FAILED'], blocksJson: d =>
      d.day_rule.stands === false && d.day_rule.final === false ? [] : ['fatal provisional status']
  }});
}
analysisRun('analysis refuses inconsistent primary row counts in a clean verdict', invocation({ run: MAIN }), () => [], {
  tamper: 'counts', expectExit: 2, stderrHas: 'the log and the verdict disagree'
});
// Loop 3: the actual reserve plan is authoritative for closure, coverage and the fatal gate.
{
  const main = invocation({ run: MAIN, blocks: [4,5,6,7,8,9,10] });
  const reserve = (block, at, run = '2026-11-11T15:09:00Z') => invocation({ run, reserveBlock: block, at });
  const wrong = [...main, ...reserve(2, '20:40')];
  for (const closed of [false, true]) {
    scenario('wrong-slot reserve cannot credit coverage (' + (closed ? 'closed' : 'open') + ')', wrong, {
      expect: { exit: 1, now: closed ? '2026-11-11T15:52:01Z' : '2026-11-11T15:12:00Z',
        blocksJson: d => {
          const r = d.day_rule;
          const ok = r.final === closed && r.stands === false && r.covered_slots === 7 &&
            r.primary_usable_rows.P === 70 && r.slot_clusters[1].used === 'main' &&
            r.reserve_states.every(q => q.state === (closed ? 'closed unused' : 'pending')) &&
            d.invocations[1].matches_plan === false && d.gates.some(g => g.id === 'RESERVE_PLAN' && g.fatal && !g.ok);
          return ok ? [] : ['wrong-slot reserve resolved or contributed to the plan'];
        }
      }
    });
  }
  const first = reserve(1, '20:40');
  const second = reserve(2, '21:20', '2026-11-11T15:49:00Z');
  const cases = [
    ['RESERVE_PLAN', wrong],
    ['RESERVE_COUNT', [...main, ...first, ...second, ...reserve(3, '21:20')]],
    ['RESERVE_SLOT_UNIQUE', [...main, ...first, ...reserve(2, '20:40', '2026-11-11T15:09:10Z')]],
    ['RESERVE_BLOCK_UNIQUE', [...main, ...first, ...reserve(1, '21:20')]],
    ['RESERVE_AFTER_MAIN', [...main, ...reserve(1, '20:40', '2026-11-11T14:00:00Z')]],
    ['MAIN_COUNT', [...invocation({ run: MAIN }), ...invocation({ run: '2026-11-11T02:00:00Z' })]]
  ];
  for (const [id, rows] of cases) {
    scenario(id + ' is fatal and defeats the day decision', rows, { expect: {
      exit: 1, now: '2026-11-11T15:55:00Z',
      blocksJson: d => d.day_rule.stands === false && d.gates.some(g => g.id === id && g.fatal && !g.ok) ? [] : ['plan deviation was not fatal']
    } });
  }
  analysisRun('wrong-slot reserve cannot be analysed with gate acceptance', wrong, () => [], {
    expectExit: 2, flags: ['--accept-gate-failures'], stderrHas: 'fatal failed gate', now: '2026-11-11T15:55:00Z'
  });
}
{
  const rows = invocation({ run: MAIN });
  const expectedNode = ['--expect-node', 'v0.0.0'];
  const override = invocation({ run: MAIN });
  override[0].node = expectedNode[1];
  scenario('non-default expectation override is recorded', override, { expect: {
    exit: 0, extraArgs: expectedNode,
    blocksJson: d => JSON.stringify(d.expect_overrides) === '["--expect-node"]' ? [] : ['missing override']
  } });
  scenario('explicit built-in expectation is not an override', rows, { expect: {
    exit: 0, extraArgs: ['--expect-node', 'v22.10.0'],
    blocksJson: d => Array.isArray(d.expect_overrides) && !d.expect_overrides.length ? [] : ['default treated as override']
  } });
  analysisRun('analysis refuses an expectation override', override, () => [], {
    checkerArgs: expectedNode, expectExit: 2, stderrHas: 'frozen expectation overrides'
  });
  analysisRun('analysis refuses an unaccepted clock override', rows, () => [], {
    acceptClock: false, expectExit: 2, stderrHas: 'pass --accept-clock-override'
  });
  analysisRun('analysis: a verdict file that is not JSON is refused and its text is not echoed', rows, () => [], {
    tamper: 'verdictjunk', expectExit: 2, stderrHas: 'not valid JSON'
  });
  analysisRun('analysis: a verdict without expect_overrides and clock_override is refused (no silent pass)', rows, () => [], {
    tamper: 'nofields', expectExit: 2, stderrHas: 'lacks expect_overrides or clock_override'
  });
  scenario('a --now override is announced on the second output line', rows, { expect: {
    exit: 0, has: ['CLOCK OVERRIDE: --now 2026-11-11T14:35:00Z']
  } });
  analysisRun('analysis requires explicit acceptance for monitor waiver', rows, () => [], {
    waiveMonitor: true, expectExit: 2, stderrHas: 'failed gate'
  });
  analysisRun('analysis records monitor waiver acceptance', rows, (sum, text) =>
    sum.accepted_gate_failures && text.includes('ACCEPTED with --accept-gate-failures') ? [] : ['waiver acceptance missing'],
    { waiveMonitor: true, flags: ['--accept-gate-failures'] });
  analysisRun('accepted malformed JSON exits 2 without a stack', [...rows, '{'], () => [], {
    flags: ['--accept-gate-failures'], expectExit: 2, stderrHas: 'log contains malformed JSON'
  });
  const cold = rows.find(r => r.block === 4 && r.coldStart);
  cold.cold_ms = null; cold.error = 'synthetic cold error';
  const timedError = dataRow(rows, 3, 'S', 4);
  timedError.error = 'HTTP_429'; timedError.total_ms = null;
  for (const r of rows) if (r.block === 3 && r.mode === 'P' && r.warmup === false) r.total_ms += 1000;
  analysisRun('analysis labels estimates, differences, clock, clusters and denominators', rows, (sum, text) => {
    const missing = ['clock_override: true (ACCEPTED with --accept-clock-override)', 'verdict evaluated_at:',
      'block | used cluster | run kind | started_at (UTC) | network_state | excluded | covered',
      'pooled median', 'median of block medians', 'S1 - primary:', 'S2 - primary:', 'S3 - primary:',
      'cold start (descriptive, 9 of 10 blocks)', '99 usable pairs of 100 attempted'].filter(t => !text.includes(t));
    if (!sum.accepted_clock_override || !sum.evaluated_at || sum.results.primary.paired['S/C'].attempted !== 100 ||
        sum.results.primary.paired['S/C'].n !== 99) missing.push('summary clock or pair denominator');
    if (!text.split('\n').some(line => line.startsWith('P: pooled median') && line.includes('median of block medians'))) missing.push('primary mode estimands');
    const x = sum.differences.P['S2'];
    const base = sum.results.primary.modes.P.median;
    const delta = sum.results.S2.modes.P.median - base;
    if (!delta || x.delta !== delta || x.percent_of_primary !== 100 * delta / base) missing.push('difference arithmetic');
    return missing;
  });
}
// rehearsal mode
scenario('rehearsal: the clean block as it is', template, { expect: { rehearsal: true, exit: 0, has: ['gate failures: 0'], hasNot: ['FAIL'] } });

console.log(`\n${n} scenarios, ${failed} wrong`);
process.exit(failed ? 1 : 0);
