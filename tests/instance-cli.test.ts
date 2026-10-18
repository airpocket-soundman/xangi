import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';

it('複数設置先と引用符入りパスでもlogin shellのPATHにある別CLIを使わない', () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-cli-'));
  try {
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'xangi'), '#!/bin/sh\necho wrong-instance\n', { mode: 0o755 });
    for (const name of ['instance-a', "instance b's"]) {
      const home = join(root, name);
      mkdirSync(join(home, 'src'), { recursive: true });
      mkdirSync(join(home, 'bin'));
      writeFileSync(
        join(home, 'src/instance-cli.mjs'),
        transpileModule(readFileSync(new URL('../src/instance-cli.ts', import.meta.url), 'utf8'), {
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        }).outputText
      );
      writeFileSync(join(home, 'bin/xangi'), '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', {
        mode: 0o755,
      });
      const moduleUrl = pathToFileURL(join(home, 'src/instance-cli.mjs')).href;
      const cli = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { instanceCliCommand } from ${JSON.stringify(moduleUrl)}; console.log(instanceCliCommand);`,
        ],
        { encoding: 'utf8' }
      ).trim();
      for (const args of [
        'workspace list',
        'tool help workspace',
      ]) {
        const output = execFileSync(
          '/bin/bash',
          ['-lc', `export PATH='${other}':"$PATH"; ${cli} ${args}`],
          { encoding: 'utf8' }
        );
        expect(output.trim().split('\n')).toEqual([join(home, 'bin/xangi'), ...args.split(' ')]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('normalization only recognizes this instance and keeps arguments intact', async () => {
  const { instanceCliCommand, normalizeInstanceCliCommand } =
    await import('../src/instance-cli.js');
  expect(normalizeInstanceCliCommand(`${instanceCliCommand} tool help`)).toBe('xangi tool help');
  for (const command of ["'/other/bin/xangi' tool help", `${instanceCliCommand}suffix tool help`]) {
    expect(normalizeInstanceCliCommand(command)).toBe(command);
  }
});
