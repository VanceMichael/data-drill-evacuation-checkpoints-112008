// 清点单与值守台的中文文本报告，供命令行与演示脚本共用。
import { LABELS } from './core.mjs';

export function printSheet(view) {
  const lines = [];
  lines.push(`清点单 ${view.round}（${view.area}） 领队 ${view.leader} 时段 ${view.window.join('–')} 点位 ${view.checkpoints.join('/')}`);
  lines.push(`汇总：${Object.entries(view.summary).map(([k, n]) => `${LABELS[k] ?? k} ${n}`).join('，') || '（无）'}`);
  for (const p of view.persons) {
    const where = p.points ? ` @${p.points.join('/')}` : p.at ? ` @${p.at}` : '';
    const owner = p.owner ? `（跟进：${p.owner}）` : '';
    lines.push(`  ${p.person} [牌 ${p.cards.join('/')}] ${LABELS[p.conclusion]}${where}${owner}${p.detail ? ` — ${p.detail}` : ''}`);
  }
  if (view.extras.length) lines.push(`  额外人员：${view.extras.map((e) => `${e.person}@${e.points.join('/')}`).join('，')}`);
  for (const h of view.held) lines.push(`  暂挂 ${h.record}（牌 ${h.card} @${h.point}，${h.reason}，候选 ${h.candidates.map((c) => c.round).join('/')}）`);
  for (const s of view.openSegments) {
    lines.push(`  离线段 ${s.id}：缺 ${JSON.stringify(s.missing)}，完成标记${s.endReceived ? '已到' : '未到'}，已确认至 ${s.confirmedThrough}`);
  }
  for (const c of view.corrections) {
    lines.push(`  更正 ${c.person}：${c.from} → ${c.to}${c.claimed ? `（${c.claim.leader} 已认领）` : '（待领队认领）'}`);
  }
  if (view.sealed) lines.push(`  已封单：${view.sealed.leader} @ ${view.sealed.at}`);
  return lines.join('\n');
}

export function printStatus(status) {
  const lines = [];
  lines.push('值守台总览');
  for (const a of status.areas) {
    lines.push(`【${a.round} ${a.area}】领队 ${a.leader}${a.sealed ? '（已封单）' : ''}`);
    if (!a.followUps.length) lines.push('  无待跟进事项');
    for (const f of a.followUps) lines.push(`  ${f.person} ${f.kindLabel} → 跟进人 ${f.owner}（${f.detail}）`);
  }
  lines.push('待接收离线段：');
  if (!status.segments.length) lines.push('  无');
  for (const s of status.segments) {
    lines.push(`  ${s.id} 缺 ${JSON.stringify(s.missing)}，完成标记${s.endReceived ? '已到' : '未到'}，已确认至 ${s.confirmedThrough}，补取 ${JSON.stringify(s.replays)}`);
  }
  lines.push('转接停滞：');
  if (!status.transfers.length) lines.push('  无');
  for (const t of status.transfers) {
    lines.push(`  ${t.ref} ${t.person} ${t.send.from}→${t.send.to} 停在接收方（医疗点），跟进 ${t.owner}`);
  }
  if (status.anomalies.length) {
    lines.push('异常：');
    for (const a of status.anomalies) lines.push(`  ${JSON.stringify(a)}`);
  }
  return lines.join('\n');
}
