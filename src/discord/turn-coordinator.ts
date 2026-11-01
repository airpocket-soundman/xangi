import {
  conversationBusy,
  reserveConversation,
  waitForConversation,
} from '../conversation-locks.js';

export class DiscordTurnCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  isBusy(key: string): boolean {
    return this.tails.has(key) || conversationBusy(key);
  }

  async tryRun<T>(key: string, task: () => Promise<T>): Promise<{ accepted: boolean; result?: T }> {
    if (this.isBusy(key)) {
      return { accepted: false };
    }

    const result = await this.enqueue(key, task);
    return { accepted: true, result };
  }

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const execute = async () => {
      const release = reserveConversation(key) ?? (await waitForConversation(key));
      try {
        return await task();
      } finally {
        release();
      }
    };
    const result = previous.then(execute, execute);
    const tail = result.then(
      () => undefined,
      () => undefined
    );

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }
}
