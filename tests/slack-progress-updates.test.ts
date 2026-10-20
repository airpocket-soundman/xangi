import { describe, expect, it, vi } from 'vitest';
import { SlackProgressUpdates } from '../src/slack-progress-updates.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Slack progress updates', () => {
  it('serializes edits and coalesces waiting updates to the newest snapshot', async () => {
    const queue = new SlackProgressUpdates();
    const gate = deferred();
    const edits: string[] = [];
    const first = queue.update(async () => {
      edits.push('first');
      await gate.promise;
    });
    await Promise.resolve();
    const stale = queue.update(async () => {
      edits.push('stale');
    });
    const latest = queue.update(async () => {
      edits.push('latest');
    });
    expect(edits).toEqual(['first']);
    gate.resolve();
    await Promise.all([first, stale, latest]);
    expect(edits).toEqual(['first', 'latest']);
  });

  it('drains an active edit, discards pending edits, and ignores late callbacks', async () => {
    const queue = new SlackProgressUpdates();
    const gate = deferred();
    const edits: string[] = [];
    const first = queue.update(async () => {
      await gate.promise;
      edits.push('progress');
    });
    await Promise.resolve();
    const stale = queue.update(async () => {
      edits.push('stale');
    });
    const done = queue.finish().then(() => {
      edits.push('final');
    });
    await queue.update(async () => {
      edits.push('late');
    });
    expect(edits).toEqual([]);
    gate.resolve();
    await Promise.all([first, stale, done, queue.finish()]);
    expect(edits).toEqual(['progress', 'final']);
  });

  it('allows completion after a rejected request without blocking other messages', async () => {
    const queue = new SlackProgressUpdates();
    const other = new SlackProgressUpdates();
    const gate = deferred();
    const failure = queue.update(async () => {
      await gate.promise;
      throw new Error('network');
    });
    const rejected = expect(failure).rejects.toThrow('network');
    const render = vi.fn().mockResolvedValue(undefined);
    await other.update(render);
    expect(render).toHaveBeenCalledOnce();
    gate.resolve();
    await rejected;
    await queue.update(render);
    await queue.finish();
    expect(render).toHaveBeenCalledTimes(2);
  });
});
