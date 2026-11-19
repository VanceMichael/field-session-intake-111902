// 队次会话：收件、归属、发放的状态与持久化。
// 原始记录先落盘（data/<队次>/packets/<包>.ndjson），再向现场确认已收；
// 台账存 data/<队次>/state.json，服务重启后可恢复。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attributeReading, buildHoldingWindows, buildLedger, buildVenueReport,
  calibrationProblem, effectiveStation, observationId,
} from './domain.mjs';

function fail(status, message, detail) {
  const error = new Error(message);
  error.status = status;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw fail(400, '队次请求应为 JSON 对象');
  }
  for (const field of ['visit', 'day', 'school']) {
    if (typeof request[field] !== 'string' || request[field] === '') {
      throw fail(400, '队次请求缺字段 ' + field);
    }
  }
  if (!Array.isArray(request.groups) || request.groups.length === 0) {
    throw fail(400, '队次请求缺小组列表');
  }
  for (const group of request.groups) {
    if (typeof group?.id !== 'string' || group.id === '') throw fail(400, '小组缺编号');
    if (!Array.isArray(group.stations)) throw fail(400, '小组 ' + group.id + ' 缺计划站点');
  }
}

export class VisitSession {
  constructor({ dir, client, state }) {
    this.dir = dir;
    this.client = client;
    this.state = state;
    this.sources = null; // 最近一次同步的来源快照
  }

  get id() {
    return this.state.request.visit;
  }

  static async create({ dir, client, request }) {
    validateRequest(request);
    const session = new VisitSession({
      dir,
      client,
      state: {
        request,
        packets: {},
        observations: {},
        resolves: {},
        pickups: [],
        withdrawals: [],
        notifications: [],
        seq: 0,
      },
    });
    await session.persist();
    return session;
  }

  static async load({ dir, client }) {
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    return new VisitSession({ dir, client, state });
  }

  async persist() {
    await mkdir(join(this.dir, 'packets'), { recursive: true });
    await writeFile(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2));
  }

  /** 收件：列出当前导出包，逐包保存原始记录后再向现场确认已收。 */
  async collect() {
    const manifest = await this.client.manifest();
    this.sources = { ...this.sources, manifest };
    for (const entry of manifest) {
      if (entry.state !== 'available') continue; // pending 为离线包，待领队回库补传
      if (this.state.packets[entry.packet]?.receipt) continue; // 已收过的不重复受理
      const rows = await this.client.exports(entry.packet);
      const records = [...new Set(rows.map(row => row.sampleNo))].sort((a, b) => a - b);
      await mkdir(join(this.dir, 'packets'), { recursive: true });
      await writeFile(
        join(this.dir, 'packets', entry.packet + '.ndjson'),
        rows.map(row => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''),
      );
      const requestKey = this.id + ':' + entry.packet;
      const accepted = await this.client.confirmReceipt({
        requestKey, packet: entry.packet, boot: entry.boot, records,
      });
      this.state.packets[entry.packet] = {
        packet: entry.packet, boot: entry.boot, device: entry.device,
        records, receipt: accepted.receipt, requestKey,
      };
      for (const row of rows) {
        const id = observationId(row);
        const existing = this.state.observations[id];
        if (existing) {
          // 同一开机段的重复导出会重叠：同一读数只记一笔，记下重复出现的包
          if (!existing.duplicates?.includes(entry.packet)) {
            existing.duplicates = [...(existing.duplicates ?? []), entry.packet];
          }
          continue;
        }
        this.state.observations[id] = { id, reading: { ...row, packet: entry.packet }, history: [] };
      }
    }
  }

  /** 归属：标定核查 + 持有窗口与现场印记共同判定；老师裁定优先。 */
  async reattribute() {
    const [calibration, transfers, logbook] = await Promise.all([
      this.client.calibration(), this.client.transfers(), this.client.logbook(),
    ]);
    this.sources = { ...this.sources, calibration, transfers, logbook };
    const logByStamp = new Map(logbook.map(entry => [entry.stamp, entry]));
    const windowsByDevice = new Map();
    for (const obs of Object.values(this.state.observations)) {
      const reading = obs.reading;
      const cal = calibration.find(c => c.device === reading.device && c.boot === reading.boot);
      const logEntry = logByStamp.get(reading.stamp) ?? null;
      const atMs = cal
        ? Date.parse(cal.openedAt) + reading.tickMs
        : Date.parse(logEntry?.at ?? 0) || 0;
      obs.station = logEntry ? effectiveStation(logEntry, atMs) : null;
      obs.replacement = logEntry?.replacementPurpose
        ? { date: logEntry.date ?? null, purpose: logEntry.replacementPurpose }
        : null;
      const problem = calibrationProblem(cal, reading);
      obs.valid = !problem;
      obs.invalidReason = problem;
      if (problem || obs.replacement) {
        // 缺标定参数退回补录、场地方补做样本，都不参与学生归属判定，原始记录仍可追查
        obs.attribution = null;
        continue;
      }
      if (!windowsByDevice.has(reading.device)) {
        windowsByDevice.set(reading.device, buildHoldingWindows(transfers, reading.device));
      }
      const decision = attributeReading({
        reading, calEntry: cal, windows: windowsByDevice.get(reading.device).windows, logEntry,
      });
      const resolve = this.state.resolves[obs.id];
      obs.attribution = resolve
        ? { ...decision, state: 'confirmed', group: resolve.group, manual: true, note: resolve.note }
        : decision;
    }
  }

  /**
   * 发放协调：归属改变的已发观察先撤回旧组用权并通知接手组；
   * 新认定的观察按组发放（学校允许先领已认定的部分）。
   */
  async reconcile({ purpose, reason = '交接单更正归属' }) {
    const outcome = { pickups: [], withdrawals: [], notifications: [] };
    for (const obs of Object.values(this.state.observations)) {
      if (!obs.issue) continue;
      const target = obs.attribution?.state === 'confirmed' ? obs.attribution.group : null;
      if (target === obs.issue.group) continue;
      const requestKey = this.id + ':withdraw:' + ++this.state.seq;
      const accepted = await this.client.schoolPickup({
        requestKey,
        group: obs.issue.group,
        observations: [obs.id],
        purpose: target ? '撤回：归属更正为 ' + target : '撤回：归属待裁定',
        priorReceipt: obs.issue.receipt,
      });
      const withdrawal = {
        requestKey, receipt: accepted.receipt, observation: obs.id,
        from: obs.issue.group, to: target, priorReceipt: obs.issue.receipt,
      };
      this.state.withdrawals.push(withdrawal);
      obs.history.push({ event: 'withdrawn', from: obs.issue.group, receipt: accepted.receipt });
      if (target) {
        const notification = { to: target, observation: obs.id, from: obs.issue.group, reason, receipt: accepted.receipt };
        this.state.notifications.push(notification);
        outcome.notifications.push(notification);
      }
      obs.issue = null;
      outcome.withdrawals.push(withdrawal);
    }
    const byGroup = new Map();
    for (const obs of Object.values(this.state.observations)) {
      if (obs.issue || obs.replacement) continue;
      if (obs.attribution?.state !== 'confirmed') continue;
      if (!byGroup.has(obs.attribution.group)) byGroup.set(obs.attribution.group, []);
      byGroup.get(obs.attribution.group).push(obs.id);
    }
    for (const [group, ids] of [...byGroup.entries()].sort()) {
      const observations = ids.sort();
      const requestKey = this.id + ':pickup:' + ++this.state.seq;
      const accepted = await this.client.schoolPickup({ requestKey, group, observations, purpose });
      const pickup = { requestKey, receipt: accepted.receipt, group, observations, purpose, kind: 'issue' };
      this.state.pickups.push(pickup);
      for (const id of observations) {
        const obs = this.state.observations[id];
        obs.issue = { group, receipt: accepted.receipt, requestKey, purpose };
        obs.history.push({ event: 'issued', group, receipt: accepted.receipt });
      }
      outcome.pickups.push(pickup);
    }
    return outcome;
  }

  /** 老师裁定待归属观察；改派已发观察同样走撤回-通知-重发。 */
  async resolve(observationIdValue, group, note) {
    const obs = this.state.observations[observationIdValue];
    if (!obs) throw fail(404, '查无观察 ' + observationIdValue);
    if (!obs.valid) throw fail(409, '缺标定观察不能认定归属，已退回补录');
    if (obs.replacement) throw fail(409, '场地方补做样本不按学生观察归属');
    this.state.resolves[obs.id] = { group, note: note ?? null };
    obs.attribution = {
      ...(obs.attribution ?? { candidates: [], missing: [] }),
      state: 'confirmed', group, manual: true, note: note ?? null,
    };
    const outcome = await this.reconcile({ purpose: '课后作业', reason: '老师裁定更正归属' });
    await this.persist();
    return {
      observation: this.observationView(obs),
      issued: outcome.pickups,
      withdrawn: outcome.withdrawals,
      notified: outcome.notifications,
    };
  }

  /** 场地方补做样本：另带采集日期与学校许可用途发放，不记作学生当天亲采。 */
  async issueReplacement(stamp, group) {
    if (!this.sources?.logbook) throw fail(409, '请先同步再发放补做样本');
    const entry = this.sources.logbook.find(e => e.stamp === stamp && e.replacementPurpose);
    if (!entry) throw fail(404, '查无场地方补做样本 ' + stamp);
    const related = Object.values(this.state.observations).filter(o => o.reading.stamp === stamp);
    const valid = related.filter(o => o.valid);
    if (valid.length === 0) {
      throw fail(409, '补做样本缺有效读数，已退回补录',
        related.map(o => ({ observation: o.id, reason: o.invalidReason })));
    }
    const unissued = valid.filter(o => !o.replacementIssue);
    if (unissued.length === 0) throw fail(409, '补做样本已发放');
    const requestKey = this.id + ':replacement:' + ++this.state.seq;
    const observations = unissued.map(o => o.id).sort();
    const accepted = await this.client.schoolPickup({
      requestKey, group, observations,
      purpose: entry.replacementPurpose,
      date: entry.date ?? null,
      replacement: true,
    });
    const pickup = {
      requestKey, receipt: accepted.receipt, group, observations,
      purpose: entry.replacementPurpose, date: entry.date ?? null, kind: 'replacement',
    };
    this.state.pickups.push(pickup);
    for (const obs of unissued) {
      obs.replacementIssue = { group, receipt: accepted.receipt, requestKey };
      obs.history.push({ event: 'replacement-issued', group, receipt: accepted.receipt });
    }
    await this.persist();
    return pickup;
  }

  /** 全流程：收件 → 归属 → 撤回/通知/发放 → 台账与缺报。 */
  async sync({ purpose = '课后作业' } = {}) {
    await this.collect();
    await this.reattribute();
    const outcome = await this.reconcile({ purpose });
    await this.persist();
    return {
      visit: this.id,
      ledger: this.ledger(),
      observations: Object.values(this.state.observations).map(obs => this.observationView(obs)),
      venueReport: this.venueReport(),
      issued: outcome.pickups,
      withdrawn: outcome.withdrawals,
      notified: outcome.notifications,
      pickups: this.state.pickups,
      withdrawals: this.state.withdrawals,
      notifications: this.state.notifications,
    };
  }

  ledger() {
    if (!this.sources?.manifest) throw fail(409, '请先同步再查台账');
    return buildLedger(this.sources.manifest, new Map(Object.entries(this.state.packets)));
  }

  venueReport() {
    if (!this.sources?.logbook) throw fail(409, '请先同步再查缺报');
    return buildVenueReport({
      visit: this.state.request,
      ledger: this.ledger(),
      observations: Object.values(this.state.observations),
      logbook: this.sources.logbook,
    });
  }

  observationView(obs) {
    let state;
    if (!obs.valid) state = '缺标定退回补录';
    else if (obs.replacement) state = '场地方补做';
    else if (obs.issue) state = '已发放:' + obs.issue.group;
    else if (obs.attribution?.state === 'confirmed') state = '已认定:' + obs.attribution.group;
    else if (obs.attribution?.state === 'pending') state = '待裁定';
    else state = '已收待判定';
    return {
      id: obs.id,
      state,
      reading: obs.reading,
      station: obs.station ?? null,
      valid: obs.valid,
      invalidReason: obs.invalidReason ?? null,
      attribution: obs.attribution ?? null,
      replacement: obs.replacement ?? null,
      issue: obs.issue ?? null,
      duplicates: obs.duplicates ?? [],
      history: obs.history ?? [],
    };
  }

  summary() {
    return {
      visit: this.id,
      school: this.state.request.school,
      day: this.state.request.day,
      groups: this.state.request.groups.map(g => g.id),
      synced: Boolean(this.sources?.manifest),
      counts: {
        packets: Object.keys(this.state.packets).length,
        observations: Object.keys(this.state.observations).length,
        pickups: this.state.pickups.length,
        withdrawals: this.state.withdrawals.length,
      },
    };
  }
}

export async function loadSessions(dataDir, client) {
  const sessions = new Map();
  let entries = [];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const session = await VisitSession.load({ dir: join(dataDir, entry.name), client });
      sessions.set(session.id, session);
    } catch { /* 跳过损坏的队次目录 */ }
  }
  return sessions;
}
