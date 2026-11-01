import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AppLayout } from './types.js';

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

export async function assertWorkspaceOutsideManagedDirectories(
  path: string,
  layout: AppLayout
): Promise<void> {
  const workspace = await canonicalPath(path);
  for (const target of [layout.appRoot, layout.configDir, layout.stateDir]) {
    if (contains(await canonicalPath(target), workspace)) {
      throw new Error('Workspace must be outside managed app, config and state directories');
    }
  }
}

/** Refuse before changing services or deleting anything, including historical session snapshots. */
export async function assertManagedDeletionPreservesWorkspaces(
  layout: AppLayout,
  purge: boolean
): Promise<void> {
  const workspaces = new Set([layout.workspaceDir]);
  for (const file of [
    layout.configFile,
    join(layout.stateDir, 'workspaces.json'),
    join(layout.stateDir, 'sessions.json'),
  ]) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Cannot verify workspace protection: ' + file, { cause: error });
    }
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      const record = node as Record<string, unknown>;
      for (const key of ['workspacePath', ...(file.endsWith('workspaces.json') ? ['path'] : [])]) {
        if (typeof record[key] === 'string' && isAbsolute(record[key])) workspaces.add(record[key]);
      }
      Object.values(record).forEach(collect);
    };
    collect(value);
  }
  const targets = [layout.appRoot, ...(purge ? [layout.configDir, layout.stateDir] : [])];
  for (const workspace of workspaces) {
    const canonical = await canonicalPath(workspace);
    for (const target of targets) {
      if (contains(await canonicalPath(target), canonical)) {
        throw new Error(
          'Uninstall would delete a workspace. Move it outside managed directories first: ' +
            workspace
        );
      }
    }
  }
}
