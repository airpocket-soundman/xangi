import { describe, expect, it, vi } from 'vitest';
import { fetchAttachmentInfo } from '../web-ui/src/attachment-preview.js';

describe('attachment preview during message submission', () => {
  it('retries an unregistered attachment until the submitted message is saved', async () => {
    const fetchInfo = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'この会話の添付ファイルではありません。' }), {
          status: 403,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'audio' }), { status: 200 }));
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchAttachmentInfo(fetchInfo, true, new AbortController().signal, wait)
    ).resolves.toEqual({ kind: 'audio' });
    expect(fetchInfo).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors or unregistered attachments in saved messages', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    for (const [pending, message] of [
      [false, 'この会話の添付ファイルではありません。'],
      [true, '別のエラー'],
    ] as const) {
      const fetchInfo = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: message }), { status: 403 }));
      await expect(
        fetchAttachmentInfo(fetchInfo, pending, new AbortController().signal, wait)
      ).rejects.toThrow(message);
      expect(fetchInfo).toHaveBeenCalledTimes(1);
    }
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops retrying and reports an error if the message is never saved', async () => {
    const message = 'この会話の添付ファイルではありません。';
    const fetchInfo = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ error: message }), { status: 403 })
      );
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchAttachmentInfo(fetchInfo, true, new AbortController().signal, wait)
    ).rejects.toThrow(message);
    expect(fetchInfo).toHaveBeenCalledTimes(61);
  });

  it('stops when the pending preview is cancelled', async () => {
    const fetchInfo = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'この会話の添付ファイルではありません。' }), {
          status: 403,
        })
      );
    const wait = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(
      fetchAttachmentInfo(fetchInfo, true, new AbortController().signal, wait)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchInfo).toHaveBeenCalledTimes(1);
  });
});
