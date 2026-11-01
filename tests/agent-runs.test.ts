import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunStore } from '../src/agent-runs.js';

describe('AgentRunStore', () => {
  it('persists the original parent and receipt across restart, then clears only the receipt for follow-up', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-parent-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const run = store.create({
      task: 'Work', backend: 'codex', workspaceId: 'workspace',
      workspacePath: '/tmp/workspace', appSessionId: 'child',
      parentContextKey: 'thread', parentPlatform: 'discord', parentAppSessionId: 'original-parent',
    });
    store.markSucceeded(run.id, { result: 'done', sessionId: 'provider' });
    store.bindParentDelivery([run.id], 'agent-completion-receipt');
    const restored = AgentRunStore.fromDataDir(dataDir);
    expect(restored.get(run.id)).toMatchObject({
      parentAppSessionId: 'original-parent', parentDeliveryRequestId: 'agent-completion-receipt',
    });
    restored.markRunning(run.id);
    expect(restored.get(run.id)?.parentAppSessionId).toBe('original-parent');
    expect(restored.get(run.id)?.parentDeliveryRequestId).toBeUndefined();
  });

  it('persists a reproducible manifest and terminal usage', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-test-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const created = store.create({
      task: 'Implement the task',
      backend: 'codex',
      model: 'gpt-test',
      effort: 'high',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/workspace-1',
      appSessionId: 'session-1',
    });

    expect(created.status).toBe('queued');
    expect(created.taskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.trajectoryPath).toBeUndefined();

    store.markRunning(created.id);
    const completed = store.markSucceeded(created.id, {
      result: 'done',
      sessionId: 'provider-1',
      usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 },
    });

    expect(completed).toMatchObject({
      status: 'succeeded',
      providerSessionId: 'provider-1',
      result: 'done',
      usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 },
    });
    expect(store.markParentNotified(created.id).parentNotifiedAt).toBeTruthy();
    expect(JSON.parse(readFileSync(join(dataDir, 'agent-runs.json'), 'utf8'))).toMatchObject({
      version: 1,
      runs: [expect.objectContaining({ id: created.id, status: 'succeeded' })],
    });
  });

  it('rejects an empty task', () => {
    const store = AgentRunStore.fromDataDir(mkdtempSync(join(tmpdir(), 'agent-runs-test-')));
    expect(() =>
      store.create({
        task: ' ',
        backend: 'codex',
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/workspace-1',
        appSessionId: 'session-1',
      })
    ).toThrow('task is required');
  });

  it('only exposes a trajectory path after the file exists', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-test-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-runs-workspace-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const created = store.create({
      task: 'Inspect the workspace',
      backend: 'codex',
      workspaceId: 'workspace-1',
      workspacePath,
      appSessionId: 'session-trajectory',
    });
    const trajectoryPath = join(
      workspacePath,
      'logs',
      'tool-trajectory',
      'session-trajectory.jsonl'
    );
    mkdirSync(join(workspacePath, 'logs', 'tool-trajectory'), { recursive: true });
    writeFileSync(trajectoryPath, '{}\n');

    store.markRunning(created.id);
    const completed = store.markSucceeded(created.id, {
      result: 'done',
      sessionId: 'provider-1',
    });
    expect(completed.trajectoryPath).toBe(trajectoryPath);
  });

  it('marks unfinished persisted runs as failed after restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-test-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const created = store.create({
      task: 'Long task',
      backend: 'codex',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/workspace-1',
      appSessionId: 'session-1',
    });
    store.markRunning(created.id);

    const restored = AgentRunStore.fromDataDir(dataDir).get(created.id);
    expect(restored).toMatchObject({
      status: 'failed',
      error: 'xangi restarted before the Agent Run completed',
    });
  });
});
