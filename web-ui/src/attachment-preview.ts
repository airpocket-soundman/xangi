export async function fetchAttachmentInfo(
  fetchInfo: () => Promise<Response>,
  pending: boolean,
  signal: AbortSignal,
  wait: (signal: AbortSignal) => Promise<void>
): Promise<{ kind: string; text?: string; truncated?: boolean; pages?: number }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchInfo();
    const body = await response.json();
    if (response.ok) return body;
    if (
      pending &&
      response.status === 403 &&
      body.error === 'この会話の添付ファイルではありません。' &&
      attempt < 60
    ) {
      await wait(signal);
      continue;
    }
    throw new Error(body.error || 'プレビューを取得できませんでした。');
  }
}
