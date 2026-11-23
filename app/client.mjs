// 上游客户端与一轮同步编排：拉取馆方发布资料与设备缓冲，
// 缺片补取、归属判定、连续号确认，全部源记录先落日志再入库。

import {
  attributeAll, batchId, ingestCalibration, ingestCards, ingestDevices, ingestMemory,
  ingestReplay, ingestRounds, ingestTransfers, missingRanges, planConfirm,
} from './core.mjs';

export class SourceClient {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
  }

  async get(path) {
    const res = await fetch(this.base + path, { redirect: 'manual' });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  }

  async post(path, obj) {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obj),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  }
}

// sink(entry) -> seq：把一条源记录落日志，返回日志序号
export async function syncOnce(state, client, sink) {
  const pull = async (kind, path, apply, extra = {}) => {
    const { status, body } = await client.get(path);
    const seq = sink({ kind, path, status, ...extra, payload: body ?? null });
    if (status === 200 && body != null) apply(body);
    state.appliedLog = Math.max(state.appliedLog, seq);
    return { status, body };
  };

  await pull('rounds', '/drill/rounds', (b) => ingestRounds(state, b));
  await pull('cards', '/drill/cards', (b) => ingestCards(state, b));
  await pull('devices', '/devices/index', (b) => ingestDevices(state, b));
  await pull('calibration', '/devices/calibration', (b) => ingestCalibration(state, b));
  await pull('transfers', '/drill/transfers', (b) => ingestTransfers(state, b));

  for (const d of Object.values(state.devices)) {
    const path = d.path ?? `/devices/${d.device}/memory`;
    await pull('memory', path, (b) => ingestMemory(state, d.device, d.boot, b), { device: d.device, boot: d.boot });
    attributeAll(state);
    // 异常段单独补取：声明内的缺失段逐段请求重放（完成标记先到也没关系）
    const batch = state.batches[batchId(d.device, d.boot)];
    for (const [from, to] of missingRanges(batch)) {
      const rpath = `/devices/${d.device}/replay?boot=${d.boot}&from=${from}&to=${to}`;
      const { status, body } = await client.get(rpath);
      const seq = sink({ kind: 'replay', path: rpath, device: d.device, boot: d.boot, from, to, status, payload: body ?? null });
      ingestReplay(state, d.device, d.boot, from, to, status, body);
      state.appliedLog = Math.max(state.appliedLog, seq);
    }
    attributeAll(state);
    // 按已确认接收的连续序号让上游回收缓存；归属未确定的段不确认
    const n = planConfirm(state, d.device, d.boot);
    if (n > batch.confirmedThrough) {
      const cpath = `/devices/${d.device}/confirm`;
      const { status } = await client.post(cpath, { boot: d.boot, through: n });
      const seq = sink({ kind: 'confirm', path: cpath, device: d.device, boot: d.boot, through: n, status, at: new Date().toISOString() });
      if (status === 200 || status === 202) {
        batch.confirmedThrough = n;
        batch.confirms.push({ through: n, at: new Date().toISOString() });
      }
      state.appliedLog = Math.max(state.appliedLog, seq);
    }
  }

  attributeAll(state);
  state.stats.syncs += 1;
  return state;
}
