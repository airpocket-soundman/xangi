import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockSite } from '../src/mock-site.mjs';

test('mock site state is observable and starts with no purchases',async()=>{
  const mock=createMockSite(0);
  await mock.listen();
  try {
    const port=mock.server.address().port;
    const html=await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html,/Mock Catalog/);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/state`)).json(),{submissions:0,purchases:0});
  } finally {await mock.close();}
});
