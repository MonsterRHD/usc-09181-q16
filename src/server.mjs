import { createServer } from 'node:http';
import { IncidentService } from './domain/service.mjs';
import { EventStore } from './store/event-store.mjs';
import { createApp } from './http.mjs';

// 事件日志路径默认 data/events.jsonl；只增不删，重启后重放恢复全部事件与任务。
const store = new EventStore(process.env.EVENT_LOG || 'data/events.jsonl');
const service = new IncidentService(store);
const app = createApp(service);

const server = createServer(app);

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`海外分行事件联络网 listening on :${port}, event log: ${store.filePath}`);
  });
}

export { app, server, service, store };
