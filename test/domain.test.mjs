import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attributeReading, buildHoldingWindows, buildLedger, buildVenueReport,
  calibrationProblem, effectiveStation, toIntervals,
} from '../src/domain.mjs';

test('覆盖台账按开机段分别记账，旧包回传不吞掉现有缺口', () => {
  const manifest = [
    { device: 'I4', boot: 'B12', packet: 'E-18', interval: [7, 8], state: 'available' },
    { device: 'I4', boot: 'B12', packet: 'E-19', interval: [9, 9], state: 'pending' },
    { device: 'I4', boot: 'B13', packet: 'E-21', interval: [7, 7], state: 'available' },
  ];
  const saved = new Map([
    ['E-18', { records: [7, 8], receipt: 'R-1' }],
    ['E-21', { records: [7], receipt: 'R-2' }],
  ]);
  const ledger = buildLedger(manifest, saved);
  const b12 = ledger.find(b => b.boot === 'B12');
  // B13 已收 7 号，不能替 B12 补齐 9 号缺口
  assert.deepEqual(b12.covered, [[7, 8]]);
  assert.deepEqual(b12.missing, [[9, 9]]);
  assert.deepEqual(b12.pendingUploads, [{ packet: 'E-19', interval: [9, 9], location: null }]);
  // 旧包回传且区间变宽：E-19 实收 [8,9]，与 E-18 重叠去重后本段才齐
  const later = buildLedger([
    { device: 'I4', boot: 'B12', packet: 'E-18', interval: [7, 8], state: 'available' },
    { device: 'I4', boot: 'B12', packet: 'E-19', interval: [8, 9], state: 'available', location: '领队回库' },
  ], new Map([['E-18', { records: [7, 8] }], ['E-19', { records: [8, 9] }]]));
  assert.deepEqual(later[0].covered, [[7, 9]]);
  assert.deepEqual(later[0].missing, []);
});

test('区间折叠', () => {
  assert.deepEqual(toIntervals([9, 7, 8, 3]), [[3, 3], [7, 9]]);
  assert.deepEqual(toIntervals([]), []);
});

test('更正单作废原交接，持有窗口按实际交接时刻确认', () => {
  const { windows, voided } = buildHoldingWindows([
    { id: 'H1', device: 'I4', at: '2026-11-19T01:02:00Z', source: '柜台', target: 'A' },
    { id: 'H2', device: 'I4', at: '2026-11-19T01:11:22Z', source: 'A', target: 'B' },
    { id: 'H3', replaces: 'H2', device: 'I4', at: '2026-11-19T01:11:13Z', source: 'A', target: 'B' },
    { id: 'H9', device: 'I7', at: '2026-11-19T01:00:00Z', source: '柜台', target: 'C' },
  ], 'I4');
  assert.deepEqual(voided, ['H2']);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].holder, 'A');
  assert.equal(windows[0].until, Date.parse('2026-11-19T01:11:13Z'));
  assert.equal(windows[1].holder, 'B');
  assert.equal(windows[1].until, null);
});

test('时钟不确定区间跨交接时保留候选，印记共同指认才认定', () => {
  const cal = { openedAt: '2026-11-19T01:11:00Z', uncertaintySeconds: 10, channelWindow: { temp: [0, 30000] } };
  const windows = [
    { holder: 'A', since: Date.parse('2026-11-19T01:02:00Z'), until: Date.parse('2026-11-19T01:11:13Z') },
    { holder: 'B', since: Date.parse('2026-11-19T01:11:13Z'), until: null },
  ];
  // 读数 01:11:09 ±10s → [01:10:59, 01:11:19] 跨交接，对应两组候选
  const reading = { device: 'I4', boot: 'B12', sampleNo: 7, tickMs: 9000, channel: 'temp', stamp: 'S1' };
  const pending = attributeReading({ reading, calEntry: cal, windows, logEntry: { stamp: 'S1', station: '湿地西' } });
  assert.equal(pending.state, 'pending');
  assert.deepEqual(pending.candidates, ['A', 'B']);
  assert.ok(pending.missing.includes('印记缺登记时刻'));
  assert.ok(pending.missing.includes('时钟不确定区间跨交接'));
  // 印记时刻落在 B 窗口 → 持有窗口与现场印记共同指认 B
  const decided = attributeReading({
    reading, calEntry: cal, windows,
    logEntry: { stamp: 'S1', station: '湿地西', at: '2026-11-19T01:11:18Z' },
  });
  assert.equal(decided.state, 'confirmed');
  assert.equal(decided.group, 'B');
  // 缺现场印记时只留候选，不能认定
  const noStamp = attributeReading({ reading, calEntry: cal, windows, logEntry: null });
  assert.equal(noStamp.state, 'pending');
  assert.ok(noStamp.missing.includes('缺现场印记'));
});

test('缺标定参数单独退回补录', () => {
  const cal = { channelWindow: { temp: [0, 30000] } };
  assert.equal(calibrationProblem(cal, { boot: 'B13', channel: 'cond', tickMs: 5000 }), '参数 cond 缺标定');
  assert.equal(calibrationProblem(cal, { boot: 'B13', channel: 'temp', tickMs: 31000 }), '参数 temp 超出标定段 [0,30000]ms');
  assert.equal(calibrationProblem(cal, { boot: 'B13', channel: 'temp', tickMs: 5000 }), null);
  assert.equal(calibrationProblem(null, { boot: 'B13', channel: 'temp', tickMs: 1 }), '开机段 B13 缺厂端标定');
});

test('点位迁移只在注明时段内生效', () => {
  const entry = {
    stamp: 'S9', station: '旧点',
    migration: { to: '新点', since: '2026-11-19T02:00:00Z', until: '2026-11-19T03:00:00Z' },
  };
  assert.equal(effectiveStation(entry, Date.parse('2026-11-19T02:30:00Z')), '新点');
  assert.equal(effectiveStation(entry, Date.parse('2026-11-19T04:00:00Z')), '旧点');
});

test('场地方缺报区分站已取消', () => {
  const report = buildVenueReport({
    visit: { visit: 'V', groups: [{ id: 'A', stations: ['湿地西'] }], cancellations: [{ group: 'A', station: '湿地西' }] },
    ledger: [],
    observations: [],
    logbook: [],
  });
  assert.equal(report.groups[0].stations[0].state, '站已取消');
});
