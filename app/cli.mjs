#!/usr/bin/env node
// 演练清点值守工具命令行。
// 用法：node app/cli.mjs [--data 目录] [--json] <命令> [参数]
//   sync --source URL            从本地合成来源同步一轮（拉取缓冲、补取缺片、确认连续号）
//   sheet --round R10            查看某轮次区域的当前清点单
//   status                       值守台总览：区域跟进人、待接收离线段、转接停滞方
//   sign   --round R10 --leader L1   领队签收阶段清单（保有当时点位及资料）
//   claim  --round R10 --person X1 --leader L1   领队认领晚到扫描带来的更正
//   seal   --round R10 --leader L1   封清点单（存在未决项时拒绝并列出原因）
//   trace  --round R10 --person X9   溯源：牌号分配、源记录、转接、签收历史
//   record --id 'A|R9|3'         定位单条源记录及其归属判定
//   stages --round R10           查看已签阶段单
//   reverify                     从已保存源记录复核全部归属与已确认段
//   reroute --round R10 --person X1 --to-point E1 --by V5   志愿者申请改派通道
//   issue-card --round R11 --person X7 --card 900 --by V3   给临时加入人员补牌

import { computeSheet, dutyStatus, issueCard, LABELS, locateRecord, requestReroute, reverify, sealSheet, signStage, claimCorrection, trace } from './core.mjs';
import { SourceClient, syncOnce } from './client.mjs';
import { printSheet, printStatus } from './report.mjs';
import { Store } from './store.mjs';

const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (key === 'json') { opts.json = true; continue; }
    opts[key] = argv[i + 1];
    i += 1;
  } else positional.push(argv[i]);
}
const [command] = positional;
const dataDir = opts.data ?? './drill-data';

function out(value) {
  if (opts.json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

async function main() {
  if (!command) {
    console.log('用法：node app/cli.mjs [--data 目录] [--json] <sync|sheet|status|sign|claim|seal|trace|record|stages|reverify|reroute|issue-card>');
    process.exit(1);
  }
  const store = Store.open(dataDir);
  const state = store.state;
  let dirty = false;

  switch (command) {
    case 'sync': {
      const client = new SourceClient(opts.source ?? 'http://127.0.0.1:4173');
      await syncOnce(state, client, (entry) => store.appendLog(entry));
      dirty = true;
      out(`已同步（第 ${state.stats.syncs} 轮）：源记录 ${Object.keys(state.records).length} 条，重复补交 ${state.stats.duplicates} 条${store.recovered ? `，崩溃恢复重放 ${store.recovered} 条` : ''}`);
      break;
    }
    case 'sheet': out(opts.json ? computeSheet(state, opts.round) : printSheet(computeSheet(state, opts.round))); break;
    case 'status': out(opts.json ? dutyStatus(state) : printStatus(dutyStatus(state))); break;
    case 'sign': {
      const stage = signStage(state, opts.round, opts.leader);
      dirty = true;
      out(`已签收阶段单 #${stage.stage}（${opts.round}，领队 ${stage.leader}）：${Object.entries(stage.summary).map(([k, n]) => `${LABELS[k] ?? k} ${n}`).join('，') || '（无）'}`);
      break;
    }
    case 'claim': {
      const claim = claimCorrection(state, opts.round, opts.person, opts.leader);
      dirty = true;
      out(`${opts.leader} 已认领更正：${opts.person} ${claim.from} → ${claim.to}`);
      break;
    }
    case 'seal': {
      const result = sealSheet(state, opts.round, opts.leader);
      if (!result.ok) {
        out(`无法封单 ${opts.round}，仍有未决项：\n  ${result.reasons.join('\n  ')}`);
        process.exitCode = 2;
      } else {
        dirty = true;
        out(`已封单 ${opts.round}（${opts.leader}）：${Object.entries(result.sealed.summary).map(([k, n]) => `${LABELS[k] ?? k} ${n}`).join('，') || '（无）'}`);
      }
      break;
    }
    case 'trace': out(trace(state, opts.round, opts.person)); break;
    case 'record': out(locateRecord(state, opts.id) ?? `未找到源记录 ${opts.id}`); break;
    case 'stages': out(state.sheets[opts.round]?.stages ?? `尚无已签阶段单`); break;
    case 'reverify': {
      const report = reverify(state, store.entries);
      out(opts.json ? report : [
        `复核源记录 ${report.checkedRecords} 条：${report.ok ? '全部一致' : '存在差异'}`,
        ...report.mismatches.map((m) => `  结论不一致 ${m.round}/${m.person}：当前 ${m.current}，日志复核 ${m.fromLog}`),
        ...report.missingFromLog.map((id) => `  源记录缺失 ${id}`),
        ...report.confirmedViolations.map((v) => `  已确认段归属不可复核 ${v.batch}#${v.seq}（${v.status}）`),
        ...(report.localOnly ?? []).map((l) => `  本地台账（不在源记录内）${l.round}/${l.person}：${l.current}`),
      ].join('\n'));
      if (!report.ok) process.exitCode = 3;
      break;
    }
    case 'reroute': {
      const entry = requestReroute(state, { round: opts.round, person: opts.person, toPoint: opts['to-point'], by: opts.by });
      dirty = true;
      out(`已登记改派：${entry.person} 在 ${entry.round} 改走 ${entry.toPoint}（申请人 ${entry.by}）`);
      break;
    }
    case 'issue-card': {
      const card = issueCard(state, { round: opts.round, person: opts.person, card: opts.card, by: opts.by });
      dirty = true;
      out(`已补牌：${card.person} 在 ${card.round} 领牌 ${card.card}（经办 ${card.by}）`);
      break;
    }
    default:
      console.error(`未知命令 ${command}`);
      process.exit(1);
  }
  if (dirty) store.save();
}

main().catch((error) => {
  console.error(`出错：${error.message}`);
  process.exit(1);
});
