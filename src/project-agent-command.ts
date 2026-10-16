import {
  delegationScopeCount,
  delegatedRuns,
  unfinished,
  delegationReservations,
} from './team-delegation.js';
import { inspectAgentRunLogs, logPageOptions } from './agent-run-logs.js';
import {
  DEFAULT_TEAM_AGENT_ID,
  DEFAULT_TEAM_CONCURRENCY,
  validateTeamAssignments,
} from './teams.js';
import {
  removeRegisteredAgent,
  removeRegisteredTeam,
  removeRegisteredWorkspace,
} from './agent-selection.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectCatalog } from './project-catalog.js';
import type { AgentRun, AgentRunStore } from './agent-runs.js';
import { getActiveSessionId, getSessionEntry, webAppSessionId } from './sessions.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { realpath } from 'node:fs/promises';
import type { ChatPlatform } from './prompts/index.js';

interface Dependencies {
  catalog: ProjectCatalog;
  runs: AgentRunStore;
  start: (body: Record<string, unknown>) => Promise<AgentRun>;
  workspaces?: WorkspaceRegistry;
  workspaceSwitching?: boolean;
}

export function delegationLimit(): number {
  const value = process.env.AGENT_MAX_CONCURRENT_REQUESTS;
  if (value === undefined || value === '') return 16;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 64)
    throw new Error('AGENT_MAX_CONCURRENT_REQUESTSは1〜64の整数で指定してください');
  return Number(value);
}
function teamGrant(flags: Record<string, string>, ids: string[], ancestorAgentIds: string[]) {
  const timeoutMs = Number(flags['delegation-timeout-ms'] || process.env.TIMEOUT_MS || 3600000);
  const maxMemberRuns = Number(flags['delegation-max-members'] || 64);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 36000000 ||
    !Number.isInteger(maxMemberRuns) ||
    maxMemberRuns < 1 ||
    maxMemberRuns > 256
  )
    throw new Error('委譲期限は1000〜36000000ms、累計メンバー数は1〜256で指定してください');
  if (delegationLimit() < 2) throw new Error('一段委譲には同時実行数2以上が必要です');
  return {
    teamIds: [...new Set(ids)] as string[],
    ancestorAgentIds,
    deadline: Date.now() + timeoutMs,
    maxMemberRuns,
    maxConcurrency: delegationLimit(),
  };
}
let active: Dependencies | undefined;
const reservations = delegationReservations;
export function registerProjectAgents(dependencies: Dependencies): void {
  active = dependencies;
}

/** Register existing directories using the same live registry as Settings. */
export async function executeWorkspaceCommand(
  flags: Record<string, string>,
  context?: { channelId?: string; platform?: ChatPlatform },
  dependencies = active
): Promise<string> {
  if (!dependencies?.workspaces) throw new Error('Workspace registry is unavailable');
  if (dependencies.workspaceSwitching === false) throw new Error('workspace switching is disabled');
  const { workspaces, runs } = dependencies;
  const action = flags.action || 'list';
  if (action === 'list') return JSON.stringify({ workspaces: workspaces.list() });
  if (!['create', 'delete'].includes(action))
    throw new Error('action must be list, create or delete');
  const parent = context?.channelId;
  if (!parent) throw new Error('現在の会話が必要です');
  if (
    runs.list().some((run) => run.parentContextKey && run.appSessionId === webAppSessionId(parent))
  )
    throw new Error('子エージェントから設定を変更することはできません');
  if (action === 'delete') {
    const id = (flags.workspace || flags.id || '').trim();
    if (!id) throw new Error('Workspace IDを指定してください');
    const workspace = await removeRegisteredWorkspace(id, workspaces, dependencies.catalog);
    return JSON.stringify({ ok: true, workspace, filesPreserved: true });
  }
  if (!flags.name?.trim() || !flags.path?.trim()) throw new Error('--name と --path は必須です');
  return JSON.stringify({ workspace: await workspaces.register(flags.name, flags.path) });
}

/** Use the same live catalog and run store as Web Chat; never load a second writer. */
export async function executeProjectAgentCommand(
  flags: Record<string, string>,
  context?: { channelId?: string; platform?: ChatPlatform },
  dependencies = active
): Promise<string> {
  if (!dependencies) throw new Error('Agents require Web Chat to be enabled');
  const { catalog, runs, start, workspaces } = dependencies;
  const parent = context?.channelId;
  const session = parent
    ? getSessionEntry(getActiveSessionId(parent) || webAppSessionId(parent))
    : undefined;
  const action = flags.action || 'list';
  const agentId = flags.agent === 'default' ? DEFAULT_TEAM_AGENT_ID : flags.agent;
  const callerRun = parent
    ? runs.list().find((r) => r.parentContextKey && r.appSessionId === webAppSessionId(parent))
    : undefined;
  // A worker may consult the default agent once, but cannot create a delegation chain.
  if (
    callerRun &&
    !['list', 'status', 'wait', 'logs'].includes(action) &&
    !(
      !callerRun.selfDelegation &&
      !callerRun.delegationRootId &&
      !callerRun.teamDelegation &&
      action === 'run' &&
      agentId === DEFAULT_TEAM_AGENT_ID &&
      callerRun.agentId &&
      callerRun.agentId !== DEFAULT_TEAM_AGENT_ID
    )
  )
    throw new Error('子エージェントからの再委譲はできません（defaultへの問い合わせのみ可能）');
  if (flags.project !== undefined || flags['project-name'] !== undefined)
    throw new Error('エージェント操作に --project / --project-name は不要です');
  if (action === 'list') {
    return JSON.stringify({
      agents: [catalog.defaultAgent(), ...catalog.agents()].map((agent) => {
        const id = agent.id;
        return {
          id,
          name: agent.name,
          description: agent.prompt.split('\n')[0].slice(0, 120),
          backend: agent.backend,
          model: agent.model,
          workspaceId: agent.workspaceId || 'default',
          current:
            !!session &&
            id === (callerRun?.agentId || session.selectedAgentId || DEFAULT_TEAM_AGENT_ID),
        };
      }),
    });
  }
  if (action === 'delete') {
    removeRegisteredAgent(flags.agent || flags.id || '', catalog, (sessionId) =>
      runs
        .list()
        .some((r) => r.appSessionId === sessionId && ['queued', 'running'].includes(r.status))
    );
    return JSON.stringify({ ok: true });
  }
  if (!parent) throw new Error('現在の会話が必要です');
  if (action === 'create') {
    if (!workspaces) throw new Error('Workspace registry is unavailable');
    if (dependencies.workspaceSwitching === false)
      throw new Error('workspace switching is disabled');
    if (!flags.name?.trim() || (!flags.workspace?.trim() && !flags['workspace-id']?.trim()))
      throw new Error('--name と --workspace または --workspace-id は必須です');
    if (flags.workspace && flags['workspace-id'])
      throw new Error('--workspace と --workspace-id は同時指定できません');
    if (
      catalog
        .agents()
        .some((agent) => agent.name.toLocaleLowerCase() === flags.name.trim().toLocaleLowerCase())
    )
      throw new Error('同じ名前のエージェントが既にあります');
    const workspacePath = flags.workspace ? await realpath(flags.workspace) : undefined;
    const workspace = flags['workspace-id']
      ? await workspaces.resolveById(flags['workspace-id'])
      : workspaces.list().find((entry) => entry.path === workspacePath) ||
        (await workspaces.register(`agent-${flags.name}-${Date.now()}`, workspacePath!));
    const agent = catalog.saveAgent({
      name: flags.name,
      role: flags.role || '',
      prompt: flags.prompt || '',
      workspaceId: workspace.id,
      backend: flags.backend,
      model: flags.model,
      effort: flags.effort,
    });
    return JSON.stringify({ agent, workspace });
  }
  if (action === 'wait' || action === 'status' || action === 'logs') {
    let run = runs.get(flags.id || '');
    if (!run || run.parentContextKey !== parent) throw new Error('この会話の依頼が見つかりません');
    if (action === 'logs')
      return JSON.stringify(await inspectAgentRunLogs(run, logPageOptions(flags)));
    const deadline = Date.now() + (action === 'wait' ? 25_000 : 0);
    while (['queued', 'running'].includes(run.status) && Date.now() < deadline) {
      await delay(200);
      run = runs.get(run.id)!;
    }
    return JSON.stringify(run);
  }
  if (action !== 'run')
    throw new Error('action must be create, list, delete, run, status, wait or logs');
  if (!flags.task?.trim()) throw new Error('--task is required');
  const target =
    agentId === DEFAULT_TEAM_AGENT_ID ? catalog.defaultAgent() : catalog.agent(agentId || '');
  if (!target) throw new Error('エージェントが見つかりません');
  let teamDelegation;
  if (flags['allow-teams-json']) {
    if (callerRun) throw new Error('子から委譲権限を付与できません');
    const ids: unknown = JSON.parse(flags['allow-teams-json']);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 16 ||
      ids.some((id) => typeof id !== 'string' || !catalog.team(id))
    )
      throw new Error('--allow-teams-json は登録済みTeam IDの配列で指定してください');
    const ancestorAgentIds = [agentId!, session?.selectedAgentId || DEFAULT_TEAM_AGENT_ID];
    if (
      ids.some((id) => catalog.team(id)!.members.some((m) => ancestorAgentIds.includes(m.agentId)))
    )
      throw new Error('委譲先Teamにリーダー自身または親の担当を含めることはできません');
    teamDelegation = teamGrant(flags, ids as string[], ancestorAgentIds);
  }
  const selfDelegation =
    !callerRun && !!session && agentId === (session.selectedAgentId || DEFAULT_TEAM_AGENT_ID);
  const running = runs
    .list()
    .filter((r) => r.parentContextKey === parent && ['queued', 'running'].includes(r.status));
  const reservation = JSON.stringify([parent, agentId]);
  const reservedForParent = [...reservations].filter((key) => {
    const [owner, id] = JSON.parse(key);
    return owner === parent && !running.some((r) => r.agentId === id);
  }).length;
  if (delegationScopeCount(runs, parent, false) + reservedForParent >= delegationLimit())
    throw new Error(`同時に依頼できる担当は${delegationLimit()}件までです。結果を待ってください`);
  if (reservations.has(reservation) || running.some((r) => r.agentId === agentId))
    throw new Error('この担当への依頼は実行中です');
  reservations.add(reservation);
  try {
    const execution = catalog.execution(undefined, agentId)!;
    const run = await start({
      task: flags.task,
      instruction: execution.prompt,
      backend: execution.backend,
      model: execution.model,
      effort: execution.effort,
      workspaceId: execution.workspaceId,
      localLlmMode: execution.localLlmMode,
      localLlmReasoningEffort: execution.localLlmReasoningEffort,
      agentId,
      selfDelegation,
      teamDelegation,
      parentContextKey: parent,
      parentPlatform: context?.platform,
      title: `依頼: ${target.name}`,
    });
    return JSON.stringify({
      ...run,
      ...(callerRun
        ? {
            nextStep:
              'Use agent wait --id ' +
              run.id +
              ' until completed, then incorporate the answer before completing your own task.',
          }
        : {}),
    });
  } finally {
    reservations.delete(reservation);
  }
}

/** Team reads and delegation share the live catalog, run store and admission limit. */
export async function executeTeamCommand(
  flags: Record<string, string>,
  context?: { channelId?: string; platform?: ChatPlatform },
  dependencies = active
): Promise<string> {
  if (!dependencies) throw new Error('Teams require Web Chat to be enabled');
  const { catalog, runs, start } = dependencies;
  const action = flags.action || 'list';
  if (action === 'list') {
    return JSON.stringify({
      teams: catalog.teams().map((team) => ({
        id: team.id,
        name: team.name,
        members: team.members.length,
        leadership: team.leadership,
        ...(team.leaderAgentId ? { leaderAgentId: team.leaderAgentId } : {}),
        maxConcurrency: team.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY,
        serializeWorkspaces: team.serializeWorkspaces ?? false,
        structure: team.members.some((m) => m.reportsTo) ? 'hierarchy' : 'parallel',
      })),
    });
  }
  const parent = context?.channelId;
  const callerRun = parent
    ? runs
        .list()
        .find((run) => run.parentContextKey && run.appSessionId === webAppSessionId(parent))
    : undefined;
  if (action === 'create') {
    if (!parent) throw new Error('現在の会話が必要です');
    if (callerRun) throw new Error('子エージェントから設定を作成することはできません');
    if (!flags.name?.trim() || !flags['members-json'])
      throw new Error('--name と --members-json は必須です');
    if (
      flags['serialize-workspaces'] !== undefined &&
      !['true', 'false'].includes(flags['serialize-workspaces'])
    )
      throw new Error('--serialize-workspaces は true または false で指定してください');
    const team = catalog.saveTeam({
      name: flags.name,
      prompt: flags.prompt || '',
      leadership: 'caller',
      members: JSON.parse(flags['members-json']),
      leaderAgentId: flags['leader-agent-id'],
      maxConcurrency:
        flags['max-concurrency'] === undefined ? undefined : Number(flags['max-concurrency']),
      serializeWorkspaces: flags['serialize-workspaces'] === 'true',
    });
    return JSON.stringify({ team });
  }
  const resolveTeam = () => {
    const key = (flags.team || '').trim();
    const snapshot = callerRun?.delegationTeam;
    if (snapshot && (snapshot.id === key || snapshot.name === key)) return snapshot;
    const byId = catalog.team(key);
    if (byId) return byId;
    const matches = catalog.teams().filter((team) => team.name === key);
    if (matches.length > 1) throw new Error('同名のTeamが複数あります。IDで指定してください');
    if (!matches.length) throw new Error('Teamが見つかりません');
    return matches[0];
  };
  if (action === 'delete') {
    if (!parent) throw new Error('現在の会話が必要です');
    if (callerRun) throw new Error('子エージェントから設定を削除することはできません');
    const team = resolveTeam();
    if (
      runs
        .list()
        .some(
          (run) => unfinished(run) && (run.teamId === team.id || run.delegationTeam?.id === team.id)
        )
    )
      throw new Error('使用中のTeamです。実行の完了を待ってください');
    removeRegisteredTeam(team.id, catalog);
    return JSON.stringify({ ok: true, team });
  }
  if (action === 'show') {
    const team = resolveTeam();
    const agents =
      callerRun?.delegationTeam?.id === team.id
        ? callerRun.delegationTeam.agents
        : catalog.teamAgent(team.id)!.team!.agents;
    return JSON.stringify({
      ...team,
      maxConcurrency: team.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY,
      serializeWorkspaces: team.serializeWorkspaces ?? false,
      members: team.members.map((member) => ({
        ...member,
        agent: agents.find((agent) => agent.id === member.agentId),
      })),
    });
  }
  if (!parent) throw new Error('現在の会話が必要です');
  if (action === 'status' || action === 'wait' || action === 'logs') {
    let run = runs.get(flags.id || '');
    if (!run || run.parentContextKey !== parent || !run.agentId?.startsWith('team:'))
      throw new Error('この会話のTeam依頼が見つかりません');
    const deadline = Date.now() + (action === 'wait' ? 25_000 : 0);
    while (['queued', 'running'].includes(run.status) && Date.now() < deadline) {
      await delay(200);
      run = runs.get(run.id)!;
    }
    const members = runs
      .list()
      .filter(
        (member) =>
          (run.delegationTeam
            ? member.delegationRootId === run.id && !!member.teamTurnId
            : member.parentContextKey === `web-chat:${run.appSessionId}`) &&
          member.teamId === run.agentId!.slice('team:'.length)
      );
    const snapshot =
      run.delegationTeam || getSessionEntry(run.appSessionId)?.selectedAgentConfig?.team;
    if (action === 'logs') {
      const page = logPageOptions(flags);
      const selected = flags.member
        ? members.filter((member) => member.id === flags.member || member.agentId === flags.member)
        : members;
      if (flags.member && !selected.length)
        throw new Error('このTeam依頼のメンバーが見つかりません');
      const logs = [];
      for (const member of selected)
        logs.push({
          name: snapshot?.agents.find((agent) => agent.id === member.agentId)?.name,
          ...(await inspectAgentRunLogs(member, page)),
        });
      return JSON.stringify({ id: run.id, status: run.status, members: logs });
    }
    return JSON.stringify({
      ...run,
      members: members.map((member) => ({
        id: member.id,
        agentId: member.agentId,
        name: snapshot?.agents.find((agent) => agent.id === member.agentId)?.name,
        role: snapshot?.members.find((entry) => entry.agentId === member.agentId)?.role,
        phase: member.teamPhase,
        status: member.status,
        result: member.result,
        error: member.error,
        startedAt: member.startedAt,
        completedAt: member.completedAt,
        usage: member.usage,
      })),
    });
  }
  if (action !== 'run')
    throw new Error('action must be create, delete, list, show, run, status, wait or logs');
  if (!flags.task?.trim()) throw new Error('--task is required');
  if (
    callerRun &&
    (!callerRun.teamDelegation ||
      callerRun.teamDelegationClosed ||
      callerRun.delegationRootId ||
      !unfinished(callerRun))
  )
    throw new Error('子エージェントからの再委譲はできません');
  const team = resolveTeam();
  if (callerRun) {
    const policy = callerRun.teamDelegation!;
    if (!policy.teamIds.includes(team.id)) throw new Error('このTeamへの委譲は許可されていません');
    if (Date.now() >= policy.deadline) throw new Error('委譲の共通期限を過ぎています');
    if (team.members.some((m) => policy.ancestorAgentIds.includes(m.agentId)))
      throw new Error('リーダー自身または親への循環委譲はできません');
    const previous = delegatedRuns(runs, callerRun.id);
    if (previous.some(unfinished))
      throw new Error('委譲先の作業が実行中です。結果を待ってください');
  }
  const snapshot =
    callerRun?.delegationTeam?.id === team.id
      ? callerRun.delegationTeam
      : catalog.teamAgent(team.id)!.team!;
  const startsLeader = !callerRun && !!team.leaderAgentId;
  const assignments =
    !startsLeader && team.leadership === 'caller'
      ? validateTeamAssignments(
          snapshot,
          flags['assignments-json'] ? JSON.parse(flags['assignments-json']) : undefined,
          !!callerRun
        )
      : undefined;
  // Keep the leader's full grant intact; only this batch receives the selected snapshot.
  const selectedIds = new Set(assignments?.map((assignment) => assignment.agentId));
  const batchSnapshot = callerRun
    ? {
        ...snapshot,
        leaderAgentId: undefined,
        members: snapshot.members.filter((member) => selectedIds.has(member.agentId)),
        agents: snapshot.agents.filter((agent) => selectedIds.has(agent.id)),
      }
    : undefined;
  if (callerRun) {
    const launched = delegatedRuns(runs, callerRun.id).reduce(
      (n, run) => n + (run.delegatedMemberCount || 0),
      0
    );
    if (launched + batchSnapshot!.members.length > callerRun.teamDelegation!.maxMemberRuns)
      throw new Error('依頼全体の累計メンバー実行上限を超えます');
  }
  const agentId = `team:${team.id}`;
  const session = getSessionEntry(getActiveSessionId(parent) || webAppSessionId(parent));
  const ancestors = [team.leaderAgentId!, session?.selectedAgentId || DEFAULT_TEAM_AGENT_ID];
  if (startsLeader && team.members.some((m) => ancestors.includes(m.agentId)))
    throw new Error('リーダー自身または親への循環委譲はできません');
  const grant = startsLeader ? teamGrant(flags, [team.id], ancestors) : undefined;
  if (team.leadership !== 'caller' && session?.selectedAgentId === agentId)
    throw new Error('自分以外のTeamを指定してください');
  const running = runs
    .list()
    .filter((run) => run.parentContextKey === parent && ['queued', 'running'].includes(run.status));
  const reservation = JSON.stringify([parent, callerRun ? 'delegated-team' : agentId]);
  if (reservations.has(reservation) || running.some((run) => run.agentId === agentId))
    throw new Error('このTeamへの依頼は実行中です');
  const reserved = [...reservations].filter((key) => {
    const [owner, id] = JSON.parse(key);
    return owner === parent && !running.some((r) => r.agentId === id);
  }).length;
  if (!callerRun && delegationScopeCount(runs, parent, false) + reserved >= delegationLimit())
    throw new Error(`同時に依頼できる担当は${delegationLimit()}件までです。結果を待ってください`);
  reservations.add(reservation);
  try {
    return JSON.stringify(
      await start({
        task: flags.task,
        teamAssignments: assignments,
        teamLeaderId: startsLeader ? team.leaderAgentId : undefined,
        teamDelegation: grant,
        delegationTeam: startsLeader ? snapshot : undefined,
        teamSnapshot: batchSnapshot,
        delegationRootId: callerRun?.id,
        delegatedMemberCount: batchSnapshot?.members.length,
        agentId,
        parentContextKey: parent,
        parentPlatform: context?.platform,
        title: `Team依頼: ${team.name}`,
      })
    );
  } finally {
    reservations.delete(reservation);
  }
}
