// 收件流程的纯判定逻辑：覆盖台账、持有窗口、标定核查、归属判定、场地方缺报。
// 本模块不触网、不读写文件，方便单测。

/** 读数身份：device、boot、sampleNo、channel 共同限定。 */
export function observationId(reading) {
  return [reading.device, reading.boot, reading.sampleNo, reading.channel].join('/');
}

/** 已收记录号折叠为闭区间列表，如 [7,8,9] -> [[7,9]]，[7,9] -> [[7,7],[9,9]]。 */
export function toIntervals(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const intervals = [];
  for (const n of sorted) {
    const last = intervals[intervals.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else intervals.push([n, n]);
  }
  return intervals;
}

export function expandIntervals(intervals) {
  const out = [];
  for (const [lo, hi] of intervals) for (let n = lo; n <= hi; n += 1) out.push(n);
  return out;
}

/**
 * 包台账按开机段（device+boot）分别记账：
 * 不同开机段的相同记录号互不认账；旧包回传只补自己开机段的缺口，
 * 不能因别的开机段出现同一记录号就确认旧包已齐。
 * savedPackets: Map packet -> { records, receipt }。
 */
export function buildLedger(manifest, savedPackets) {
  const boots = new Map();
  for (const entry of manifest) {
    const key = entry.device + '/' + entry.boot;
    if (!boots.has(key)) boots.set(key, { device: entry.device, boot: entry.boot, expected: [], packets: [] });
    const boot = boots.get(key);
    boot.expected.push(entry.interval);
    const saved = savedPackets.get(entry.packet);
    boot.packets.push({
      packet: entry.packet,
      interval: entry.interval,
      state: saved ? 'saved' : entry.state,
      location: entry.location ?? null,
      records: saved ? saved.records : null,
      receipt: saved ? saved.receipt : null,
    });
  }
  for (const boot of boots.values()) {
    const covered = new Set();
    for (const packet of boot.packets) {
      if (packet.records) for (const n of packet.records) covered.add(n);
    }
    const missing = expandIntervals(boot.expected).filter(n => !covered.has(n));
    boot.covered = toIntervals([...covered]);
    boot.missing = toIntervals(missing);
    boot.pendingUploads = boot.packets
      .filter(p => p.state === 'pending')
      .map(p => ({ packet: p.packet, interval: p.interval, location: p.location }));
  }
  return [...boots.values()];
}

/**
 * 持有窗口只按实际接收与交出确认；更正单（replaces）作废原登记。
 * 返回每个设备的持有窗口序列及被作废的登记号。
 */
export function buildHoldingWindows(transfers, device) {
  const replaced = new Set(transfers.filter(t => t.replaces).map(t => t.replaces));
  const effective = transfers
    .filter(t => t.device === device && !replaced.has(t.id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const windows = effective.map((t, i) => ({
    holder: t.target,
    since: Date.parse(t.at),
    until: i + 1 < effective.length ? Date.parse(effective[i + 1].at) : null,
    transfer: t.id,
  }));
  const voided = transfers.filter(t => t.device === device && replaced.has(t.id)).map(t => t.id);
  return { windows, voided };
}

/** 厂端标定段核查：通道未列入或超出允许的开机毫秒区间即缺标定，可单独退回补录。 */
export function calibrationProblem(calEntry, reading) {
  if (!calEntry) return '开机段 ' + reading.boot + ' 缺厂端标定';
  const window = calEntry.channelWindow?.[reading.channel];
  if (!window) return '参数 ' + reading.channel + ' 缺标定';
  if (reading.tickMs < window[0] || reading.tickMs > window[1]) {
    return '参数 ' + reading.channel + ' 超出标定段 [' + window[0] + ',' + window[1] + ']ms';
  }
  return null;
}

/** 点位迁移只在注明时段内生效，其余时间按原点位。 */
export function effectiveStation(logEntry, atMs) {
  const migration = logEntry?.migration;
  if (migration?.to && migration.since && migration.until) {
    if (atMs >= Date.parse(migration.since) && atMs <= Date.parse(migration.until)) return migration.to;
  }
  return logEntry?.station ?? null;
}

/**
 * 归属判定：读数时刻为 开机锚点+tickMs±不确定秒数 的区间。
 * 只有持有窗口与现场印记共同指认同一个组才认定归属；
 * 否则保留候选组与所缺证据，留给老师裁定。
 */
export function attributeReading({ reading, calEntry, windows, logEntry }) {
  const base = Date.parse(calEntry.openedAt) + reading.tickMs;
  const spread = calEntry.uncertaintySeconds * 1000;
  const interval = [base - spread, base + spread];
  const candidates = [...new Set(windows
    .filter(w => interval[0] < (w.until ?? Infinity) && interval[1] >= w.since)
    .map(w => w.holder))];
  const missing = [];
  const supported = new Set();
  let station = null;
  if (!logEntry) {
    missing.push('缺现场印记');
  } else {
    station = effectiveStation(logEntry, base);
    if (logEntry.at) {
      const at = Date.parse(logEntry.at);
      for (const w of windows) {
        if (at >= w.since && (w.until === null || at < w.until)) supported.add(w.holder);
      }
    } else {
      missing.push('印记缺登记时刻');
    }
    for (const witness of logEntry.witnesses ?? []) supported.add(witness);
    if (supported.size === 0) missing.push('印记不能指认持有组');
  }
  if (candidates.length === 0) missing.push('持有窗口无对应组');
  if (candidates.length > 1) missing.push('时钟不确定区间跨交接');
  const agreed = candidates.filter(g => supported.has(g));
  const result = {
    at: new Date(base).toISOString(),
    uncertaintySeconds: calEntry.uncertaintySeconds,
    interval: interval.map(ms => new Date(ms).toISOString()),
    station,
    candidates,
  };
  if (agreed.length === 1) return { ...result, state: 'confirmed', group: agreed[0], missing };
  if (agreed.length === 0 && candidates.length > 0 && supported.size > 0) {
    missing.push('持有窗口与现场印记指向不同组');
  }
  return { ...result, state: 'pending', missing };
}

/**
 * 场地方缺报：按组×计划站点区分
 * 站已取消 / 待取原包 / 原包已收但无有效观察 / 待裁定 / 已确认 / 无记录，
 * 并列出待补传区间、退回补录参数与场地方补做样本。
 */
export function buildVenueReport({ visit, ledger, observations, logbook }) {
  const cancellations = new Set((visit.cancellations ?? []).map(c => c.group + '@' + c.station));
  const packets = ledger.flatMap(boot => boot.packets.map(p => ({ ...p, boot: boot.boot, device: boot.device })));
  const stationsByPacket = new Map();
  const stationsByBoot = new Map();
  const remember = (map, key, station) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(station);
  };
  for (const obs of observations) {
    if (!obs.station) continue;
    remember(stationsByPacket, obs.reading.packet, obs.station);
    remember(stationsByBoot, obs.reading.boot, obs.station);
  }
  // 待取原包尚无内容，按同开机段已知印记估计其涉及站点
  const relatedStations = packet => {
    const own = stationsByPacket.get(packet.packet);
    if (own?.size) return [...own];
    if (packet.state === 'pending') return [...(stationsByBoot.get(packet.boot) ?? [])];
    return [];
  };
  const groups = visit.groups.map(group => ({
    group: group.id,
    stations: group.stations.map(station => {
      if (cancellations.has(group.id + '@' + station)) return { station, state: '站已取消', notes: [] };
      const atStation = observations.filter(obs => obs.station === station);
      const mine = atStation.filter(obs =>
        obs.valid && obs.attribution?.state === 'confirmed' && obs.attribution.group === group.id);
      if (mine.length > 0) {
        return { station, state: '已确认', observations: mine.map(obs => obs.id).sort(), notes: [] };
      }
      const undecided = atStation.filter(obs => obs.valid && obs.attribution?.state === 'pending');
      if (undecided.length > 0) {
        return { station, state: '待裁定', observations: undecided.map(obs => obs.id).sort(), notes: [] };
      }
      const related = packets.filter(packet => relatedStations(packet).includes(station));
      const notes = [];
      for (const packet of related.filter(p => p.state === 'saved')) {
        for (const obs of atStation.filter(o => o.reading.packet === packet.packet && !o.valid)) {
          notes.push(packet.packet + ' ' + obs.reading.channel + ' ' + obs.invalidReason + '，退回补录');
        }
        for (const obs of atStation.filter(o =>
          o.reading.packet === packet.packet && o.valid &&
          o.attribution?.state === 'confirmed' && o.attribution.group !== group.id)) {
          notes.push(packet.packet + ' 有效观察 ' + obs.id + ' 归属 ' + obs.attribution.group);
        }
        for (const obs of atStation.filter(o => o.reading.packet === packet.packet && o.replacement)) {
          notes.push(packet.packet + ' 印记 ' + obs.reading.stamp + ' 为场地方补做样本');
        }
      }
      const pending = related.filter(packet => packet.state === 'pending');
      if (pending.length > 0) {
        return { station, state: '待取原包', packets: pending.map(p => p.packet).sort(), notes };
      }
      if (related.some(packet => packet.state === 'saved')) {
        return {
          station, state: '已收无有效观察',
          packets: related.filter(p => p.state === 'saved').map(p => p.packet).sort(), notes,
        };
      }
      return { station, state: '无记录', notes };
    }),
  }));
  return {
    visit: visit.visit,
    groups,
    pendingUploads: ledger.flatMap(boot => boot.pendingUploads.map(u => ({ ...u, boot: boot.boot }))),
    uncalibrated: observations.filter(obs => !obs.valid).map(obs => ({
      observation: obs.id, packet: obs.reading.packet, channel: obs.reading.channel, reason: obs.invalidReason,
    })),
    replacements: logbook.filter(entry => entry.replacementPurpose).map(entry => ({
      stamp: entry.stamp,
      station: entry.station,
      date: entry.date ?? null,
      purpose: entry.replacementPurpose,
      observations: observations.filter(obs => obs.reading.stamp === entry.stamp).map(obs => ({
        id: obs.id, valid: obs.valid, reason: obs.invalidReason ?? null,
      })),
    })),
  };
}
