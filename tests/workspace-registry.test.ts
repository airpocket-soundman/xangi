import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-workspace-registry-'));
  fixtures.push(root);
  const dataDir = join(root, 'state');
  const allowedRoot = join(root, 'workspaces');
  const defaultWorkspace = join(allowedRoot, 'default');
  await mkdir(defaultWorkspace, { recursive: true });
  return { root, dataDir, allowedRoot, defaultWorkspace };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('WorkspaceRegistry', () => {
  it('changes future resolution while preserving bindings and historical snapshots after reopen', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const oldPath = join(allowedRoot, 'old');
    const newPath = join(allowedRoot, '..', 'external-new');
    await mkdir(oldPath);
    await mkdir(newPath);
    const options = {
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    };
    const registry = await WorkspaceRegistry.open(options);
    const workspace = await registry.register('work', oldPath);
    await registry.bind('discord', 'channel', workspace.id);
    expect(await registry.updatePath(workspace.id, newPath)).toEqual({
      ...workspace,
      path: newPath,
    });
    const reopened = await WorkspaceRegistry.open(options);
    expect(await reopened.resolve('discord', 'channel')).toEqual({ ...workspace, path: newPath });
    expect(await reopened.resolveSnapshot(workspace.id, oldPath)).toEqual(workspace);
    await access(oldPath);
  });

  it('rejects invalid path updates without changing persisted or in-memory state', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const options = {
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    };
    const registry = await WorkspaceRegistry.open(options);
    const workspace = await registry.register('work', defaultWorkspace);
    for (const path of ['relative', join(root, 'missing'), dataDir]) {
      await expect(registry.updatePath(workspace.id, path)).rejects.toThrow();
      expect(registry.getById(workspace.id)).toEqual(workspace);
    }
    await expect(registry.updatePath('default', defaultWorkspace)).rejects.toThrow(
      'WORKSPACE_PATH'
    );
    await expect(registry.updatePath('missing', defaultWorkspace)).rejects.toThrow('not found');
    expect((await WorkspaceRegistry.open(options)).getById(workspace.id)).toEqual(workspace);
  });

  it('registers an arbitrary existing absolute path', async () => {
    const { root, dataDir, defaultWorkspace } = await fixture();
    const sibling = join(root, 'sibling-repository');
    await mkdir(sibling);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    const registered = await registry.register('sibling', sibling);

    expect(registered.path).toBe(await realpath(sibling));
    await expect(registry.resolveById(registered.id)).resolves.toEqual(registered);
  });

  it('renames a workspace without changing bindings or paths, persists it and rejects collisions', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const directory = join(allowedRoot, 'writing');
    await mkdir(directory);
    const options = { dataDir, defaultWorkspacePath: defaultWorkspace };
    const registry = await WorkspaceRegistry.open(options);
    const workspace = await registry.register('執筆', directory);
    await registry.bind('discord', 'writing-channel', workspace.id);
    expect(await registry.rename(workspace.id, '資料制作')).toEqual({ ...workspace, name: '資料制作' });
    const reopened = await WorkspaceRegistry.open(options);
    expect(await reopened.resolve('discord', 'writing-channel')).toEqual({ ...workspace, name: '資料制作' });
    await expect(registry.rename(workspace.id, 'default')).rejects.toThrow('already registered');
    await expect(registry.rename('default', 'other')).rejects.toThrow('Default workspace');
    await expect(registry.rename(workspace.id, ' ')).rejects.toThrow('empty');
    await expect(registry.rename('missing', 'other')).rejects.toThrow('not found');
    expect(registry.getById(workspace.id)?.name).toBe('資料制作');
  });

  it('atomically persists a deterministic default workspace entry', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    expect(registry.list()).toEqual([
      {
        id: 'default',
        name: 'default',
        path: await realpath(defaultWorkspace),
        isDefault: true,
      },
    ]);
    const persisted = JSON.parse(await readFile(join(dataDir, 'workspaces.json'), 'utf8'));
    expect(persisted.workspaces[0]).toMatchObject({ id: 'default', name: 'default' });
    await expect(access(join(dataDir, 'workspaces.json'), constants.R_OK)).resolves.toBeUndefined();
  });

  it('registers canonical paths idempotently and preserves stable IDs after reopen', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const target = join(allowedRoot, 'project');
    const alias = join(allowedRoot, 'project-link');
    await mkdir(target);
    await symlink(target, alias);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    const first = await registry.register('project', alias);
    const second = await registry.register('project', target);
    expect(second).toEqual(first);
    expect(first.path).toBe(await realpath(target));
    expect(first.id).not.toBe('default');

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    expect(reopened.getByName('project')).toEqual(first);
    expect(reopened.getById(first.id)).toEqual(first);
  });

  it('allows browsing outside the workspace while excluding the state directory', async () => {
    const { root, dataDir, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: defaultWorkspace });
    expect(() => registry.assertBrowsableDirectory(root)).not.toThrow();
    expect(() => registry.assertBrowsableDirectory(dataDir)).toThrow(/DATA_DIR/);
  });

  it('updates the default entry when startup WORKSPACE_PATH changes', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const nextDefault = join(allowedRoot, 'next-default');
    await mkdir(nextDefault);
    await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: nextDefault,
    });

    expect(reopened.getById('default')).toMatchObject({
      id: 'default',
      path: await realpath(nextDefault),
      isDefault: true,
    });
  });

  it('quarantines a corrupt registry and recreates the default entry', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'workspaces.json'), '{broken');

    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    expect(registry.list()).toHaveLength(1);
    expect(
      (await readdir(dataDir)).some((name) => name.startsWith('workspaces.json.corrupt-'))
    ).toBe(true);
  });

  it('rejects reuse of a name for a different canonical path', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const first = join(allowedRoot, 'one');
    const second = join(allowedRoot, 'two');
    await Promise.all([mkdir(first), mkdir(second)]);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    await registry.register('project', first);

    await expect(registry.register('project', second)).rejects.toThrow(/different path/);
  });

  it('requires an absolute, existing directory', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const file = join(allowedRoot, 'file.txt');
    const outside = join(root, 'outside');
    await writeFile(file, 'not a directory');
    await mkdir(outside);

    await expect(registry.register('relative', 'relative/path')).rejects.toThrow(/absolute/);
    await expect(registry.register('missing', join(allowedRoot, 'missing'))).rejects.toThrow(
      /existing readable, writable, and traversable/
    );
    await expect(registry.register('file', file)).rejects.toThrow(/not a directory/);
    await expect(registry.register('outside', outside)).resolves.toMatchObject({ path: await realpath(outside) });
  });

  it('quarantines registry namespaces that would pollute object prototypes', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        defaultWorkspaceId: 'default',
        workspaces: [{ id: 'default', name: 'default', path: defaultWorkspace }],
        bindings: JSON.parse('{"__proto__":{"channel":"default"}}'),
      })
    );

    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    expect(registry.list()).toHaveLength(1);
    expect(Object.getPrototypeOf(registry.getById('default'))).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).channel).toBeUndefined();
  });

  it('rejects DATA_DIR and descendants, including through symlinks', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const dataChild = join(dataDir, 'child');
    const dataAlias = join(allowedRoot, 'state-link');
    await mkdir(dataChild);
    await symlink(dataChild, dataAlias);

    await expect(registry.register('state', dataDir)).rejects.toThrow(/DATA_DIR/);
    await expect(registry.register('state-child', dataChild)).rejects.toThrow(/DATA_DIR/);
    await expect(registry.register('state-alias', dataAlias)).rejects.toThrow(/DATA_DIR/);
  });

  it('namespaces bindings by platform and resets them independently', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const project = await registry.register('project', projectPath);

    await registry.bind('discord', 'channel-1', project.id);
    expect(registry.getBinding('discord', 'channel-1')).toBe(project.id);
    expect(registry.getBinding('slack', 'channel-1')).toBeUndefined();
    await expect(registry.resolve('discord', 'channel-1')).resolves.toEqual(project);
    await expect(registry.resolve('slack', 'channel-1')).resolves.toMatchObject({
      id: 'default',
    });
    await expect(registry.resetBinding('slack', 'channel-1')).resolves.toBe(false);
    await expect(registry.resetBinding('discord', 'channel-1')).resolves.toBe(true);
    expect(registry.getBinding('discord', 'channel-1')).toBeUndefined();
  });

  it('unregisters an unused workspace without deleting its directory', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'keep.txt'), 'keep');
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const project = await registry.register('project', projectPath);

    await expect(registry.unregister(project.id)).resolves.toEqual(project);

    expect(registry.getById(project.id)).toBeUndefined();
    await expect(readFile(join(projectPath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    expect(reopened.getById(project.id)).toBeUndefined();
  });

  it('rejects unregistering the default workspace or a workspace used by a binding', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const project = await registry.register('project', projectPath);
    await registry.bind('discord', 'channel-1', project.id);

    await expect(registry.unregister('default')).rejects.toThrow(/Default workspace/);
    await expect(registry.unregister(project.id)).rejects.toThrow(/channel binding/);
    expect(registry.getById(project.id)).toEqual(project);
  });

  it('rejects prototype-polluting platform and channel namespaces', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    await expect(registry.bind('__proto__', 'channel', 'default')).rejects.toThrow(/reserved/);
    await expect(registry.bind('discord', '__proto__', 'default')).rejects.toThrow(/reserved/);
    expect((Object.prototype as Record<string, unknown>).channel).toBeUndefined();
  });

  it('revalidates a workspace every time it is resolved', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const project = await registry.register('project', projectPath);
    await registry.bind('discord', 'channel', project.id);
    await rm(projectPath, { recursive: true });

    await expect(registry.resolve('discord', 'channel')).rejects.toThrow(
      /existing readable, writable, and traversable/
    );

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    await expect(reopened.resolve('discord', 'channel')).rejects.toThrow(
      /existing readable, writable, and traversable/
    );
  });

  it('does not execute a persisted path pointing into the state directory', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registryPath = join(dataDir, 'workspaces.json');
    await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });
    const persisted = JSON.parse(await readFile(registryPath, 'utf8'));
    persisted.workspaces.push({
      id: 'tampered',
      name: 'tampered',
      path: dataDir,
    });
    await writeFile(registryPath, `${JSON.stringify(persisted)}\n`);

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
    });

    // Metadata remains listable so a temporarily unavailable workspace does not
    // brick startup, but execution always goes through the validating resolver.
    expect(reopened.getById('tampered')?.path).toBe(dataDir);
    await expect(reopened.resolveById('tampered')).rejects.toThrow(/DATA_DIR/);
  });

  it.runIf(process.getuid?.() !== 0)(
    'rejects a directory that is not readable, writable, and traversable',
    async () => {
      const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
      const inaccessible = join(allowedRoot, 'inaccessible');
      await mkdir(inaccessible);
      await chmod(inaccessible, 0o000);
      const registry = await WorkspaceRegistry.open({
        dataDir,
        defaultWorkspacePath: defaultWorkspace,
      });

      await expect(registry.register('inaccessible', inaccessible)).rejects.toThrow(
        /readable, writable, and traversable/
      );
    }
  );
});
