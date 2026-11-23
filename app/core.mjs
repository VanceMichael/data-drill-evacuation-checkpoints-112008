// 演练清点核心逻辑：摄取、归属判定、序号完整性、转接、清点单、签收与更正、封单、值守查询。
// 状态为纯 JSON 对象，便于持久化与重启后复核。

export const VERSION = 1;

// ---- 时间工具：源端使用 "HH:MM:SS"，内部统一换算为当日秒数 ----
export function toSec(text) {
  const [h, m, s] = String(text).split(':').map(Number);
  return h * 3600 + m * 60 + s;
}
export function fmt(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
const TICK_UNIT = { second: 1, minute: 60, millisecond: 0.001 };

export const recordId = (device, boot, seq) => `${device}|${boot}|${seq}`;
export const batchId = (device, boot) => `${device}|${boot}`;
const cardKey = (card, round) => `${card}|${round}`;

// 清点结论的中文名，供报告与命令行使用
export const LABELS = {
  verified: '已核实',
  transferred: '已转运',
  'pending-transfer': '转出未收',
  'pending-attribution': '归属未定',
  'pending-evidence': '只缺终端证据',
  missing: '仍待发现',
  conflict: '暂挂冲突',
};
// 仍可能改变清点结论的状态（封单前必须清零）
const PENDING_KINDS = ['pending-transfer', 'pending-attribution', 'pending-evidence', 'conflict'];

export function initialState() {
  return {
    version: VERSION,
    appliedLog: 0,          // 已应用的源记录日志序号（崩溃恢复用）
    rounds: {},             // 轮次：区域、领队、点位、时间窗
    assignments: {},        // 牌号分配：card|round -> {person, valid}
    devices: {},            // 设备索引（开机批次）
    calibrations: {},         // batchId -> 校时记录列表（按 atTick 排序）
    batches: {},            // batchId -> 上传批次（声明末序号、完成标记、已收序号、已确认号）
    records: {},            // 源记录：device|boot|seq -> 扫描原件及其归属判定
    transfers: {},          // 转接单：ref -> sends/accepts
    reroutes: [],           // 志愿者改派申请（本地台账）
    anomalies: [],          // 异常（补交内容不一致、孤儿回执、无效牌等）
    sheets: {},             // roundId -> {stages: [已签阶段单], sealed}
    claims: {},             // roundId -> {person: 认领记录}
    stats: { syncs: 0, duplicates: 0, replays: 0 },
  };
}

// ------------------------------------------------------------------
// 摄取：馆方发布的轮次、牌号分配、设备索引、校时记录
// ------------------------------------------------------------------

export function ingestRounds(state, list) {
  for (const r of list ?? []) {
    state.rounds[r.id] = {
      id: r.id, area: r.area, leader: r.leader, checkpoints: r.checkpoints ?? [],
      start: toSec(r.start), end: toSec(r.end), startText: r.start, endText: r.end,
    };
  }
}

export function ingestCards(state, list) {
  for (const c of list ?? []) {
    // 牌号按轮次分配，有效区间结束不含边界；上一轮归还后下一轮可复用同一牌号
    state.assignments[cardKey(c.card, c.round)] = {
      card: c.card, person: c.person, round: c.round,
      validStart: toSec(c.valid[0]), validEnd: toSec(c.valid[1]), local: false,
    };
  }
}

function ensureBatch(state, device, boot) {
  const id = batchId(device, boot);
  if (!state.batches[id]) {
    state.batches[id] = { id, device, boot, through: 0, end: false, received: {}, confirmedThrough: 0, replays: {}, confirms: [] };
  }
  return state.batches[id];
}

export function ingestDevices(state, list) {
  for (const d of list ?? []) {
    state.devices[d.device] = { device: d.device, boot: d.boot, path: d.path };
    ensureBatch(state, d.device, d.boot);
  }
}

export function ingestCalibration(state, list) {
  for (const c of list ?? []) {
    const id = batchId(c.device, c.boot);
    const arr = state.calibrations[id] ?? (state.calibrations[id] = []);
    const entry = { device: c.device, boot: c.boot, atTick: c.atTick, earliest: toSec(c.earliest), latest: toSec(c.latest), tickUnit: c.tickUnit };
    const i = arr.findIndex((x) => x.atTick === c.atTick);
    if (i >= 0) arr[i] = entry; else arr.push(entry);
    arr.sort((a, b) => a.atTick - b.atTick);
    ensureBatch(state, c.device, c.boot);
  }
}

// ------------------------------------------------------------------
// 摄取：设备缓冲与补取片段。同一条扫描被两次补交不能算两个人：
// 以 device|boot|seq 为源记录唯一键去重；同序号内容不一致记异常并保留先到的原件。
// ------------------------------------------------------------------

export function ingestEntries(state, device, boot, entries, origin) {
  const batch = ensureBatch(state, device, boot);
  let added = 0, duplicates = 0;
  for (const e of entries ?? []) {
    const id = recordId(device, boot, e.seq);
    const existing = state.records[id];
    if (existing) {
      duplicates += 1;
      if (existing.card !== e.card || existing.point !== e.point || existing.tick !== e.tick) {
        pushAnomaly(state, {
          kind: 'conflicting-record', record: id,
          saved: { card: existing.card, point: existing.point, tick: existing.tick },
          received: { card: e.card, point: e.point, tick: e.tick },
        });
      }
      if (!existing.origins.includes(origin)) existing.origins.push(origin);
      continue;
    }
    state.records[id] = { id, device, boot, seq: e.seq, tick: e.tick, card: e.card, point: e.point, origins: [origin], attribution: null };
    batch.received[e.seq] = id;
    added += 1;
  }
  state.stats.duplicates += duplicates;
  return { added, duplicates };
}

export function ingestMemory(state, device, boot, payload) {
  const batch = ensureBatch(state, device, boot);
  // 序号完整性由上传末尾的声明（through/end）与实收序号共同判断；
  // 完成标记可能先于缺失的中间段到达，先如实登记，缺片留待补取。
  if (typeof payload?.through === 'number') batch.through = Math.max(batch.through, payload.through);
  if (payload?.end === true) batch.end = true;
  return ingestEntries(state, device, boot, payload?.entries, 'memory');
}

export function ingestReplay(state, device, boot, from, to, status, payload) {
  const batch = ensureBatch(state, device, boot);
  const key = `${from}-${to}`;
  if (status === 200 && payload) {
    const entries = Array.isArray(payload) ? payload : payload.entries ?? [];
    batch.replays[key] = 'received';
    state.stats.replays += 1;
    return ingestEntries(state, device, boot, entries, 'replay');
  }
  batch.replays[key] = status === 202 ? 'pending' : `unavailable(${status})`;
  return { added: 0, duplicates: 0 };
}

export function ingestTransfers(state, list) {
  for (const op of list ?? []) {
    const t = state.transfers[op.ref] ?? (state.transfers[op.ref] = { ref: op.ref, sends: [], accepts: [] });
    if (op.op === 'send') {
      if (!t.sends.some((s) => s.at === op.at && s.lead === op.lead && s.from === op.from && s.to === op.to)) {
        t.sends.push({ round: op.round, person: op.person, from: op.from, to: op.to, at: op.at, lead: op.lead });
      }
      t.round = op.round; t.person = op.person;
    } else if (op.op === 'accept') {
      // 医疗点接收回执必须能接回集合点批准的转接单（按 ref 连接）
      if (!t.sends.length) pushAnomaly(state, { kind: 'orphan-accept', ref: op.ref, op });
      if (!t.accepts.some((a) => a.at === op.at && a.lead === op.lead)) {
        t.accepts.push({ point: op.point, at: op.at, lead: op.lead });
      }
    }
  }
}

function pushAnomaly(state, anomaly) {
  const key = JSON.stringify(anomaly);
  if (!state.anomalies.some((a) => JSON.stringify(a) === key)) state.anomalies.push(anomaly);
}

// ------------------------------------------------------------------
// 归属判定：校时记录给的是区间 [earliest, latest]。
// 只在校时足以把整条扫描唯一确定进某一轮的牌号有效区间时才计入清点；
// 跨轮次边界不能擅取中点，暂挂候选，等待更充分的校时。
// ------------------------------------------------------------------

export function attributeAll(state) {
  for (const rec of Object.values(state.records)) rec.attribution = attributeRecord(state, rec);
}

function attributeRecord(state, rec) {
  const cals = state.calibrations[batchId(rec.device, rec.boot)] ?? [];
  const usable = cals.filter((c) => c.atTick <= rec.tick && TICK_UNIT[c.tickUnit] !== undefined);
  if (!usable.length) {
    return { status: 'undetermined', reason: cals.length ? 'no-covering-calibration' : 'no-calibration', candidates: [] };
  }
  const cal = usable[usable.length - 1];
  const unit = TICK_UNIT[cal.tickUnit];
  const lo = cal.earliest + (rec.tick - cal.atTick) * unit;
  const hi = cal.latest + (rec.tick - cal.atTick) * unit;
  const overlaps = [];
  for (const a of Object.values(state.assignments)) {
    if (a.card !== rec.card) continue;
    // 有效区间结束不含边界：[validStart, validEnd)
    if (lo < a.validEnd && hi >= a.validStart) {
      overlaps.push({ round: a.round, person: a.person, contained: lo >= a.validStart && hi < a.validEnd });
    }
  }
  const contained = overlaps.filter((o) => o.contained);
  if (contained.length === 1) {
    return { status: 'attributed', person: contained[0].person, round: contained[0].round, wall: [lo, hi] };
  }
  if (contained.length > 1) return { status: 'undetermined', reason: 'ambiguous', candidates: contained, wall: [lo, hi] };
  if (overlaps.length) return { status: 'undetermined', reason: 'crosses-boundary', candidates: overlaps, wall: [lo, hi] };
  return { status: 'invalid', reason: 'card-not-valid-in-window', wall: [lo, hi] };
}

// ------------------------------------------------------------------
// 序号完整性：声明末序号 through 与实收序号的差集即缺失段；
// 设备按已确认接收的连续序号回收缓存，确认前必须保证
// 该段源记录已留存且归属可复核（已确定），否则不予确认。
// ------------------------------------------------------------------

export function missingRanges(batch) {
  const missing = [];
  let start = null;
  for (let s = 1; s <= batch.through; s += 1) {
    if (!batch.received[s]) { if (start === null) start = s; }
    else if (start !== null) { missing.push([start, s - 1]); start = null; }
  }
  if (start !== null) missing.push([start, batch.through]);
  return missing;
}

export function planConfirm(state, device, boot) {
  const batch = ensureBatch(state, device, boot);
  let n = 0;
  for (let s = 1; s <= batch.through; s += 1) {
    const id = batch.received[s];
    if (!id) break;
    const a = state.records[id]?.attribution;
    if (!a || (a.status !== 'attributed' && a.status !== 'invalid')) break;
    n = s;
  }
  return n;
}

// ------------------------------------------------------------------
// 转接：send 为集合点领队批准的转接单，accept 为医疗点接收回执。
// ------------------------------------------------------------------

export function transferStatus(t) {
  if (t.sends.length && t.accepts.length) return 'received';
  if (t.sends.length) return 'sent';
  return 'orphan';
}

function transferView(t) {
  const send = t.sends[t.sends.length - 1] ?? null;
  const accept = t.accepts[t.accepts.length - 1] ?? null;
  const status = transferStatus(t);
  return {
    ref: t.ref, status, round: t.round, person: t.person,
    send, accept,
    // 记录转出但未见接收时，负责确认的人仍有明确归属：批准转接的领队
    stuckAt: status === 'sent' ? 'accept' : null,
    owner: status === 'sent' ? send?.lead : null,
  };
}

function latestTransfer(state, person, roundId) {
  const list = Object.values(state.transfers)
    .filter((t) => t.person === person && t.round === roundId && t.sends.length)
    .sort((a, b) => (a.sends[a.sends.length - 1].at < b.sends[b.sends.length - 1].at ? -1 : 1));
  return list[list.length - 1] ?? null;
}

// 同一人在同一轮次扫到多个点位时，有效移交（已接收的转接链）已在上方
// 转接分支处理；走到这里说明没有任何转接记录，无法确定去向，
// 暂挂候选点位，不能凭最新到达挑一个。

// ------------------------------------------------------------------
// 清点单
// ------------------------------------------------------------------

// 归属未定记录可能属于哪些轮次：有候选按候选；校时完全缺失时，
// 按牌号的所有有效区间挂到每一个可能轮次（宁挂不漏）。
function possibleRounds(state, rec) {
  const at = rec.attribution;
  if (at?.status !== 'undetermined') return [];
  if ((at.candidates ?? []).length) return [...new Set(at.candidates.map((c) => c.round))];
  return [...new Set(Object.values(state.assignments).filter((a) => a.card === rec.card).map((a) => a.round))];
}

function batchRounds(state, batch) {
  const rounds = new Set();
  for (const cal of state.calibrations[batch.id] ?? []) {
    for (const r of Object.values(state.rounds)) {
      if ((cal.earliest >= r.start && cal.earliest < r.end) || (cal.latest >= r.start && cal.latest < r.end)) rounds.add(r.id);
    }
  }
  for (const id of Object.values(batch.received)) {
    const rec = state.records[id];
    const at = rec?.attribution;
    if (at?.status === 'attributed') rounds.add(at.round);
    for (const r of rec ? possibleRounds(state, rec) : []) rounds.add(r);
  }
  return rounds;
}

// 仍等接收的离线段：声明内的缺失段，或完成标记尚未到达的批次
export function openSegmentsForRound(state, roundId) {
  const out = [];
  for (const batch of Object.values(state.batches)) {
    const missing = missingRanges(batch);
    if (!missing.length && batch.end) continue;
    if (!batchRounds(state, batch).has(roundId)) continue;
    out.push({
      id: batch.id, device: batch.device, boot: batch.boot, through: batch.through,
      confirmedThrough: batch.confirmedThrough, missing, endReceived: batch.end, replays: batch.replays,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function personEntry(state, round, exp, reroutes) {
  const { person, cards } = exp;
  const records = Object.values(state.records).filter((r) =>
    cards.includes(r.card) && r.attribution?.status === 'attributed'
    && r.attribution.round === round.id && r.attribution.person === person);
  const points = [...new Set(records.map((r) => r.point))].sort();
  const heldRecords = Object.values(state.records).filter((r) =>
    cards.includes(r.card) && r.attribution?.status === 'undetermined'
    && possibleRounds(state, r).includes(round.id));
  const transfer = latestTransfer(state, person, round.id);
  const tStatus = transfer ? transferStatus(transfer) : null;
  const entry = {
    person, cards: [...cards].sort(),
    evidence: {
      records: records.map((r) => r.id).sort(),
      held: heldRecords.map((r) => r.id).sort(),
      transfer: transfer?.ref ?? null,
    },
    reroute: reroutes.filter((r) => r.person === person).map((r) => ({ toPoint: r.toPoint, by: r.by, at: r.at })),
  };
  if (tStatus === 'received') {
    const accept = transfer.accepts[transfer.accepts.length - 1];
    return { ...entry, conclusion: 'transferred', at: accept.point ?? transfer.sends.at(-1).to, owner: null, detail: `转接 ${transfer.ref} 已由 ${accept.lead} 于 ${accept.at} 接收` };
  }
  if (tStatus === 'sent') {
    const send = transfer.sends[transfer.sends.length - 1];
    return { ...entry, conclusion: 'pending-transfer', owner: send.lead, detail: `转接 ${transfer.ref} ${send.from}→${send.to} 已转出，医疗点接收回执未到`, stuckAt: 'accept' };
  }
  if (records.length) {
    if (points.length === 1) return { ...entry, conclusion: 'verified', points, owner: null };
    return { ...entry, conclusion: 'conflict', candidates: points, owner: round.leader, detail: '同一张卡在多个集合点被扫到，没有可确定去向的有效移交，暂挂候选点位' };
  }
  if (heldRecords.length) {
    return { ...entry, conclusion: 'pending-attribution', owner: round.leader, detail: '校时记录不足以确定归属（可能跨轮次边界），不计入本轮清点', held: heldRecords.map((r) => r.id) };
  }
  const segments = openSegmentsForRound(state, round.id);
  if (segments.length) {
    return { ...entry, conclusion: 'pending-evidence', owner: round.leader, detail: '仍有离线段未收齐，只缺终端证据', segments: segments.map((s) => s.id) };
  }
  return { ...entry, conclusion: 'missing', owner: round.leader, detail: '仍待发现' };
}

function conclusionsOf(persons) {
  return Object.fromEntries(persons.map((p) => [p.person, p.conclusion]));
}

function pendingCorrections(state, roundId, persons) {
  const sheet = state.sheets[roundId];
  if (!sheet || !sheet.stages.length) return [];
  const last = sheet.stages[sheet.stages.length - 1];
  const now = conclusionsOf(persons);
  const out = [];
  for (const p of new Set([...Object.keys(last.conclusions), ...Object.keys(now)])) {
    const from = last.conclusions[p] ?? '(未列入)';
    const to = now[p] ?? '(移出)';
    if (from === to) continue;
    const claim = state.claims[roundId]?.[p];
    const claimed = claim && claim.from === from && claim.to === to;
    out.push({ person: p, from, to, sinceStage: last.stage, claimed: !!claimed, claim: claimed ? claim : null });
  }
  return out;
}

export function computeSheet(state, roundId) {
  const round = state.rounds[roundId];
  if (!round) throw new Error(`未知轮次 ${roundId}`);
  attributeAll(state);
  const expected = new Map();
  for (const a of Object.values(state.assignments)) {
    if (a.round !== roundId) continue;
    if (!expected.has(a.person)) expected.set(a.person, { person: a.person, cards: [] });
    expected.get(a.person).cards.push(a.card);
  }
  const reroutes = state.reroutes.filter((r) => r.round === roundId);
  const persons = [...expected.values()]
    .map((exp) => personEntry(state, round, exp, reroutes))
    .sort((a, b) => (a.person < b.person ? -1 : 1));
  // 本轮有归属记录但不在名册期望里的额外人员（如临时加入尚未补牌）
  const seen = new Set(expected.keys());
  const extras = [];
  for (const rec of Object.values(state.records)) {
    const at = rec.attribution;
    if (at?.status === 'attributed' && at.round === roundId && !seen.has(at.person)) {
      let ex = extras.find((e) => e.person === at.person);
      if (!ex) { ex = { person: at.person, records: [], points: new Set() }; extras.push(ex); }
      ex.records.push(rec.id);
      ex.points.add(rec.point);
    }
  }
  for (const ex of extras) { ex.points = [...ex.points].sort(); ex.records.sort(); }
  // 暂挂：归属未定且可能属于本轮的源记录
  const held = Object.values(state.records)
    .filter((r) => r.attribution?.status === 'undetermined' && possibleRounds(state, r).includes(roundId))
    .map((r) => ({
      record: r.id, card: r.card, point: r.point, reason: r.attribution.reason,
      wall: r.attribution.wall?.map(fmt),
      candidates: r.attribution.candidates.map((c) => ({ round: c.round, person: c.person, contained: c.contained })),
    }))
    .sort((a, b) => (a.record < b.record ? -1 : 1));
  const openSegments = openSegmentsForRound(state, roundId);
  const transfers = Object.values(state.transfers).filter((t) => t.round === roundId).map(transferView);
  const corrections = pendingCorrections(state, roundId, persons);
  const summary = {};
  for (const p of persons) summary[p.conclusion] = (summary[p.conclusion] ?? 0) + 1;
  return {
    round: roundId, area: round.area, leader: round.leader, checkpoints: round.checkpoints,
    window: [round.startText, round.endText], generatedAt: new Date().toISOString(),
    persons, extras, held, openSegments, transfers, corrections,
    anomalies: state.anomalies, summary,
    sealed: state.sheets[roundId]?.sealed ?? null,
    stages: (state.sheets[roundId]?.stages ?? []).length,
  };
}

// ------------------------------------------------------------------
// 签收、更正认领与封单
// ------------------------------------------------------------------

export function signStage(state, roundId, leader) {
  const round = state.rounds[roundId];
  if (!round) throw new Error(`未知轮次 ${roundId}`);
  if (leader !== round.leader) throw new Error(`领队不符：${roundId}（${round.area}）的领队是 ${round.leader}，不能由 ${leader} 签收`);
  const view = computeSheet(state, roundId);
  const sheet = state.sheets[roundId] ?? (state.sheets[roundId] = { stages: [], sealed: null });
  // 已签阶段单保有当时的点位及资料，之后不得修改
  const stage = {
    stage: sheet.stages.length + 1, leader, signedAt: new Date().toISOString(),
    conclusions: conclusionsOf(view.persons), persons: view.persons,
    held: view.held, openSegments: view.openSegments, transfers: view.transfers, summary: view.summary,
  };
  sheet.stages.push(stage);
  return stage;
}

export function claimCorrection(state, roundId, person, leader) {
  const round = state.rounds[roundId];
  if (!round) throw new Error(`未知轮次 ${roundId}`);
  if (leader !== round.leader) throw new Error(`领队不符：${roundId}（${round.area}）的领队是 ${round.leader}，不能由 ${leader} 认领`);
  const view = computeSheet(state, roundId);
  const target = view.corrections.find((c) => c.person === person && !c.claimed);
  if (!target) throw new Error(`${person} 在 ${roundId} 没有待认领的更正`);
  const claims = state.claims[roundId] ?? (state.claims[roundId] = {});
  claims[person] = { from: target.from, to: target.to, leader, at: new Date().toISOString() };
  return claims[person];
}

export function sealSheet(state, roundId, leader) {
  const round = state.rounds[roundId];
  if (!round) throw new Error(`未知轮次 ${roundId}`);
  if (leader !== round.leader) throw new Error(`领队不符：${roundId}（${round.area}）的领队是 ${round.leader}，不能由 ${leader} 封单`);
  const view = computeSheet(state, roundId);
  const reasons = [];
  for (const p of view.persons) {
    if (PENDING_KINDS.includes(p.conclusion)) reasons.push(`${p.person} 仍为「${LABELS[p.conclusion]}」`);
  }
  for (const h of view.held) reasons.push(`暂挂记录 ${h.record} 归属未定（${h.reason}）`);
  for (const s of view.openSegments) {
    reasons.push(`离线段未收齐 ${s.id}：缺 ${JSON.stringify(s.missing)}，完成标记${s.endReceived ? '已到' : '未到'}`);
  }
  for (const c of view.corrections.filter((c) => !c.claimed)) reasons.push(`更正未认领 ${c.person}：${c.from} → ${c.to}`);
  if (reasons.length) return { ok: false, reasons };
  const sheet = state.sheets[roundId] ?? (state.sheets[roundId] = { stages: [], sealed: null });
  sheet.sealed = {
    leader, at: new Date().toISOString(),
    conclusions: conclusionsOf(view.persons), persons: view.persons, summary: view.summary,
  };
  return { ok: true, sealed: sheet.sealed };
}

// ------------------------------------------------------------------
// 值守台：每片区域由谁继续跟进、哪条离线段还等接收、转接停在哪一方
// ------------------------------------------------------------------

export function dutyStatus(state) {
  const areas = [];
  for (const round of Object.values(state.rounds)) {
    const view = computeSheet(state, round.id);
    const followUps = [];
    for (const p of view.persons) {
      if (p.conclusion === 'verified' || p.conclusion === 'transferred') continue;
      followUps.push({ person: p.person, kind: p.conclusion, kindLabel: LABELS[p.conclusion], owner: p.owner ?? round.leader, detail: p.detail });
    }
    for (const c of view.corrections.filter((c) => !c.claimed)) {
      followUps.push({ person: c.person, kind: 'correction-unclaimed', kindLabel: '更正待认领', owner: round.leader, detail: `${c.from} → ${c.to}` });
    }
    areas.push({ round: round.id, area: round.area, leader: round.leader, sealed: !!view.sealed, followUps });
  }
  const segments = Object.values(state.batches)
    .map((b) => ({
      id: b.id, device: b.device, boot: b.boot, through: b.through, endReceived: b.end,
      confirmedThrough: b.confirmedThrough, missing: missingRanges(b), replays: b.replays,
    }))
    .filter((s) => s.missing.length || !s.endReceived)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const transfers = Object.values(state.transfers)
    .map(transferView)
    .filter((t) => t.status === 'sent');
  return { areas, segments, transfers, anomalies: state.anomalies };
}

// ------------------------------------------------------------------
// 溯源：从当前或已签清点单定位到牌号分配、源记录和演练轮次
// ------------------------------------------------------------------

function fmtWall(attr) {
  if (!attr) return null;
  return { ...attr, wall: attr.wall?.map(fmt) };
}

export function trace(state, roundId, person) {
  const assignments = Object.values(state.assignments).filter((a) => a.person === person && a.round === roundId);
  const cards = assignments.map((a) => a.card);
  const records = Object.values(state.records)
    .filter((r) => cards.includes(r.card))
    .map((r) => ({
      id: r.id, device: r.device, boot: r.boot, seq: r.seq, card: r.card, point: r.point,
      tick: r.tick, origins: r.origins, attribution: fmtWall(r.attribution),
    }))
    .filter((r) => r.attribution?.status !== 'attributed' || (r.attribution.round === roundId && r.attribution.person === person))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const transfers = Object.values(state.transfers).filter((t) => t.person === person && t.round === roundId).map(transferView);
  const reroutes = state.reroutes.filter((r) => r.round === roundId && r.person === person);
  const stages = (state.sheets[roundId]?.stages ?? []).map((s) => ({
    stage: s.stage, signedAt: s.signedAt, leader: s.leader,
    conclusion: s.conclusions[person] ?? '(未列入)',
    points: s.persons.find((p) => p.person === person)?.points ?? null,
    evidence: s.persons.find((p) => p.person === person)?.evidence ?? null,
  }));
  const claim = state.claims[roundId]?.[person] ?? null;
  const current = computeSheet(state, roundId).persons.find((p) => p.person === person) ?? null;
  return { person, round: roundId, assignments, records, transfers, reroutes, stages, claim, current };
}

export function locateRecord(state, id) {
  const rec = state.records[id];
  if (!rec) return null;
  const batch = state.batches[batchId(rec.device, rec.boot)];
  return {
    ...rec,
    attribution: fmtWall(rec.attribution),
    batch: batch ? { through: batch.through, end: batch.end, confirmedThrough: batch.confirmedThrough } : null,
  };
}

// ------------------------------------------------------------------
// 本地台账操作：志愿者申请改派通道、给临时加入的演练人员补牌
// ------------------------------------------------------------------

export function requestReroute(state, { round, person, toPoint, by }) {
  const r = state.rounds[round];
  if (!r) throw new Error(`未知轮次 ${round}`);
  if (!r.checkpoints.includes(toPoint)) throw new Error(`${toPoint} 不是 ${round}（${r.area}）的点位`);
  const entry = { round, person, toPoint, by, at: new Date().toISOString() };
  state.reroutes.push(entry);
  return entry;
}

export function issueCard(state, { round, person, card, by }) {
  const r = state.rounds[round];
  if (!r) throw new Error(`未知轮次 ${round}`);
  const key = cardKey(card, round);
  const existing = state.assignments[key];
  if (existing) throw new Error(`牌 ${card} 在 ${round} 已分配给 ${existing.person}，不能重复补牌`);
  state.assignments[key] = {
    card, person, round, validStart: r.start, validEnd: r.end,
    local: true, by, issuedAt: new Date().toISOString(),
  };
  return state.assignments[key];
}

// ------------------------------------------------------------------
// 重启复核：从已保存的源记录日志重放，复核归属与已确认段
// ------------------------------------------------------------------

export function reapplyEntry(state, entry) {
  switch (entry.kind) {
    case 'rounds': return ingestRounds(state, entry.payload);
    case 'cards': return ingestCards(state, entry.payload);
    case 'devices': return ingestDevices(state, entry.payload);
    case 'calibration': return ingestCalibration(state, entry.payload);
    case 'memory': return ingestMemory(state, entry.device, entry.boot, entry.payload);
    case 'replay': return ingestReplay(state, entry.device, entry.boot, entry.from, entry.to, entry.status, entry.payload);
    case 'transfers': return ingestTransfers(state, entry.payload);
    case 'confirm': {
      const b = ensureBatch(state, entry.device, entry.boot);
      b.confirmedThrough = Math.max(b.confirmedThrough, entry.through);
      b.confirms.push({ through: entry.through, at: entry.at });
      return undefined;
    }
    default: return undefined;
  }
}

export function reverify(state, logEntries) {
  const rebuilt = initialState();
  for (const e of logEntries) reapplyEntry(rebuilt, e);
  attributeAll(rebuilt);
  attributeAll(state);
  const mismatches = [];
  const localOnly = [];
  const roundIds = new Set([...Object.keys(state.rounds), ...Object.keys(rebuilt.rounds)]);
  for (const r of roundIds) {
    const a = conclusionsOf(computeSheet(state, r).persons);
    const b = conclusionsOf(computeSheet(rebuilt, r).persons);
    for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[n] ?? null) === (b[n] ?? null)) continue;
      // 本地台账（补牌、改派）不来自源记录日志，属预期差异，单独列出
      if ((b[n] ?? null) === null) {
        const assns = Object.values(state.assignments).filter((x) => x.person === n && x.round === r);
        if (assns.length && assns.every((x) => x.local)) {
          localOnly.push({ round: r, person: n, current: a[n] });
          continue;
        }
      }
      mismatches.push({ round: r, person: n, current: a[n] ?? null, fromLog: b[n] ?? null });
    }
  }
  const inLog = new Set();
  for (const e of logEntries) {
    const entries = e.kind === 'memory' ? e.payload?.entries
      : e.kind === 'replay' && e.status === 200 ? (Array.isArray(e.payload) ? e.payload : e.payload?.entries)
        : null;
    for (const x of entries ?? []) inLog.add(recordId(e.device, e.boot, x.seq));
  }
  const missingFromLog = Object.keys(state.records).filter((id) => !inLog.has(id));
  // 已确认回收的连续号，其归属必须能从已保存源记录复核为“已确定”
  const confirmedViolations = [];
  for (const b of Object.values(rebuilt.batches)) {
    for (let s = 1; s <= b.confirmedThrough; s += 1) {
      const id = b.received[s];
      const a = id ? rebuilt.records[id]?.attribution : null;
      if (!a || (a.status !== 'attributed' && a.status !== 'invalid')) {
        confirmedViolations.push({ batch: b.id, seq: s, status: a?.status ?? 'missing' });
      }
    }
  }
  return {
    ok: !mismatches.length && !missingFromLog.length && !confirmedViolations.length,
    mismatches, missingFromLog, confirmedViolations, localOnly,
    checkedRecords: Object.keys(state.records).length,
  };
}
