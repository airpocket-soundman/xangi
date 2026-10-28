import { stripVTControlCharacters } from 'node:util';
/** Safe, transient provider state; never includes raw diagnostic text. */
export interface BackendStatus {
  reason: 'rate_limit' | 'connection';
  retryAt?: number;
  attempt?: number;
  maxAttempts?: number;
}

export function formatBackendStatus(status: BackendStatus, now = Date.now()): string {
  const reason = status.reason === 'rate_limit' ? 'リクエスト制限（429）' : '通信エラー';
  const wait =
    status.retryAt === undefined
      ? '再接続中'
      : now < status.retryAt
        ? `再試行まで${Math.ceil((status.retryAt - now) / 1000)}秒`
        : '再試行時刻を経過・応答待ち';
  return `⏳ ${reason}・${wait}`;
}

/** Only match the Codex retry diagnostic, never arbitrary provider messages. */
export function parseCodexRetry(
  line: string
): { status: BackendStatus; turnId: string } | undefined {
  const match = stripVTControlCharacters(line).match(
    /codex_core::responses_retry:.*stream disconnected - retrying sampling request \((\d+)\/(\d+) in ([\d.]+)s\).*?turn_id=([a-zA-Z0-9-]+).*?sampling_error=(.*)/
  );
  if (!match) return;
  const [, attempt, max, delay, turnId, error] = match;
  const seconds = Number(delay);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return;
  return {
    turnId,
    status: {
      reason: /\b429\b/.test(error) ? 'rate_limit' : 'connection',
      retryAt: Date.now() + Math.ceil(seconds * 1000),
      attempt: Number(attempt),
      maxAttempts: Number(max),
    },
  };
}

/** Bound partial lines, tolerate split writes, and discard oversized diagnostics. */
export function codexDiagnosticReader(
  accept: (retry: NonNullable<ReturnType<typeof parseCodexRetry>>) => void
) {
  let buffer = '';
  let dropping = false;
  return (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      const ended = part.endsWith('\n');
      if (!dropping) {
        if (buffer.length + part.length > 16384) {
          buffer = '';
          dropping = true;
        } else buffer += part;
      }
      if (ended) {
        if (!dropping) {
          const retry = parseCodexRetry(buffer);
          if (retry) accept(retry);
        }
        buffer = '';
        dropping = false;
      }
    }
  };
}

export function codexHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return;
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
  if (!info || typeof info !== 'object') return;
  for (const value of Object.values(info)) {
    if (
      value &&
      typeof value === 'object' &&
      'httpStatusCode' in value &&
      typeof value.httpStatusCode === 'number'
    )
      return value.httpStatusCode;
  }
}

export function codexFailureMessage(error: unknown): string {
  const code = codexHttpStatus(error);
  if (code === 429)
    return 'Codexのリクエスト制限（429）で再試行に失敗しました。時間を置いて再実行してください。';
  if (code === 401 || code === 403) return `Codexの認証・アクセス権限エラー（${code}）です。`;
  if (code && code >= 500 && code <= 599) return `Codexのサーバーエラー（${code}）です。`;
  return 'Codex turn interrupted or failed';
}
