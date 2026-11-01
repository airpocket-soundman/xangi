/** Execution keys are shared by Web ingress and the native chat adapters. */
const held = new Set<string>();
const waiters = new Map<string, Set<() => void>>();

export function conversationBusy(key: string, includeThreads = false): boolean {
  return held.has(key) || (includeThreads && [...held].some((item) => item.startsWith(key + ':')));
}

export function reserveConversation(key: string): (() => void) | undefined {
  if (held.has(key)) return undefined;
  held.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(key);
    for (const wake of waiters.get(key) ?? []) wake();
    waiters.delete(key);
  };
}

export async function waitForConversation(key: string): Promise<() => void> {
  for (;;) {
    const release = reserveConversation(key);
    if (release) return release;
    await new Promise<void>((resolve) => {
      const listeners = waiters.get(key) ?? new Set();
      listeners.add(resolve);
      waiters.set(key, listeners);
    });
  }
}
