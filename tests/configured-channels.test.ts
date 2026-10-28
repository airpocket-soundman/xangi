import { describe, expect, it, vi } from 'vitest';
import type { BackendResolver } from '../src/backend-resolver.js';
import { configuredChannelsSnapshot } from '../src/configured-channels.js';

function resolver(entries: Array<[string, object]>) {
  return { getChannelOverrides: () => new Map(entries) } as unknown as BackendResolver;
}

describe('configured channel overview', () => {
  it('returns only saved overrides for the selected platform, retaining unavailable names', async () => {
    const source = resolver([
      ['123456789012345678', { backend: 'codex', model: 'saved-model', effort: 'high' }],
      ['123456789012345679', { localLlmMode: 'chat' }],
      ['123456789012345680', {}],
      ['C123', { backend: 'claude-code' }],
      ['web-chat:example', { backend: 'codex' }],
      ['C-default', { backend: 'claude-code' }],
    ]);
    const names = vi.fn(async () => [
      { id: '123456789012345678', name: '#configured', group: 'Guild' },
      { id: '123456789012345681', name: '#inherits' },
    ]);
    const result = await configuredChannelsSnapshot('discord', source, names);
    expect(result.channels).toHaveLength(2);
    expect(result.channels).toContainEqual({
      id: '123456789012345678',
      name: '#configured',
      group: 'Guild',
      nameAvailable: true,
      override: { backend: 'codex', model: 'saved-model', effort: 'high' },
    });
    expect(result.channels).toContainEqual(
      expect.objectContaining({ id: '123456789012345679', nameAvailable: false })
    );
    expect(names).toHaveBeenCalledOnce();
    expect((await configuredChannelsSnapshot('slack', source)).channels.map((c) => c.id)).toEqual([
      'C123',
    ]);
  });

  it('does not call the channel provider when there are no configured channels', async () => {
    const names = vi.fn();
    expect(await configuredChannelsSnapshot('discord', resolver([]), names)).toEqual({
      channels: [],
    });
    expect(names).not.toHaveBeenCalled();
  });

  it('keeps saved settings visible when channel name lookup fails', async () => {
    const result = await configuredChannelsSnapshot(
      'slack',
      resolver([['C123', { backend: 'codex', model: 'saved' }]]),
      async () => {
        throw new Error('offline');
      }
    );
    expect(result.channels[0]).toMatchObject({
      id: 'C123',
      name: 'C123',
      nameAvailable: false,
      override: { model: 'saved' },
    });
    expect(result.message).toContain('offline');
  });
});
