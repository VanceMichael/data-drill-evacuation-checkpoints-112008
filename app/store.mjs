// 本地持久化：state.json（台账状态，原子写）+ source-log.jsonl（源记录日志，追加写）。
// 源记录先落日志再改状态；重启时把日志中尚未应用的条目重放补齐，
// 保证确认回收前保存的源记录在重启后仍能复核归属。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attributeAll, initialState, reapplyEntry } from './core.mjs';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.stateFile = join(dir, 'state.json');
    this.logFile = join(dir, 'source-log.jsonl');
    this.logSeq = 0;
  }

  static open(dir) {
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    const state = existsSync(store.stateFile)
      ? JSON.parse(readFileSync(store.stateFile, 'utf8'))
      : initialState();
    const entries = existsSync(store.logFile)
      ? readFileSync(store.logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    store.logSeq = entries.reduce((n, e) => Math.max(n, e.seq ?? 0), 0);
    // 崩溃恢复：重放日志里状态尚未应用的源记录
    let recovered = 0;
    for (const entry of entries) {
      if ((entry.seq ?? 0) > (state.appliedLog ?? 0)) {
        reapplyEntry(state, entry);
        state.appliedLog = entry.seq;
        recovered += 1;
      }
    }
    if (recovered) attributeAll(state);
    store.state = state;
    store.entries = entries;
    store.recovered = recovered;
    return store;
  }

  // 追加一条源记录日志，返回其序号（先落盘，再由调用方改状态）
  appendLog(entry) {
    this.logSeq += 1;
    const full = { seq: this.logSeq, loggedAt: new Date().toISOString(), ...entry };
    appendFileSync(this.logFile, JSON.stringify(full) + '\n');
    this.entries.push(full);
    return full.seq;
  }

  save() {
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
