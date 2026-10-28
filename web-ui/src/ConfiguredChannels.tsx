import { useState } from 'react';
import { getJsonWithTimeout } from './api';

interface ConfiguredChannel {
  id: string;
  name: string;
  group?: string;
  nameAvailable: boolean;
  override: {
    backend?: string;
    model?: string;
    effort?: string;
    localLlmMode?: string;
    localLlmReasoningEffort?: string;
  };
}
interface Snapshot {
  channels: ConfiguredChannel[];
  message?: string;
}

export function ConfiguredChannels({
  platform,
  onSelect,
}: {
  platform: 'discord' | 'slack';
  onSelect: (channel: { id: string; name: string; group?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setLoading(true);
    setError('');
    try {
      setSnapshot(
        await getJsonWithTimeout<Snapshot>(
          `/api/runtime-settings/configured-channels?platform=${platform}`,
          12_000,
          '設定一覧の取得がタイムアウトしました。再試行してください。'
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="settings-configured-channels">
      <button
        type="button"
        className="secondary"
        aria-expanded={open}
        aria-controls="configured-channel-list"
        onClick={() => {
          setOpen(!open);
          if (!open && !snapshot && !loading) void load();
        }}
      >
        {open ? '個別設定の一覧を閉じる' : '個別設定のあるチャンネルを見る'}
      </button>
      {open && (
        <div id="configured-channel-list" aria-busy={loading}>
          <div className="settings-channel-status">
            <p role="status">
              {loading
                ? '個別設定を読み込み中…'
                : snapshot
                  ? `個別設定：${snapshot.channels.length}チャンネル`
                  : ''}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => void load()}
            >
              {error ? '再試行' : '設定一覧を更新'}
            </button>
          </div>
          <p className="settings-configured-note">
            保存済みのバックエンド・モデル設定です。エージェントやチームを指定している場合は、その設定が優先されます。
          </p>
          {error && <p role="alert">{error}</p>}
          {snapshot?.message && <p role="status">{snapshot.message}</p>}
          {snapshot && !loading && !snapshot.channels.length && (
            <p>このプラットフォームにバックエンドの個別設定があるチャンネルはありません。</p>
          )}
          {snapshot && snapshot.channels.length > 0 && (
            <ul className="settings-configured-list">
              {snapshot.channels.map((channel) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    className="secondary settings-configured-name"
                    onClick={() => {
                      onSelect(channel);
                      setOpen(false);
                      setSnapshot(undefined);
                    }}
                  >
                    {channel.group && <small>{channel.group}</small>}
                    <strong>{channel.nameAvailable ? channel.name : `ID: ${channel.id}`}</strong>
                    <span>設定を開く</span>
                  </button>
                  <dl>
                    <div>
                      <dt>バックエンド</dt>
                      <dd>{channel.override.backend || '全体設定を継承'}</dd>
                    </div>
                    <div>
                      <dt>モデル</dt>
                      <dd>{channel.override.model || '未指定'}</dd>
                    </div>
                    <div>
                      <dt>推論強度</dt>
                      <dd>
                        {channel.override.localLlmReasoningEffort ||
                          channel.override.effort ||
                          '未指定'}
                      </dd>
                    </div>
                    {channel.override.localLlmMode && (
                      <div>
                        <dt>動作モード</dt>
                        <dd>{channel.override.localLlmMode}</dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
