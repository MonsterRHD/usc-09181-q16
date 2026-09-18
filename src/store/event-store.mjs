// JSONL 只增事件日志。任何状态修改都是追加事件；重启后重放即可恢复全部读模型，
// 因此停机期间未完成的通知/确认不会丢失。
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ConcurrencyError extends Error {
  constructor(expectedSeq, actualSeq) {
    super(`事件日志并发冲突：期望末位 seq=${expectedSeq}，实际=${actualSeq}`);
    this.name = 'ConcurrencyError';
  }
}

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
    return events;
  }

  // expectedLastSeq 为乐观并发令牌（当前日志最后一条事件的 seq，空日志为 0）
  append(newEvents, expectedLastSeq) {
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) {
        const actual = this.#tailSeq();
        if (actual !== expectedLastSeq) throw new ConcurrencyError(expectedLastSeq, actual);
      } else if (expectedLastSeq !== 0) {
        throw new ConcurrencyError(expectedLastSeq, 0);
      }
    }
    for (const e of newEvents) {
      const line = JSON.stringify(e);
      if (this.filePath) appendFileSync(this.filePath, line + '\n');
    }
    return newEvents;
  }

  #tailSeq() {
    const raw = readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return 0;
    const lastLine = raw.slice(raw.lastIndexOf('\n') + 1);
    return JSON.parse(lastLine).seq;
  }

  // 仅供测试/冷备恢复使用：整文件重写不是业务路径
  rewriteAll(events) {
    if (!this.filePath) return;
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    renameSync(tmp, this.filePath);
  }
}

// 内存版存储（测试用）
export class MemoryEventStore {
  constructor() {
    this.events = [];
  }
  load() {
    return this.events;
  }
  append(newEvents, expectedLastSeq) {
    const actual = this.events.length ? this.events[this.events.length - 1].seq : 0;
    if (actual !== expectedLastSeq) throw new ConcurrencyError(expectedLastSeq, actual);
    this.events.push(...newEvents);
    return newEvents;
  }
  rewriteAll(events) {
    this.events = [...events];
  }
}
