/** Native platform queues serialize internal continuation with ordinary incoming messages. */
export interface PlatformCompletionBridge {
  isBusy(contextKey: string): boolean;
  enqueue<T>(contextKey: string, execute: () => Promise<T>): Promise<T>;
  deliverResult(input: {
    appSessionId: string;
    text: string;
    attachments: string[];
  }): Promise<string[]>;
}
export type PlatformCompletionRefs = Partial<
  Record<'line' | 'telegram', { current?: PlatformCompletionBridge }>
>;
