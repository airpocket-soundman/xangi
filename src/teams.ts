import { instanceCliCommand } from './instance-cli.js';
import { WebProjectError, normalizeName, normalizePrompt } from './web-projects.js';
import type { SharedAgent } from './project-catalog.js';

export interface TeamMember {
  agentId: string;
  role: string;
  reportsTo?: string;
}
export interface Team {
  id: string;
  name: string;
  prompt: string;
  members: TeamMember[];
  leadership?: 'caller' | 'fixed';
  leaderAgentId?: string;
  maxConcurrency?: number;
  serializeWorkspaces?: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface TeamSnapshot extends Team {
  agents: SharedAgent[];
  assignments?: Array<{ agentId: string; task: string }>;
}
export const DEFAULT_TEAM_CONCURRENCY = 16;
export const MAX_TEAM_CONCURRENCY = 64;

/** Reserved default agent for Teams and direct requests; it is not a separately editable catalog Agent. */
export const DEFAULT_TEAM_AGENT_ID = 'xangi:default';
export function defaultTeamAgent(): SharedAgent {
  return {
    id: DEFAULT_TEAM_AGENT_ID,
    name: 'デフォルト（普段のxangi）',
    role: 'メンバー',
    prompt: '',
    workspaceId: 'default',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}
export const teamAgentId = (id: string) => `team:${id}`;
export function normalizeTeam(input: Record<string, unknown>, agents: SharedAgent[]) {
  const fail = (message: string): never => {
    throw new WebProjectError(message, 400);
  };
  if (typeof input.name !== 'string') fail('Team名を指定してください');
  if (input.prompt !== undefined && typeof input.prompt !== 'string') fail('共通指示が不正です');
  const leadership = input.leadership ?? 'caller';
  if (leadership !== 'caller') return fail('リーダー設定が不正です');
  if (input.leaderAgentId !== undefined && typeof input.leaderAgentId !== 'string')
    fail('リーダー設定が不正です');
  const leaderAgentId = input.leaderAgentId || undefined;
  if (
    leaderAgentId !== undefined &&
    (typeof leaderAgentId !== 'string' ||
      (leaderAgentId !== DEFAULT_TEAM_AGENT_ID && !agents.some((a) => a.id === leaderAgentId)))
  )
    fail('リーダーのAgentが見つかりません');
  const maxConcurrency =
    input.maxConcurrency === undefined ? DEFAULT_TEAM_CONCURRENCY : input.maxConcurrency;
  if (
    typeof maxConcurrency !== 'number' ||
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_TEAM_CONCURRENCY
  )
    return fail('同時実行数は1〜64の整数で指定してください');
  if (input.serializeWorkspaces !== undefined && typeof input.serializeWorkspaces !== 'boolean')
    return fail('ワークスペースの順番待ち設定が不正です');
  const serializeWorkspaces = input.serializeWorkspaces ?? false;
  const raw = input.members;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64)
    return fail('Teamのメンバーは1〜64名で指定してください');
  const members: TeamMember[] = raw.map((m: unknown) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return fail('メンバー設定が不正です');
    const value = m as Record<string, unknown>;
    if (
      typeof value.agentId !== 'string' ||
      (value.agentId !== DEFAULT_TEAM_AGENT_ID && !agents.some((a) => a.id === value.agentId))
    )
      return fail('メンバーのAgentが見つかりません');
    if (value.role !== undefined && (typeof value.role !== 'string' || value.role.length > 2000))
      return fail('チーム内の担当は2000文字以内で指定してください');
    if (value.reportsTo !== undefined && typeof value.reportsTo !== 'string')
      return fail('報告先が不正です');
    return {
      agentId: value.agentId,
      role: typeof value.role === 'string' ? value.role.trim() : '',
      reportsTo: value.reportsTo || undefined,
    } as TeamMember;
  });
  if (leadership === 'caller' && members.some((m) => m.reportsTo))
    fail('呼び出し元がリーダーの場合、メンバーの報告先は指定しません');
  if (leaderAgentId && members.some((m) => m.agentId === leaderAgentId))
    fail('リーダーと作業メンバーは別のAgentを指定してください');
  const ids = new Set(members.map((m) => m.agentId));
  if (ids.size !== members.length) fail('同じAgentを重複して登録できません');
  return {
    name: normalizeName(input.name as string),
    prompt: normalizePrompt((input.prompt as string) || ''),
    members,
    leadership: leadership as 'caller' | 'fixed',
    maxConcurrency,
    serializeWorkspaces,
    leaderAgentId: leaderAgentId as string | undefined,
  };
}

/** No extra leader session: the caller supplies complete independent assignments. */
export function validateTeamAssignments(
  team: TeamSnapshot,
  input: unknown,
  allowSubset = false
): Array<{ agentId: string; task: string }> {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    (!allowSubset && input.length !== team.members.length) ||
    new Set(input.map((a) => a?.agentId)).size !== input.length ||
    !input.every(
      (a) =>
        a &&
        team.members.some((m) => m.agentId === a.agentId) &&
        typeof a.task === 'string' &&
        a.task.trim() &&
        a.task.length <= 12000
    )
  )
    throw new WebProjectError(
      allowSubset
        ? 'チーム内のメンバーへ重複・空欄のない依頼を --assignments-json で1件以上指定してください'
        : '全メンバーへの独立した依頼を --assignments-json で指定してください。team showでIDを確認できます',
      400
    );
  return input.map((a) => ({ agentId: a.agentId, task: a.task.trim() }));
}
export function teamCallerInstructions(team: TeamSnapshot): string {
  if (team.leaderAgentId)
    return `Team to use: ${team.name} (ID: ${team.id}). This Team has a designated leader. Read ${instanceCliCommand} team --help and use team run with --task containing the full request and necessary context. Do not supply member assignments or start another leader. The configured leader will plan, dispatch only this Team's members, review, and integrate their results. Wait for the Team result and relay it to the user.`;
  return `Team to use: ${team.name} (ID: ${team.id}). You are the leader; do not start another leader.
${team.prompt}
Members: ${JSON.stringify(team.members)}
Check prerequisites in the conversation and reference material. If required information is missing, ask the user and do not start the Team yet.
Read ${instanceCliCommand} team --help, then use team run to dispatch independent tasks to all members together. Pass shared context, evidence, and assumptions in --task, and use --assignments-json with [{"agentId":"ID","task":"a concrete self-contained assignment for this member"}] . Do not make assignments depend on waiting for sibling results.
After dispatch, wait for completion notifications, review the results, and provide the final answer yourself. Do not restart the same investigation in response to a completion notification.`;
}

/** Convert persisted hierarchy metadata without discarding named Agents or their instructions. */
export function upgradeLegacyTeam<T extends Team>(team: T): T {
  if (team.leadership === 'caller' && !team.members.some((m) => m.reportsTo)) return team;
  const root = team.members.find((m) => !m.reportsTo);
  const members =
    root?.agentId === DEFAULT_TEAM_AGENT_ID &&
    team.members.length > 1 &&
    team.members.some((m) => m.reportsTo)
      ? team.members.filter((m) => m !== root)
      : team.members;
  return {
    ...team,
    leadership: 'caller',
    members: members.map(({ reportsTo: _retired, ...member }) => member),
  };
}
