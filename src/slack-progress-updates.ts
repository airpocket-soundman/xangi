/** Serializes edits to one progress message; completion must await finish(). */
export class SlackProgressUpdates {
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private closed = false;

  update(render: () => Promise<unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const revision = ++this.revision;
    const next = this.tail.then(async () => {
      // Keep only the newest pending edit. An already-started request must settle.
      if (this.closed || revision !== this.revision) return;
      await render();
    });
    // One failed edit must not poison later edits or prevent completion.
    this.tail = next.catch(() => {});
    return next;
  }

  finish(): Promise<void> {
    this.closed = true;
    return this.tail;
  }
}
