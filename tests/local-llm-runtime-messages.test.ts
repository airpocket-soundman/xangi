import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../src/local-llm/llm-client.js';
import type { LLMMessage } from '../src/local-llm/types.js';

afterEach(() => vi.restoreAllMocks());

describe('runtime instructions at the provider boundary', () => {
  it.each([
    ['openai', false],
    ['openai', true],
    ['ollama', false],
    ['ollama', true],
  ] as const)(
    '%s streaming=%s preserves order and internal provenance',
    async (provider, stream) => {
      const messages: LLMMessage[] = [
        { role: 'user', content: 'read the file', transcriptEntryId: 'human-turn' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'read-1', name: 'read', arguments: { path: 'file.txt' } }],
        },
        { role: 'tool', content: 'file text', toolCallId: 'read-1' },
        {
          role: 'runtime',
          content: 'The previous generation was incomplete. Try a smaller action.',
        },
      ];
      const original = structuredClone(messages);
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
          'system',
          'user',
          'assistant',
          'tool',
          'user',
        ]);
        expect(body.messages[0].content).toBe('Base instructions');
        expect(body.messages.at(-1).content).toBe(messages.at(-1)?.content);
        expect(body.messages[1].transcriptEntryId).toBeUndefined();
        if (provider === 'openai') {
          expect(body.messages[3].tool_call_id).toBe('read-1');
          return new Response(
            stream
              ? 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
              : JSON.stringify({
                  choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
                }),
            { status: 200 }
          );
        }
        expect(body.messages[3].tool_name).toBe('read');
        return new Response(JSON.stringify({ message: { content: 'done' }, done: true }) + '\n', {
          status: 200,
        });
      });
      const client = new LLMClient(
        provider === 'openai' ? 'http://localhost:8001' : 'http://localhost:11434',
        'test'
      );
      if (stream) {
        let output = '';
        for await (const chunk of client.chatStream(messages, {
          systemPrompt: 'Base instructions',
        })) {
          output += chunk;
        }
        expect(output).toBe('done');
      } else {
        expect((await client.chat(messages, { systemPrompt: 'Base instructions' })).content).toBe(
          'done'
        );
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(messages).toEqual(original);
    }
  );

  it('does not silently demote explicit system instructions', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        })
      )
    );
    await new LLMClient('http://localhost:8001', 'test').chat([
      { role: 'system', content: 'Explicit system instruction' },
      { role: 'user', content: 'hello' },
    ]);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Explicit system instruction' });
  });
});
