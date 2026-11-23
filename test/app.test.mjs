import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSource } from '../sources/source.mjs';
import {
  attributeAll, computeSheet, dutyStatus, ingestCalibration, ingestCards, ingestDevices,
  ingestMemory, ingestRounds, ingestTransfers, initialState, issueCard, missingRanges,
  requestReroute, reverify, sealSheet, signStage, claimCorrection, trace,
} from '../app/core.mjs';
import { SourceClient, syncOnce } from '../app/client.mjs';
import { Store } from '../app/store.mjs';

async function setup() {
  const server = createSource();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new SourceClient(base);
  const dir = mkdtempSync(join(tmpdir(), 'drill-test-'));
  const store = Store.open(dir);
  const sync = async () => { await syncOnce(store.state, client, (e) => store.appendLog(e)); store.save(); };
  const setStep = async (step) => {
    const res = await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
    assert.equal(res.status, 200);
  };
  return { server, client, store, sync, setStep, base };
}

const personMap = (view) => Object.fromEntries(view.persons.map((p) => [p.person, p]));
const conclusions = (view) => Object.fromEntries(view.persons.map((p) => [p.person, p.conclusion]));

test('演练全流程：离线段、归属未定、转接未收、签收更正与封单', async (t) => {
  const { server, store, sync, setStep, base } = await setup();
  t.after(() => server.close());
  const state = store.state;

  // gather：完成标记先于缺失中段到达
  await sync();
  let r10 = computeSheet(state, 'R10');
  let people = personMap(r10);
  assert.equal(people.X9.conclusion, 'verified');
  assert.deepEqual(people.X9.points, ['E1']);
  assert.equal(people['X1'] === undefined, false);
  assert.equal(people.X1.conclusion, 'pending-evidence', '缺片未补取前，X1 只缺终端证据而非仍待发现');
  assert.equal(people.X3.conclusion, 'pending-attribution', '校时跨轮次边界不能擅取中点');
  assert.equal(people.X1.owner, 'L1');
  let r11 = computeSheet(state, 'R11');
  assert.equal(personMap(r11).X4.conclusion, 'verified');
  const r11AtGather = conclusions(r11);

  // 序号完整性：A 缺 [2,2]，B 完成标记未到；连续号确认到已确定归属处
  assert.deepEqual(missingRanges(state.batches['A|R9']), [[2, 2]]);
  assert.equal(state.batches['A|R9'].end, true, '完成标记先于缺失中段到达');
  assert.equal(state.batches['A|R9'].confirmedThrough, 1);
  assert.equal(state.batches['A|R9'].replays['2-2'], 'pending', '异常段已单独补取，等待来源就绪');
  assert.equal(state.batches['B|F2'].end, false);
  assert.equal(state.batches['B|F2'].confirmedThrough, 1);
  const calls = await (await fetch(`${base}/_source_calls`)).json();
  const confirms = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/confirm'));
  assert.ok(confirms.some((c) => c.path === '/devices/A/confirm' && c.body === JSON.stringify({ boot: 'R9', through: 1 })));
  assert.ok(confirms.some((c) => c.path === '/devices/B/confirm' && c.body === JSON.stringify({ boot: 'F2', through: 1 })));

  // 值守台：每片区域的跟进人、待接收离线段
  let status = dutyStatus(state);
  const areaR10 = status.areas.find((a) => a.round === 'R10');
  assert.ok(areaR10.followUps.some((f) => f.person === 'X1' && f.owner === 'L1'));
  assert.ok(areaR10.followUps.some((f) => f.person === 'X3' && f.kind === 'pending-attribution'));
  assert.deepEqual(status.segments.find((s) => s.id === 'A|R9').missing, [[2, 2]]);
  assert.equal(status.segments.find((s) => s.id === 'B|F2').endReceived, false);
  assert.equal(status.transfers.length, 0);

  // 重复同步：同一条扫描两次补交不能算两个人
  const before = Object.keys(state.records).length;
  await sync();
  assert.equal(Object.keys(state.records).length, before);
  assert.ok(state.stats.duplicates >= 3, '重复补交被去重');
  assert.deepEqual(conclusions(computeSheet(state, 'R10')), conclusions(r10));

  // reroute：转接单已批，医疗点回执未到
  await setStep('reroute');
  await sync();
  r10 = computeSheet(state, 'R10');
  people = personMap(r10);
  assert.equal(people.X9.conclusion, 'pending-transfer');
  assert.equal(people.X9.owner, 'L1', '转出未收时负责确认的人有明确归属');
  status = dutyStatus(state);
  assert.equal(status.transfers.length, 1);
  assert.equal(status.transfers[0].ref, 'MED-2');
  assert.equal(status.transfers[0].stuckAt, 'accept', '转接停在医疗点接收方');
  assert.equal(status.transfers[0].owner, 'L1');

  // seal：领队签收阶段清单；存在未决项时不能封单
  await setStep('seal');
  await sync();
  assert.throws(() => signStage(state, 'R10', 'L2'), /领队不符/);
  const stage = signStage(state, 'R10', 'L1');
  assert.equal(stage.conclusions.X1, 'pending-evidence');
  assert.equal(stage.conclusions.X9, 'pending-transfer');
  assert.ok(sealSheet(state, 'R10', 'L1').ok === false, '未决项存在时拒绝封单');

  // catchup：缺片补取到位、回执到达，晚到扫描更正当前清点
  await setStep('catchup');
  await sync();
  r10 = computeSheet(state, 'R10');
  people = personMap(r10);
  assert.equal(people.X1.conclusion, 'verified');
  assert.deepEqual(people.X1.points, ['E2']);
  assert.equal(people.X9.conclusion, 'transferred');
  assert.equal(people.X9.at, 'MED');
  assert.equal(state.batches['A|R9'].confirmedThrough, 2, '缺失段补齐后连续号确认推进；#3 归属未定不确认');
  const unclaimed = r10.corrections.filter((c) => !c.claimed);
  assert.deepEqual(unclaimed.map((c) => c.person).sort(), ['X1', 'X9'], '晚到证据形成待认领更正');
  assert.equal(state.sheets.R10.stages.length, 1, '原签收阶段单保留，查找安排不被抹掉');
  assert.equal(state.sheets.R10.stages[0].conclusions.X1, 'pending-evidence');
  claimCorrection(state, 'R10', 'X1', 'L1');
  assert.throws(() => claimCorrection(state, 'R10', 'X9', 'L2'), /领队不符/);
  claimCorrection(state, 'R10', 'X9', 'L1');
  r10 = computeSheet(state, 'R10');
  assert.equal(r10.corrections.filter((c) => !c.claimed).length, 0);
  const sealR10 = sealSheet(state, 'R10', 'L1');
  assert.equal(sealR10.ok, false);
  assert.ok(sealR10.reasons.some((r) => r.includes('X3')), 'X3 归属未定仍阻止封单');
  const sealR11 = sealSheet(state, 'R11', 'L2');
  assert.equal(sealR11.ok, false);
  assert.ok(sealR11.reasons.some((r) => r.includes('B|F2')), 'B 批完成标记未到仍阻止封单');

  // following：设备按已确认连续号回收缓存，本地源记录已留存
  await setStep('following');
  await sync();
  assert.deepEqual(conclusions(computeSheet(state, 'R11')), r11AtGather, '旧轮补录不改变下一轮的所在队列');
  assert.equal(personMap(computeSheet(state, 'R10')).X3.conclusion, 'pending-attribution');

  // 重启复核：从已保存源记录重放，归属一致
  const report = reverify(state, store.entries);
  assert.equal(report.ok, true, JSON.stringify(report));
  const reopened = Store.open(store.dir);
  assert.deepEqual(conclusions(computeSheet(reopened.state, 'R10')), conclusions(computeSheet(state, 'R10')));

  // 模拟崩溃：日志已写、状态未存，重启后重放补齐
  reopened.appendLog({ kind: 'memory', device: 'A', boot: 'R9', payload: { through: 3, end: true, entries: [{ device: 'A', boot: 'R9', seq: 2, tick: 1000, card: '501', point: 'E2' }] } });
  const recovered = Store.open(store.dir);
  assert.equal(recovered.recovered, 1);
  assert.equal(personMap(computeSheet(recovered.state, 'R10')).X1.conclusion, 'verified');

  // 溯源：从清点单定位牌号分配、源记录与演练轮次
  const t9 = trace(state, 'R10', 'X9');
  assert.equal(t9.assignments[0].card, '458');
  assert.deepEqual(t9.records.map((r) => r.id), ['A|R9|1']);
  assert.equal(t9.records[0].attribution.round, 'R10');
  assert.equal(t9.transfers[0].ref, 'MED-2');
  assert.equal(t9.transfers[0].status, 'received');
  assert.equal(t9.stages.length, 1, '已签阶段单同样可溯源');
});

test('校时不足以确定归属时补传记录不计入清点', () => {
  const state = initialState();
  ingestRounds(state, [{ id: 'R1', start: '10:00:00', end: '10:30:00', area: '厅', leader: 'L1', checkpoints: ['P1'] }]);
  ingestCards(state, [{ card: 'C1', person: 'W1', round: 'R1', valid: ['10:00:00', '10:30:00'] }]);
  ingestDevices(state, [{ device: 'D', boot: 'B1', path: '/x' }]);
  ingestMemory(state, 'D', 'B1', { through: 1, end: true, entries: [{ device: 'D', boot: 'B1', seq: 1, tick: 60, card: 'C1', point: 'P1' }] });
  attributeAll(state);
  assert.equal(state.records['D|B1|1'].attribution.status, 'undetermined');
  assert.equal(personMap(computeSheet(state, 'R1')).W1.conclusion, 'pending-attribution');
  // 校时记录到达后，同一源记录可复核并计入
  ingestCalibration(state, [{ device: 'D', boot: 'B1', atTick: 0, earliest: '10:00:00', latest: '10:00:00', tickUnit: 'second' }]);
  assert.equal(personMap(computeSheet(state, 'R1')).W1.conclusion, 'verified');
});

test('同一轮次两个集合点扫到同一张卡：无有效移交时暂挂两个候选点位', () => {
  const state = initialState();
  ingestRounds(state, [{ id: 'R1', start: '10:00:00', end: '10:30:00', area: '厅', leader: 'L1', checkpoints: ['P1', 'P2', 'MED'] }]);
  ingestCards(state, [{ card: 'C1', person: 'W1', round: 'R1', valid: ['10:00:00', '10:30:00'] }]);
  ingestDevices(state, [{ device: 'D', boot: 'B1', path: '/x' }]);
  ingestCalibration(state, [{ device: 'D', boot: 'B1', atTick: 0, earliest: '10:00:00', latest: '10:00:00', tickUnit: 'second' }]);
  ingestMemory(state, 'D', 'B1', {
    through: 2, end: true,
    entries: [
      { device: 'D', boot: 'B1', seq: 1, tick: 60, card: 'C1', point: 'P1' },
      { device: 'D', boot: 'B1', seq: 2, tick: 600, card: 'C1', point: 'P2' },
    ],
  });
  let w1 = personMap(computeSheet(state, 'R1')).W1;
  assert.equal(w1.conclusion, 'conflict');
  assert.deepEqual(w1.candidates, ['P1', 'P2'], '暂挂两个候选点位，不凭最新到达挑一个');
  // 转接单批准但回执未到：转出未收，归属批准领队
  ingestTransfers(state, [{ ref: 'T1', op: 'send', round: 'R1', person: 'W1', from: 'P1', to: 'P2', at: '10:03:00', lead: 'L1' }]);
  w1 = personMap(computeSheet(state, 'R1')).W1;
  assert.equal(w1.conclusion, 'pending-transfer');
  assert.equal(w1.owner, 'L1');
  // 接收回执接回转接单：有效移交成立，去向确定
  ingestTransfers(state, [{ ref: 'T1', op: 'accept', round: 'R1', point: 'P2', at: '10:04:00', lead: 'L9' }]);
  w1 = personMap(computeSheet(state, 'R1')).W1;
  assert.equal(w1.conclusion, 'transferred');
  assert.equal(w1.at, 'P2');
});

test('补交去重、内容冲突与孤儿回执都记异常', () => {
  const state = initialState();
  ingestRounds(state, [{ id: 'R1', start: '10:00:00', end: '10:30:00', area: '厅', leader: 'L1', checkpoints: ['P1'] }]);
  ingestCards(state, [{ card: 'C1', person: 'W1', round: 'R1', valid: ['10:00:00', '10:30:00'] }]);
  ingestDevices(state, [{ device: 'D', boot: 'B1', path: '/x' }]);
  const payload = { through: 1, end: true, entries: [{ device: 'D', boot: 'B1', seq: 1, tick: 60, card: 'C1', point: 'P1' }] };
  ingestMemory(state, 'D', 'B1', payload);
  ingestMemory(state, 'D', 'B1', payload);
  assert.equal(state.stats.duplicates, 1, '同一条扫描两次补交只算一条');
  assert.equal(Object.keys(state.records).length, 1);
  // 同序号不同内容：保留先到的源记录并记异常
  ingestMemory(state, 'D', 'B1', { through: 2, end: true, entries: [{ device: 'D', boot: 'B1', seq: 1, tick: 61, card: 'C9', point: 'P1' }] });
  assert.equal(state.records['D|B1|1'].tick, 60);
  assert.ok(state.anomalies.some((a) => a.kind === 'conflicting-record'));
  // 接收回执找不到对应转接单
  ingestTransfers(state, [{ ref: 'TX', op: 'accept', round: 'R1', point: 'MED', at: '10:01:00', lead: 'L9' }]);
  assert.ok(state.anomalies.some((a) => a.kind === 'orphan-accept' && a.ref === 'TX'));
  assert.ok(dutyStatus(state).anomalies.length >= 2);
});

test('志愿者改派通道与临时补牌进入本地台账', () => {
  const state = initialState();
  ingestRounds(state, [{ id: 'R1', start: '10:00:00', end: '10:30:00', area: '厅', leader: 'L1', checkpoints: ['P1', 'P2'] }]);
  ingestCards(state, [{ card: 'C1', person: 'W1', round: 'R1', valid: ['10:00:00', '10:30:00'] }]);
  const card = issueCard(state, { round: 'R1', person: 'W9', card: 'C8', by: 'V3' });
  assert.equal(card.local, true);
  assert.throws(() => issueCard(state, { round: 'R1', person: 'W8', card: 'C8', by: 'V3' }), /已分配/);
  requestReroute(state, { round: 'R1', person: 'W1', toPoint: 'P2', by: 'V5' });
  assert.throws(() => requestReroute(state, { round: 'R1', person: 'W1', toPoint: 'P9', by: 'V5' }), /不是/);
  const sheet = computeSheet(state, 'R1');
  const people = personMap(sheet);
  assert.equal(people.W9.conclusion, 'missing', '补牌人员进入清点期望');
  assert.equal(people.W1.reroute[0].toPoint, 'P2');
});

test('全部核实或确认缺失后可封单；封单保有当时资料', () => {
  const state = initialState();
  ingestRounds(state, [{ id: 'R1', start: '10:00:00', end: '10:30:00', area: '厅', leader: 'L1', checkpoints: ['P1'] }]);
  ingestCards(state, [
    { card: 'C1', person: 'W1', round: 'R1', valid: ['10:00:00', '10:30:00'] },
    { card: 'C2', person: 'W2', round: 'R1', valid: ['10:00:00', '10:30:00'] },
  ]);
  ingestDevices(state, [{ device: 'D', boot: 'B1', path: '/x' }]);
  ingestCalibration(state, [{ device: 'D', boot: 'B1', atTick: 0, earliest: '10:00:00', latest: '10:00:00', tickUnit: 'second' }]);
  ingestMemory(state, 'D', 'B1', { through: 1, end: true, entries: [{ device: 'D', boot: 'B1', seq: 1, tick: 60, card: 'C1', point: 'P1' }] });
  const sheet = computeSheet(state, 'R1');
  assert.equal(personMap(sheet).W1.conclusion, 'verified');
  assert.equal(personMap(sheet).W2.conclusion, 'missing', '离线段收齐后仍无证据即真的少了');
  const result = sealSheet(state, 'R1', 'L1');
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(result.sealed.conclusions.W2, 'missing', '封单记录真实缺失结论');
  assert.equal(computeSheet(state, 'R1').sealed.leader, 'L1');
});
