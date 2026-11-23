#!/usr/bin/env node
// 全流程演练：启动本地合成来源，按演练阶段推进，
// 演示清点工具如何处理离线段、归属未定、转接未收、晚到更正与封单。

import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../sources/source.mjs';
import { computeSheet, dutyStatus, issueCard, requestReroute, reverify, sealSheet, signStage, claimCorrection, trace } from './core.mjs';
import { SourceClient, syncOnce } from './client.mjs';
import { printSheet, printStatus } from './report.mjs';
import { Store } from './store.mjs';

const server = createSource();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const client = new SourceClient(base);
const dir = mkdtempSync(join(tmpdir(), 'drill-check-'));

const say = (text) => console.log(`\n=== ${text} ===`);
const setStep = async (step) => {
  const res = await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
  if (res.status !== 200) throw new Error(`推进演练阶段失败：${step}`);
  console.log(`\n----- 演练阶段推进到 ${step} -----`);
};

let store = Store.open(dir);
let state = store.state;
const sync = async () => {
  await syncOnce(state, client, (entry) => store.appendLog(entry));
  store.save();
};

say('演练开始：gather 阶段，疏散员沿通道扫训练牌进集合点');
await sync();
console.log(printSheet(computeSheet(state, 'R10')));
console.log(printSheet(computeSheet(state, 'R11')));
console.log(printStatus(dutyStatus(state)));
console.log('说明：A/R9 完成标记已到但缺中段 [2,2]（X1 只缺终端证据）；');
console.log('      A/R9#3 校时区间跨轮次边界，不能擅取中点，X3 归属未定暂挂；');
console.log('      B/F2 完成标记未到，R11 仍有离线段待接收。');

await setStep('reroute');
say('馆方把 X9 从 E1 转到模拟医疗点：转接单已批，接收回执未到');
await sync();
console.log(printSheet(computeSheet(state, 'R10')));
console.log(printStatus(dutyStatus(state)));

await setStep('seal');
say('领队 L1 签收 R10 阶段清单（已核实人员先交给领队，未决个案点名在册）');
signStage(state, 'R10', 'L1');
store.save();
console.log(printSheet(computeSheet(state, 'R10')));
const early = sealSheet(state, 'R10', 'L1');
console.log(`尝试封单：${early.ok ? '成功' : `被拒绝——\n  ${early.reasons.join('\n  ')}`}`);

await setStep('catchup');
say('离线扫码器补传：缺片 [2,2] 补取到位，医疗点接收回执到达');
await sync();
console.log(printSheet(computeSheet(state, 'R10')));
console.log('晚到扫描确认了 X1 的去向，当前清点已更正，待领队认领；原签收阶段单保留当时的查找安排。');
claimCorrection(state, 'R10', 'X1', 'L1');
claimCorrection(state, 'R10', 'X9', 'L1');
store.save();
console.log('L1 已认领 X1、X9 的更正。');

say('志愿者服务台：临时加入人员补牌 + 改派通道申请');
issueCard(state, { round: 'R11', person: 'X7', card: '900', by: 'V3' });
requestReroute(state, { round: 'R10', person: 'X1', toPoint: 'E1', by: 'V5' });
store.save();
console.log(printSheet(computeSheet(state, 'R11')));

await setStep('following');
say('设备按已确认连续号回收缓存（A/R9 已确认至 2，#3 归属未定不予确认）');
await sync();
console.log(printSheet(computeSheet(state, 'R10')));

say('重启值守终端，从已保存的源记录复核归属');
store = Store.open(dir);
state = store.state;
console.log(`恢复重放 ${store.recovered} 条；当前结论保持不变：`);
console.log(printSheet(computeSheet(state, 'R10')));
const report = reverify(state, store.entries);
console.log(`复核 ${report.checkedRecords} 条源记录：${report.ok ? '归属全部一致，已确认段均可复核' : JSON.stringify(report)}`);
if (report.localOnly?.length) console.log(`（本地台账 ${report.localOnly.map((l) => `${l.round}/${l.person}`).join('、')} 不来自源记录，属预期）`);

say('溯源：X9 在 R10 的牌号分配、源记录与转接链');
console.log(JSON.stringify(trace(state, 'R10', 'X9'), null, 2));

say('封单检查与值守台终态');
for (const round of ['R10', 'R11']) {
  const result = sealSheet(state, round, state.rounds[round].leader);
  console.log(`${round} 封单：${result.ok ? '成功' : `被拒绝——${result.reasons.join('；')}`}`);
}
console.log(printStatus(dutyStatus(state)));
console.log(`\n演示数据目录：${dir}（state.json 与 source-log.jsonl 可供复查）`);
server.close();
