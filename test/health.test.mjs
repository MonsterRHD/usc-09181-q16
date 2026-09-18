import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, tempDir } from './helpers.mjs';

test('健康检查返回 ok', async () => {
  const { base, close } = await startServer(await tempDir());
  try {
    const res = await api(base, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
  } finally {
    await close();
  }
});
