import type { BackendResolver } from './backend-resolver.js';
import {
  listSettingsChannelsWithTimeout,
  settingsChannelListErrorMessage,
  type SettingsChannel,
  type SettingsChannelLister,
  type SettingsPlatform,
} from './settings-channels.js';

/** Read saved overrides only; model discovery and provider calls are never needed. */
export async function configuredChannelsSnapshot(
  platform: SettingsPlatform,
  resolver: BackendResolver,
  lister?: SettingsChannelLister
) {
  const idPattern = platform === 'discord' ? /^\d{17,20}$/ : /^[CGD][A-Z0-9]+$/;
  const entries = [...resolver.getChannelOverrides()].filter(
    ([id, override]) => idPattern.test(id) && Object.values(override).some((value) => value != null)
  );
  if (!entries.length) return { channels: [] };

  let names: SettingsChannel[] = [];
  let message: string | undefined;
  if (lister) {
    try {
      names = await listSettingsChannelsWithTimeout(lister);
    } catch (error) {
      message = `${settingsChannelListErrorMessage(platform, error)} 保存済みの設定はIDで表示しています。`;
    }
  } else {
    message = 'チャンネル名を取得できないため、保存済みの設定をIDで表示しています。';
  }
  const byId = new Map(names.map((channel) => [channel.id, channel]));
  return {
    channels: entries
      .map(([id, override]) => ({
        id,
        name: byId.get(id)?.name ?? id,
        group: byId.get(id)?.group,
        nameAvailable: byId.has(id),
        override,
      }))
      .sort((a, b) =>
        `${a.group ?? ''}/${a.name}`.localeCompare(`${b.group ?? ''}/${b.name}`, 'ja')
      ),
    ...(message ? { message } : {}),
  };
}
