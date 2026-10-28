import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { glob } from 'fs/promises';
import { join } from 'path';
import { executeTool } from '../src/local-llm/tools.js';

let root: string;
let workspace: string;
let allowed: string;
let denied: string;

function run(name: string, args: Record<string, unknown>, skipPermissions = true) {
  return executeTool(name, args, { workspace, skipPermissions });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xangi-symlinks-'));
  workspace = join(root, 'workspace');
  allowed = join(root, 'allowed');
  denied = join(root, 'allowed-sibling');
  for (const path of [workspace, allowed, denied]) mkdirSync(path, { recursive: true });
  writeFileSync(join(allowed, 'SKILL.md'), 'shared skill');
  writeFileSync(join(denied, 'secret.md'), 'forbidden');
  symlinkSync(allowed, join(workspace, 'shared'));
  symlinkSync(denied, join(workspace, 'denied'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('Local LLM workspace symlinks', () => {
  it('reads external files through relative and workspace-absolute link paths', async () => {
    for (const path of ['shared/SKILL.md', join(workspace, 'shared/SKILL.md')]) {
      expect(await run('read', { path })).toMatchObject({ success: true, output: 'shared skill' });
    }
  });

  it('rejects external link reads, searches and writes in restricted mode', async () => {
    for (const [name, args] of [
      ['read', { path: 'shared/SKILL.md' }],
      ['glob', { cwd: 'shared', pattern: '**/*' }],
      ['grep', { path: 'shared', pattern: 'skill' }],
      ['write', { path: 'shared/new/file.md', content: 'blocked' }],
      ['edit', { path: 'shared/SKILL.md', old_string: 'shared', new_string: 'blocked' }],
    ] as const) {
      expect((await run(name, args, false)).success).toBe(false);
    }
    expect(readFileSync(join(allowed, 'SKILL.md'), 'utf8')).toBe('shared skill');
    expect(existsSync(join(allowed, 'new'))).toBe(false);
  });

  it('writes, edits and creates files through external links', async () => {
    for (const path of ['shared/SKILL.md', join(workspace, 'shared/SKILL.md')]) {
      expect((await run('write', { path, content: 'updated skill' })).success).toBe(true);
      expect(readFileSync(join(allowed, 'SKILL.md'), 'utf8')).toBe('updated skill');
      expect(
        (await run('edit', { path, old_string: 'updated', new_string: 'edited' })).success
      ).toBe(true);
      expect(readFileSync(join(allowed, 'SKILL.md'), 'utf8')).toBe('edited skill');
    }
    expect((await run('write', { path: 'shared/new/nested.md', content: 'created' })).success).toBe(
      true
    );
    expect(readFileSync(join(allowed, 'new/nested.md'), 'utf8')).toBe('created');
    symlinkSync(join(allowed, 'SKILL.md'), join(workspace, 'file-link'));
    expect((await run('write', { path: 'file-link', content: 'file target' })).success).toBe(true);
    expect(readFileSync(join(allowed, 'SKILL.md'), 'utf8')).toBe('file target');
  });

  it('keeps internal links readable and writable in restricted mode', async () => {
    mkdirSync(join(workspace, 'notes'));
    symlinkSync('notes', join(workspace, 'alias'));
    expect((await run('write', { path: 'alias/new.md', content: 'internal' }, false)).success).toBe(
      true
    );
    expect((await run('read', { path: 'alias/new.md' }, false)).output).toBe('internal');
    expect(
      (
        await run(
          'edit',
          { path: 'alias/new.md', old_string: 'internal', new_string: 'edited' },
          false
        )
      ).success
    ).toBe(true);
  });

  it('follows nested external links while skipping cycles and retaining link paths', async () => {
    symlinkSync(denied, join(allowed, 'escape'));
    symlinkSync('missing', join(allowed, 'broken'));
    symlinkSync('.', join(allowed, 'cycle'));
    for (const cwd of [undefined, 'shared']) {
      const glob = await run('glob', { cwd, pattern: '**/*.md' });
      const grep = await run('grep', { path: cwd, pattern: 'skill|forbidden|state secret' });
      expect(glob.success).toBe(true);
      expect(glob.output).toContain(cwd ? 'SKILL.md' : 'shared/SKILL.md');
      expect(grep.success).toBe(true);
      expect(grep.output).toContain('shared/SKILL.md:1:shared skill');
      for (const result of [glob, grep]) {
        expect(result.output).toContain('escape/secret.md');
        expect(result.output).not.toMatch(/cycle|broken|truncated/);
      }
    }
  });

  it('supports brace glob patterns and directory matches through links', async () => {
    mkdirSync(join(allowed, 'nested'));
    writeFileSync(join(allowed, 'nested/code.ts'), 'code');
    expect(
      (await run('glob', { pattern: 'shared/**/*.{md,ts}' })).output.split('\n').sort()
    ).toEqual(['shared/SKILL.md', 'shared/nested/code.ts']);
    expect((await run('glob', { pattern: 'shared/*/' })).output).toBe('shared/nested');
  });

  it('preserves native glob file and directory matching for ordinary trees', async () => {
    const directory = join(workspace, 'plain');
    mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'a.md'), 'text');
    writeFileSync(join(directory, 'src/code.ts'), 'code');
    for (const pattern of [
      '**',
      '**/**',
      'src/**',
      '**/*',
      './src',
      'src/',
      '*.{md,ts}',
      '**/*.ts',
    ]) {
      const expected: string[] = [];
      for await (const path of glob(pattern, { cwd: directory })) expected.push(path);
      const result = await run('glob', { cwd: 'plain', pattern });
      expect(result.success).toBe(true);
      expect(result.output.split('\n').sort(), pattern).toEqual(expected.sort());
    }
  });

  it('rejects broken and cyclic paths and skips them during recursive search', async () => {
    symlinkSync(join(allowed, 'missing.md'), join(workspace, 'broken.md'));
    symlinkSync('loop-b', join(workspace, 'loop-a'));
    symlinkSync('loop-a', join(workspace, 'loop-b'));
    for (const path of ['broken.md', 'loop-a']) {
      expect((await run('read', { path })).success).toBe(false);
      expect((await run('write', { path, content: 'new' })).success).toBe(false);
      expect((await run('glob', { cwd: path, pattern: '*' })).success).toBe(false);
      expect((await run('grep', { path, pattern: 'x' })).success).toBe(false);
    }
    const result = await run('glob', { pattern: '**/*' });
    expect(result.success).toBe(true);
    expect(result.output).not.toMatch(/broken|loop-/);
  });

  it('bounds deeply nested trees and reports truncation for searches without matches', async () => {
    let directory = allowed;
    for (let i = 0; i < 70; i++) {
      directory = join(directory, 'd');
      mkdirSync(directory);
    }
    writeFileSync(join(directory, 'deep.md'), 'too deep');
    for (const result of [
      await run('glob', { cwd: 'shared', pattern: '**/*.absent' }),
      await run('grep', { path: 'shared', pattern: 'no match' }),
    ]) {
      expect(result).toMatchObject({ success: true, output: '(no matches)\n... [truncated]' });
    }
  });

  it('bounds wide trees even when no files match', async () => {
    const wide = join(allowed, 'wide');
    mkdirSync(wide);
    for (let i = 0; i < 10_005; i++) writeFileSync(join(wide, `f${i}`), '');
    for (const result of [
      await run('glob', { cwd: 'shared/wide', pattern: '**/*.absent' }),
      await run('grep', { path: 'shared/wide', pattern: 'no match' }),
    ]) {
      expect(result.output).toContain('[truncated]');
    }
  });

  it('bounds total grep input bytes across linked files', async () => {
    const large = join(allowed, 'large');
    mkdirSync(large);
    for (let i = 0; i < 18; i++)
      writeFileSync(join(large, `f${i}.txt`), 'x'.repeat(2 * 1024 * 1024));
    expect((await run('grep', { path: 'shared/large', pattern: 'absent' })).output).toBe(
      '(no matches)\n... [truncated]'
    );
  });

  it('reports the time budget even for searches with no results', async () => {
    for (const name of ['glob', 'grep']) {
      let calls = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? 0 : 6_000));
      const args =
        name === 'glob'
          ? { cwd: 'shared', pattern: '**/*.absent' }
          : { path: 'shared', pattern: 'absent' };
      expect((await run(name, args)).output).toBe('(no matches)\n... [truncated]');
      vi.restoreAllMocks();
    }
  });
});
