/** Share an active refresh; notifications during it request just one follow-up. */
export function coalesceRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | undefined;
  let requested = false;
  return () => {
    requested = true;
    if (!active) {
      active = Promise.resolve().then(async () => {
        try {
          do {
            requested = false;
            await refresh();
          } while (requested);
        } finally {
          active = undefined;
        }
      });
    }
    return active;
  };
}
