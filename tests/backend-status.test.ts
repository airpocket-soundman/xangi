import { describe, it, expect } from 'vitest';
import {
  codexDiagnosticReader,
  codexFailureMessage,
  formatBackendStatus,
} from '../src/backend-status.js';
const warning =
  '2026-10-26 WARN codex_core::responses_retry: stream disconnected - retrying sampling request (1/5 in 317.99979707s)... turn_id=turn-1 retries=1 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests secret=DO-NOT-SHOW\n';
describe('safe Codex diagnostics', () => {
  it('reads fragmented retry lines without leaking diagnostic content', () => {
    const received: unknown[] = [];
    const read = codexDiagnosticReader((x) => received.push(x));
    read(warning.slice(0, 80));
    expect(received).toEqual([]);
    read(warning.slice(80));
    expect(received).toEqual([
      {
        turnId: 'turn-1',
        status: { reason: 'rate_limit', attempt: 1, maxAttempts: 5, retryAt: expect.any(Number) },
      },
    ]);
    expect(JSON.stringify(received)).not.toContain('DO-NOT-SHOW');
  });
  it('discards oversized and unrelated lines then recovers; classifies 503 as connection', () => {
    const received: any[] = [];
    const read = codexDiagnosticReader((x) => received.push(x));
    read('x'.repeat(20000));
    read(warning);
    read('unrelated token=secret\n');
    expect(received).toHaveLength(0);
    read(warning.replace('429', '503'));
    expect(received[0].status.reason).toBe('connection');
  });
  it('does not claim recovery just because the deadline elapsed', () => {
    expect(formatBackendStatus({ reason: 'rate_limit', retryAt: 5000 }, 0)).toContain('5秒');
    expect(formatBackendStatus({ reason: 'rate_limit', retryAt: 5000 }, 6000)).toContain(
      '応答待ち'
    );
  });
  it.each([401, 403, 429, 503])(
    'reports terminal HTTP %s without raw messages',
    (httpStatusCode) => {
      const text = codexFailureMessage({
        message: 'SECRET',
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode } },
      });
      expect(text).toContain(String(httpStatusCode));
      expect(text).not.toContain('SECRET');
    }
  );
});

it('accepts actual ANSI-decorated Codex diagnostics', () => {
  const received: unknown[] = [];
  codexDiagnosticReader((x) => received.push(x))(
    warning
      .replace(
        'codex_core::responses_retry:',
        '\x1b[2mcodex_core::responses_retry\x1b[0m\x1b[2m:\x1b[0m'
      )
      .replace('turn_id=', '\x1b[3mturn_id\x1b[0m\x1b[2m=\x1b[0m')
  );
  expect(received).toHaveLength(1);
});
