import { describe, expect, it } from 'vitest';
import { coalesceRefresh } from '../web-ui/src/monitorRefresh';

describe('monitor refresh scheduling', () => {
  it('coalesces notifications without losing a refresh requested during an old snapshot', async () => {
    let finish!: () => void;
    let calls = 0;
    const refresh = coalesceRefresh(async () => {
      calls++;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    });
    const first = refresh();
    await Promise.resolve();
    const second = refresh();
    const third = refresh();
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(calls).toBe(1);
    finish();
    await first;
    expect(calls).toBe(2);
    await refresh();
    expect(calls).toBe(3);
  });

  it('can refresh again after a failed request', async () => {
    let calls = 0;
    const refresh = coalesceRefresh(async () => {
      if (++calls === 1) throw new Error('offline');
    });
    await expect(refresh()).rejects.toThrow('offline');
    await expect(refresh()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
