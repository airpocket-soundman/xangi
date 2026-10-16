import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeProjectAgentCommand, executeTeamCommand, executeWorkspaceCommand } from '../src/project-agent-command.js';
import { initSessions, createWebSession } from '../src/sessions.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

import { XANGI_COMMANDS_COMMON } from '../src/prompts/xangi-commands-common.js';

const exec = promisify(execFile);
it('uses the injected instance CLI for list/run/status/wait despite login-shell PATH shadowing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cli-'));
  const shadow = join(root, 'bin');
  mkdirSync(shadow);
  writeFileSync(join(shadow, 'xangi'), '#!/bin/sh\necho "Unknown command: agent" >&2\nexit 1\n');
  chmodSync(join(shadow, 'xangi'), 0o755);
  initSessions(root);
  const catalog = new ProjectCatalog(root);
  const parentPath = join(root, 'parent');
  const childPath = join(root, 'child');
  mkdirSync(parentPath);
  mkdirSync(childPath);
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: parentPath,
  });
  const childWorkspace = await workspaces.register('child', childPath);
  const agent = catalog.saveAgent({
    name: 'Child',
    prompt: 'child instructions',
    workspaceId: childWorkspace.id,
  });
  const channelId = 'discord-parent';
  const runs = AgentRunStore.fromDataDir(root);
  const start = async (body: Record<string, unknown>) => {
    const run = runs.create({
      ...body,
      task: String(body.task),
      backend: 'codex',
      workspaceId: 'default',
      workspacePath: root,
    });
    runs.markSucceeded(run.id, { result: 'CHILD_RESULT', sessionId: 'child-provider' });
    return runs.get(run.id)!;
  };
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      expect(['agent', 'team', 'workspace']).toContain(payload.command);
      expect(payload.context.channelId).toBe(channelId);
      const result = await (payload.command === 'workspace' ? executeWorkspaceCommand : payload.command === 'team' ? executeTeamCommand : executeProjectAgentCommand)(
        payload.flags,
        { channelId: payload.context.channelId },
        { catalog, runs, start, workspaces }
      );
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const prompt = XANGI_COMMANDS_COMMON;
    const command = prompt.match(/'[^']+' agent(?= list)/)?.[0];
    expect(command).toBeTruthy();
    const env = {
      ...process.env,
      XANGI_TOOL_SERVER: `http://127.0.0.1:${address.port}`,
      XANGI_CHANNEL_ID: channelId,
      XANGI_PLATFORM: 'web',
    };
    const shell = (line: string) =>
      exec('/bin/bash', ['-lc', `export PATH='${shadow}':"$PATH"; ${line}`], { env });
    await expect(shell('xangi agent list')).rejects.toThrow('Unknown command: agent');
    const call = async (args: string) => JSON.parse((await shell(`${command} ${args}`)).stdout);
    expect((await call('list')).agents.map((a: { id: string }) => a.id)).toEqual(['xangi:default', agent.id]);
    const workspaceCall = async (args: string) => JSON.parse((await shell(`${command!.replace(/ agent$/, ' workspace')} ${args}`)).stdout);
    const registered = await workspaceCall(`create --name '資料用' --path '${childPath}'`);
    expect((await workspaceCall('list')).workspaces).toContainEqual(registered.workspace);
    await expect(workspaceCall(`create --name 'missing' --path '${childPath}/missing'`)).rejects.toThrow();
    const writingAgent = await call(`create --name '執筆担当' --workspace-id '${registered.workspace.id}' --prompt '出典を示す'`);
    expect(writingAgent.agent).toMatchObject({ workspaceId: registered.workspace.id, prompt: '出典を示す' });
    await expect(call(`create --name '不明な作業場所' --workspace-id missing`)).rejects.toThrow();
    const defaultRun = await call("run default --task 'question for default'");
    expect(defaultRun.agentId).toBe('xangi:default');
    expect(await call(`wait --id ${defaultRun.id}`)).toMatchObject({ result: 'CHILD_RESULT' });
    const created = await call(`create --name Developer --workspace '${childPath}'`);
    expect(created.agent.workspaceId).toBe(created.workspace.id);
    expect(catalog.list()).toEqual([]);
    const run = await call(`run ${created.agent.id} --task 'bounded task'`);
    expect(await call(`status --id ${run.id}`)).toMatchObject({ status: 'succeeded' });
    expect(await call(`wait --id ${run.id}`)).toMatchObject({ result: 'CHILD_RESULT' });
    expect(await call(`delete ${created.agent.id}`)).toEqual({ok:true});
    expect(catalog.agent(created.agent.id)).toBeUndefined();
    expect(prompt).toContain(`${command} run`);
    expect(prompt).toContain(`${command} status`);
    expect(prompt).toContain('Results return to the original conversation on completion');
    expect(prompt).toContain(`Use ${command} wait --id <RUN_ID> only for synchronous execution`);
    expect(catalog.execution(undefined, agent.id)!.prompt).not.toContain(command);
    const team = catalog.saveTeam({ leadership: 'caller', name: 'リサーチ', prompt: '出典を示す', members: [{ agentId: agent.id, role: '調査' }] });
    const leader = catalog.saveAgent({ name: 'Leader' });
    const delegated = await call(`run ${leader.id} --task 'coordinate' --allow-teams-json '${JSON.stringify([team.id])}' --delegation-max-members 3`);
    expect(delegated.teamDelegation).toMatchObject({ teamIds: [team.id], maxMemberRuns: 3 });
    const teamCommand = prompt.match(/'[^']+' team(?= list)/)?.[0];
    expect(teamCommand).toBeTruthy();
    const teamCall = async (args: string) => JSON.parse((await shell(`${teamCommand} ${args}`)).stdout);
    const savedTeam = await teamCall(`create --name '資料チーム' --members-json '${JSON.stringify([{agentId: writingAgent.agent.id, role: '執筆'}])}' --leader-agent-id xangi:default --prompt '根拠を確認する'`);
    expect((await teamCall(`show '${savedTeam.team.id}'`))).toMatchObject({name: '資料チーム', leaderAgentId: 'xangi:default', prompt: '根拠を確認する'});
    expect(catalog.team(savedTeam.team.id)).toEqual(savedTeam.team);
    await expect(teamCall(`create --name '資料チーム' --members-json '[{"agentId":"xangi:default"}]'`)).rejects.toThrow();
    await expect(teamCall(`create --name '不正チーム' --members-json '[{"agentId":"missing"}]'`)).rejects.toThrow();
    await expect(teamCall(`create --name '不正チーム' --members-json '[]'`)).rejects.toThrow();
    await expect(teamCall(`create --name '不正チーム' --members-json '[{"agentId":"xangi:default"}]' --leader-agent-id xangi:default`)).rejects.toThrow();
    expect(catalog.teams()).toHaveLength(2);
    expect((await teamCall('list')).teams[0].id).toBe(team.id);
    expect(await teamCall("show 'リサーチ'")).toMatchObject({ prompt: '出典を示す' });
    const teamRun = await teamCall(`run 'リサーチ' --task '調べて' --assignments-json '${JSON.stringify([{agentId:agent.id,task:'独立調査'}])}'`);
    expect(await teamCall(`status --id ${teamRun.id}`)).toMatchObject({ status: 'succeeded', members: [] });
    expect(await teamCall(`wait --id ${teamRun.id}`)).toMatchObject({ result: 'CHILD_RESULT' });
    await expect(workspaceCall(`delete '${registered.workspace.id}'`)).rejects.toThrow('使用中');
    expect(await teamCall(`delete '${savedTeam.team.id}'`)).toMatchObject({ok: true, team: {id: savedTeam.team.id}});
    expect(await call(`delete '${writingAgent.agent.id}'`)).toEqual({ok: true});
    expect(await workspaceCall(`delete '${registered.workspace.id}'`)).toMatchObject({ok: true, filesPreserved: true});
    expect(catalog.team(savedTeam.team.id)).toBeUndefined();
    expect(workspaces.getById(registered.workspace.id)).toBeUndefined();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
