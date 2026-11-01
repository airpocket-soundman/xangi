import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('checkout updater recovery',()=>{
  it.each(['directory','file'])('R05/R35 retries dependency installation at unchanged HEAD with .git %s',kind=>{
    const root=mkdtempSync(join(tmpdir(),'xangi-checkout-regression-'));
    try {
      const bin=join(root,'fake-bin');mkdirSync(bin);
      if(kind==='file')writeFileSync(join(root,'.git'),'gitdir: fake');else mkdirSync(join(root,'.git'));
      writeFileSync(join(root,'package.json'),'{}');
      writeFileSync(join(bin,'git'),'#!/bin/sh\ncase "$1" in\n status) exit 0;;\n symbolic-ref) echo main;;\n rev-parse) echo abc1234;;\n pull) exit 0;;\n *) exit 1;;\nesac\n');
      writeFileSync(join(bin,'npm'),'#!/bin/sh\necho "$*" >> npm-calls\nif [ "$1" = ci ] && [ ! -f retry-marker ]; then touch retry-marker; exit 1; fi\n');
      chmodSync(join(bin,'git'),0o700);chmodSync(join(bin,'npm'),0o700);
      const script=new URL('../packaging/update-checkout.sh',import.meta.url).pathname;
      const options={env:{...process.env,BASH_ENV:'',PATH:bin+delimiter+process.env.PATH},encoding:'utf8' as const};
      expect(spawnSync('bash',[script,root],options).status).toBe(1);
      const second=spawnSync('bash',[script,root],options);expect(second.status,second.stderr).toBe(0);
      expect(readFileSync(join(root,'npm-calls'),'utf8').trim().split('\n')).toEqual(['ci','ci','run build']);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
