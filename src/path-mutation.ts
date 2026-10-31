import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

/** Serialize read/modify/replace across instances, aliases and CLI processes. */
export async function withPathMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(resolve(path))), basename(path));
  const release = await lockfile.lock(canonical, {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
