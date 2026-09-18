// 事件存储：append-only JSONL 日志 + 启动回放。
// 所有变更先过 transact：命令函数同步产生事件、立即作用于内存态，
// 随后整批落盘；写队列串行化，保证并发请求下事件顺序确定。
// 停机恢复后重启回放同一日志，未完成的通知与确认因此继续存在。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, reduce } from './domain.mjs';

export class EventStore {
  constructor(dataDir, { now } = {}) {
    this.dataDir = dataDir;
    this.logPath = join(dataDir, 'events.jsonl');
    this.now = now || (() => new Date().toISOString());
    this.state = initialState();
    this.seq = 0;
    this._queue = Promise.resolve();
  }

  async load() {
    this.state = initialState();
    this.seq = 0;
    await mkdir(this.dataDir, { recursive: true });
    let text = '';
    try {
      text = await readFile(this.logPath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      reduce(this.state, event);
      this.seq = Math.max(this.seq, event.seq || 0);
    }
    return this;
  }

  // fn(state, emit) 同步执行：emit 立即 reduce 到内存态并收集，
  // fn 返回后整批追加到日志。fn 内可基于最新状态做“检查-再写入”。
  async transact(fn) {
    const run = async () => {
      const emitted = [];
      const emit = (event) => {
        const full = { ...event, seq: ++this.seq, ts: event.ts || this.now() };
        reduce(this.state, full);
        emitted.push(full);
      };
      const result = (await fn(this.state, emit)) ?? null;
      if (emitted.length) {
        try {
          await appendFile(this.logPath, emitted.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        } catch (err) {
          await this.load(); // 落盘失败则回滚到磁盘状态，避免内存与日志分叉
          throw err;
        }
      }
      return { result, events: emitted };
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }
}
