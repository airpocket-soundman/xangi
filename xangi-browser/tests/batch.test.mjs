import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch } from '../src/batch.mjs';

test('batch executes steps and checks postconditions', async () => {
  const seen = [];
  const r = await executeBatch([
    { type: 'navigate', url: 'http://localhost:8123', expectUrlIncludes: 'localhost' },
    { type: 'snapshot', expectTextIncludes: 'Query' },
  ], async a => { seen.push(a.type); return { ok: true, url: 'http://localhost:8123', tree: 'textbox Query' }; });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['navigate','snapshot']);
});
test('batch stops before irreversible or unapproved step', async () => {
  const seen = [];
  const r = await executeBatch([
    { type: 'snapshot' }, { type: 'click', name: 'Pay now' }, { type: 'snapshot' },
  ], async a => { seen.push(a.type); return { ok: true }; });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'approval_required');
  assert.deepEqual(seen, ['snapshot']);
});
test('batch stops on unmet postcondition', async () => {
  const r = await executeBatch([{type:'snapshot', expectTextIncludes:'Success'}], async () => ({ok:true,tree:'Failure'}));
  assert.equal(r.error, 'postcondition_failed');
});
