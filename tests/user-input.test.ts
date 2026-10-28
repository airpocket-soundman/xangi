import { describe, expect, it, vi } from 'vitest';
import {
  userInputEnabled,
  answerUserInput,
  listUserInputs,
  normalizeQuestions,
  requestUserInput,
  validateAnswer,
} from '../src/user-input.js';
const request = normalizeQuestions(
  [
    {
      id: '0',
      isOther: true,
      question: 'Choose?',
      header: 'Choice',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
    },
  ],
  'codex'
);
describe('user input lifecycle', () => {
  it('requires every question and validates cardinality and free text capability', () => {
    expect(() => validateAnswer(request, { answers: {} })).toThrow();
    expect(() => validateAnswer(request, { answers: { '0': ['A', 'B'] } })).toThrow();
    expect(validateAnswer(request, { answers: { '0': ['custom'] } })).toEqual({
      answers: { '0': ['custom'] },
    });
    const fixed = normalizeQuestions(
      [{ id: 'q', question: '?', options: [{ label: 'A' }], isOther: false }],
      'codex'
    );
    expect(() => validateAnswer(fixed, { answers: { q: ['custom'] } })).toThrow();
  });
  it('binds actor and conversation and consumes exactly once', async () => {
    const promise = requestUserInput(
      'discord:a',
      'alice',
      request,
      new AbortController().signal,
      async () => {}
    );
    const [q] = listUserInputs('discord:a', 'alice');
    expect(listUserInputs('discord:a', 'bob')).toEqual([]);
    expect(() => answerUserInput(q.id, 'discord:b', 'alice', { cancelled: true })).toThrow();
    expect(() => answerUserInput(q.id, 'discord:a', 'bob', { cancelled: true })).toThrow();
    answerUserInput(q.id, 'discord:a', 'alice', { answers: { '0': ['A'] } });
    expect(() => answerUserInput(q.id, 'discord:a', 'alice', { cancelled: true })).toThrow();
    expect(await promise).toEqual({ answers: { '0': ['A'] } });
  });
  it('cleans up on backend cancellation and presentation failure', async () => {
    const abort = new AbortController();
    const promise = requestUserInput('web:a', 'web', request, abort.signal, async () => {});
    abort.abort();
    expect(await promise).toEqual({ cancelled: true });
    expect(listUserInputs('web:a', 'web')).toEqual([]);
    await expect(
      requestUserInput('web:a', 'web', request, new AbortController().signal, async () => {
        throw new Error('offline');
      })
    ).rejects.toThrow('offline');
    expect(listUserInputs('web:a', 'web')).toEqual([]);
  });
  it('expires without accepting any default selection', async () => {
    vi.useFakeTimers();
    try {
      const promise = requestUserInput(
        'web:a',
        'web',
        request,
        new AbortController().signal,
        async () => {}
      );
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await promise).toEqual({ cancelled: true });
      expect(listUserInputs('web:a', 'web')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects duplicate IDs and oversized or malformed provider data', () => {
    expect(() => normalizeQuestions([], 'codex')).toThrow();
    expect(() =>
      normalizeQuestions(
        [
          { id: 'x', question: '?' },
          { id: 'x', question: '?' },
        ],
        'codex'
      )
    ).toThrow();
    expect(() => normalizeQuestions([{ question: 'x'.repeat(2001) }], 'codex')).toThrow();
  });
});

it('enables question delivery without configuration and supports explicit opt-out', () => {
  const previous = process.env.AGENT_USER_INPUT;
  try {
    delete process.env.AGENT_USER_INPUT;
    expect(userInputEnabled()).toBe(true);
    process.env.AGENT_USER_INPUT = 'false';
    expect(userInputEnabled()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_USER_INPUT;
    else process.env.AGENT_USER_INPUT = previous;
  }
});
