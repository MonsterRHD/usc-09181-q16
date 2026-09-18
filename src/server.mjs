// 服务入口：加载事件日志（停机恢复回放）后启动 HTTP 服务。
// 环境变量：PORT（默认 3000）、DATA_DIR（默认 ./data）。
import { createServer } from 'node:http';
import { EventStore } from './store.mjs';
import { createApp } from './http.mjs';

const dataDir = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const store = await new EventStore(dataDir).load();
const server = createServer(createApp(store));
const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`海外分行事件联络网已启动: http://localhost:${port} (数据目录 ${dataDir})`);
});
