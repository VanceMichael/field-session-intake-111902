import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSource } from '../source.mjs';
import { createIntakeService } from '../src/intakeService.mjs';

const source = createSource();
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const sourceOrigin = 'http://127.0.0.1:' + source.address().port;

const dataDir = await mkdtemp(join(tmpdir(), 'intake-'));
const service = await createIntakeService({ origin: sourceOrigin, dataDir });
service.listen(0, '127.0.0.1');
await once(service, 'listening');
const base = 'http://127.0.0.1:' + service.address().port;

test.after(async () => {
  service.close();
  source.close();
  await Promise.all([once(service, 'close'), once(source, 'close')]);
  await rm(dataDir, { recursive: true, force: true });
});

async function api(method, path, value) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() };
}
const get = path => api('GET', path);
const post = (path, value) => api('POST', path, value ?? {});
const setPhase = phase => fetch(sourceOrigin + '/replay/phase', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase }),
});
const sourceGet = async path => (await fetch(sourceOrigin + path)).json();

const visitRequest = JSON.parse(await readFile(new URL('../requests/example.json', import.meta.url), 'utf8'));

test('建队次并完成阶段 0 收件、归属与发放', async () => {
  const created = await post('/visits', visitRequest);
  assert.equal(created.status, 201);
  assert.equal(created.body.visit, 'V66');
  assert.equal((await post('/visits', visitRequest)).status, 409);

  const sync = await post('/visits/V66/sync');
  assert.equal(sync.status, 200);
  const { ledger, observations, venueReport } = sync.body;

  // 台账：B12 缺 9 号（离线包 E-19 待领队补传），B13 的 7 号不替 B12 补缺口
  const b12 = ledger.find(b => b.boot === 'B12');
  assert.deepEqual(b12.covered, [[7, 8]]);
  assert.deepEqual(b12.missing, [[9, 9]]);
  assert.deepEqual(b12.pendingUploads, [{ packet: 'E-19', interval: [9, 9], location: null }]);
  const e18 = b12.packets.find(p => p.packet === 'E-18');
  assert.deepEqual(e18.records, [7, 8]);
  assert.ok(e18.receipt);
  assert.equal(b12.packets.find(p => p.packet === 'E-19').receipt, null);
  assert.deepEqual(ledger.find(b => b.boot === 'B13').covered, [[7, 7]]);

  // 保存原始记录后才向现场确认已收
  const receipt = await sourceGet('/device/receipts?requestKey=' + encodeURIComponent('V66:E-18'));
  assert.equal(receipt.state, '已受理');
  assert.deepEqual(receipt.submitted.records, [7, 8]);

  const obs = Object.fromEntries(observations.map(o => [o.id, o]));
  assert.equal(obs['I4/B12/7/temp'].attribution.group, 'A');
  assert.equal(obs['I4/B12/8/cond'].attribution.group, 'A');
  assert.equal(obs['I4/B12/7/temp'].issue.group, 'A');
  assert.equal(obs['I4/B13/7/cond'].state, '缺标定退回补录');
  assert.equal(obs['I4/B13/7/cond'].valid, false);

  // 学校先领已认定的部分
  assert.equal(sync.body.issued.length, 1);
  assert.equal(sync.body.issued[0].group, 'A');
  assert.deepEqual(sync.body.issued[0].observations, ['I4/B12/7/temp', 'I4/B12/8/cond']);
  const pickup = await sourceGet('/school/pickups?requestKey=' + encodeURIComponent(sync.body.issued[0].requestKey));
  assert.equal(pickup.state, '已受理');
  assert.equal(pickup.submitted.purpose, '课后作业');

  // 场地方缺报：B 组湿地北待取原包，退回补录单独列出
  const stationB = venueReport.groups.find(g => g.group === 'B').stations.find(s => s.station === '湿地北');
  assert.equal(stationB.state, '待取原包');
  assert.deepEqual(stationB.packets, ['E-19']);
  assert.ok(stationB.notes.some(n => n.includes('缺标定')));
  const stationA = venueReport.groups.find(g => g.group === 'A').stations.find(s => s.station === '湿地西');
  assert.equal(stationA.state, '已确认');
  assert.deepEqual(venueReport.uncalibrated.map(u => u.observation), ['I4/B13/7/cond']);
});

test('重复同步不重复受理', async () => {
  const before = await get('/visits/V66/pickups');
  const sync = await post('/visits/V66/sync');
  assert.equal(sync.body.issued.length, 0);
  assert.equal(sync.body.withdrawn.length, 0);
  const after = await get('/visits/V66/pickups');
  assert.deepEqual(after.body.pickups, before.body.pickups);
});

test('阶段 1：旧包回传补缺口，更正单翻转归属并撤回通知', async () => {
  await setPhase(1);
  const sync = await post('/visits/V66/sync');
  assert.equal(sync.status, 200);

  // E-19 回传区间变宽为 [8,9]，与 E-18 重叠去重后 B12 齐 [7,9]
  const b12 = sync.body.ledger.find(b => b.boot === 'B12');
  assert.deepEqual(b12.covered, [[7, 9]]);
  assert.deepEqual(b12.missing, []);
  const e19 = b12.packets.find(p => p.packet === 'E-19');
  assert.deepEqual(e19.records, [8, 9]);
  assert.ok(e19.receipt);
  assert.deepEqual(sync.body.ledger.find(b => b.boot === 'B13').covered, [[7, 7]]);

  const obs = Object.fromEntries(sync.body.observations.map(o => [o.id, o]));
  // 更正单 H3 把交接提前到 01:11:13，I4/B12/8/cond 由 A 翻转给 B
  assert.equal(obs['I4/B12/8/cond'].attribution.group, 'B');
  assert.equal(obs['I4/B12/8/cond'].issue.group, 'B');
  assert.equal(obs['I4/B12/9/temp'].issue.group, 'B');
  // 同一原包中旧组的其他观察继续可查
  assert.equal(obs['I4/B12/7/temp'].issue.group, 'A');
  const firstPickupKey = sync.body.pickups.find(p => p.group === 'A').requestKey;
  const firstPickup = await sourceGet('/school/pickups?requestKey=' + encodeURIComponent(firstPickupKey));
  assert.equal(firstPickup.state, '已受理');
  assert.ok(firstPickup.submitted.observations.includes('I4/B12/7/temp'));

  // 撤回旧组用权并通知接手组
  assert.equal(sync.body.withdrawn.length, 1);
  assert.equal(sync.body.withdrawn[0].observation, 'I4/B12/8/cond');
  assert.equal(sync.body.withdrawn[0].from, 'A');
  const withdrawn = await sourceGet('/school/pickups?requestKey=' + encodeURIComponent(sync.body.withdrawn[0].requestKey));
  assert.equal(withdrawn.submitted.priorReceipt, sync.body.withdrawn[0].priorReceipt);
  assert.deepEqual(withdrawn.submitted.observations, ['I4/B12/8/cond']);
  assert.equal(sync.body.notified.length, 1);
  assert.equal(sync.body.notified[0].to, 'B');

  // 缺报：B 组湿地北已确认，A 组湿地北已收无有效观察；S20 为场地方补做
  const report = sync.body.venueReport;
  const stB = report.groups.find(g => g.group === 'B').stations.find(s => s.station === '湿地北');
  assert.equal(stB.state, '已确认');
  const stA = report.groups.find(g => g.group === 'A').stations.find(s => s.station === '湿地北');
  assert.equal(stA.state, '已收无有效观察');
  assert.equal(report.replacements.length, 1);
  assert.equal(report.replacements[0].stamp, 'S20');
  assert.equal(report.replacements[0].date, '2026-11-20');
  assert.equal(report.replacements[0].purpose, '课堂对照');
});

test('补做样本缺有效读数时不能发放，退回补录', async () => {
  const response = await post('/visits/V66/issue-replacement', { stamp: 'S20', group: 'B' });
  assert.equal(response.status, 409);
  assert.ok(response.body.error.includes('退回补录'));
  const report = await get('/visits/V66/venue-report');
  assert.equal(report.body.uncalibrated.length, 1);
  assert.equal(report.body.uncalibrated[0].observation, 'I4/B13/7/cond');
});

test('老师补正归属：缺标定不能裁定，手动改派走撤回-通知-重发', async () => {
  const bad = await post('/visits/V66/resolve', { observation: 'I4/B13/7/cond', group: 'B' });
  assert.equal(bad.status, 409);
  const resolved = await post('/visits/V66/resolve', { observation: 'I4/B12/7/temp', group: 'B', note: '现场补证' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.observation.attribution.group, 'B');
  assert.equal(resolved.body.observation.attribution.manual, true);
  assert.equal(resolved.body.withdrawn.length, 1);
  assert.equal(resolved.body.withdrawn[0].from, 'A');
  assert.equal(resolved.body.notified[0].to, 'B');
  const obs = await get('/visits/V66/observations');
  const mine = Object.fromEntries(obs.body.observations.map(o => [o.id, o]));
  assert.equal(mine['I4/B12/7/temp'].issue.group, 'B');
});

test('重启服务后受理记录仍在', async () => {
  const reopened = await createIntakeService({ origin: sourceOrigin, dataDir });
  reopened.listen(0, '127.0.0.1');
  await once(reopened, 'listening');
  const response = await fetch('http://127.0.0.1:' + reopened.address().port + '/visits/V66/pickups');
  const body = await response.json();
  assert.ok(body.pickups.length >= 2);
  assert.ok(body.withdrawals.length >= 1);
  reopened.close();
  await once(reopened, 'close');
});
