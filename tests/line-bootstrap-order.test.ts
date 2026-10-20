import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  let ready!: () => void;
  return {
    ready: new Promise<void>((resolve) => {
      ready = resolve;
    }),
    release: () => ready(),
    startLine: vi.fn(async () => ({})),
    startTools: vi.fn<() => Promise<void>>(),
    github: vi.fn(),
    extensions: vi.fn(async () => {}),
  };
});
vi.mock('../src/config.js', () => ({
  loadConfig: () => ({
    agent: { backend: 'codex', config: { workdir: process.cwd() } },
    discord: { enabled: false },
    slack: { enabled: false },
    telegram: { enabled: false },
    line: { enabled: true, allowedUsers: ['Utest'], codexTransport: 'app-server' },
    completion: {},
    scheduler: {},
  }),
}));
vi.mock('../src/env-file.js', () => ({ loadRuntimeEnvFile: vi.fn() }));
vi.mock('../src/installer/runtime-config.js', () => ({ applySetupRuntimeEnvFromProcess: vi.fn() }));
vi.mock('../src/setup/runtime-secrets.js', () => ({ loadStoredSecrets: vi.fn() }));
vi.mock('../src/backend-resolver.js', () => ({ BackendResolver: class {} }));
vi.mock('../src/dynamic-runner.js', () => ({
  DynamicRunnerManager: class {
    initializeDefaultRunner() {}
  },
}));
vi.mock('../src/skills.js', () => ({ loadSkills: () => [] }));
vi.mock('../src/slack.js', () => ({ startSlackBot: vi.fn(), isSlackConversationBusy: vi.fn() }));
vi.mock('../src/settings.js', () => ({ initSettings: vi.fn(), loadSettings: vi.fn() }));
vi.mock('../src/scheduler.js', () => ({
  Scheduler: class {
    startAll() {}
  },
}));
vi.mock('../src/sessions.js', () => ({ initSessions: vi.fn() }));
vi.mock('../src/transcript-logger.js', () => ({ initTranscriptStorage: vi.fn() }));
vi.mock('../src/workspace-registry.js', () => ({ WorkspaceRegistry: { open: async () => ({}) } }));
vi.mock('../src/data-dir-lock.js', () => ({ acquireDataDirLock: async () => () => {} }));
vi.mock('../src/events-emitter.js', () => ({ getEventsConfig: () => ({ enabled: false }) }));
vi.mock('../src/inter-instance-chat/index.js', () => ({
  getInterChatConfig: () => ({ enabled: false }),
}));
vi.mock('../src/self-lifecycle.js', () => ({ getSelfLifecyclePermission: () => 'deny' }));
vi.mock('../src/web-chat.js', () => ({ startWebChat: vi.fn() }));
vi.mock('../src/telegram.js', () => ({ startTelegramBot: vi.fn() }));
vi.mock('../src/line.js', () => ({ startLineBot: state.startLine }));
vi.mock('../src/github-auth.js', () => ({ initGitHubAuth: state.github }));
vi.mock('../src/tool-server.js', () => ({ startToolServer: state.startTools }));
vi.mock('../src/event-trigger.js', () => ({
  EventTrigger: class {},
  loadTriggerConfig: () => ({}),
}));
vi.mock('../src/extensions.js', () => ({
  startAutostartExtensions: state.extensions,
  stopManagedExtensions: vi.fn(),
}));
vi.mock('../src/discord/slash-commands.js', () => ({
  buildSlashCommands: vi.fn(),
  createInteractionHandler: vi.fn(),
}));
vi.mock('../src/discord/message-handler.js', () => ({
  processReplySuggestion: vi.fn(),
  registerDiscordMessageHandlers: vi.fn(),
}));
vi.mock('../src/discord/scheduler-bridge.js', () => ({ registerDiscordSchedulerBridge: vi.fn() }));
vi.mock('../src/discord/destination-label.js', () => ({
  resolveCachedDiscordDestinationLabel: vi.fn(),
  warmDiscordScheduleDestinations: vi.fn(),
}));
vi.mock('../src/discord/ui.js', () => ({ registerDiscordTimeoutUi: vi.fn() }));
vi.mock('../src/settings-channels.js', () => ({ listDiscordSettingsChannels: vi.fn() }));
vi.mock('../src/stream-finalizer.js', () => ({ finalizeActiveStreams: vi.fn() }));

const initialSignals = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
};
afterEach(async () => {
  state.release();
  await vi.waitFor(() => expect(state.extensions).toHaveBeenCalled());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!initialSignals[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.unstubAllEnvs();
});

it('does not accept LINE messages until GitHub auth and tool-server listening are ready', async () => {
  vi.stubEnv('WEB_CHAT_ENABLED', 'false');
  vi.stubEnv('XANGI_EVENTS_SERVER_ENABLED', 'false');
  vi.stubEnv('XANGI_REMOTE_PLATFORM_ENABLED', 'false');
  state.startTools.mockImplementation(() => state.ready);
  await import('../src/index.js');
  await vi.waitFor(() => expect(state.startTools).toHaveBeenCalledTimes(1));
  expect(state.github).toHaveBeenCalledTimes(1);
  expect(state.startLine).not.toHaveBeenCalled();
  state.release();
  await vi.waitFor(() => expect(state.startLine).toHaveBeenCalledTimes(1));
});
