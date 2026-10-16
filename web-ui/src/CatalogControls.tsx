import { useRef, useState, type ReactNode } from 'react';
import { getJson, requestJson } from './api';
import { openSetupSession } from './extensionSetup';

export function CatalogCreateButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const openingRef = useRef(false);

  async function consult() {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError('');
    try {
      const { instanceCliCommand: cli } = await getJson<{ instanceCliCommand?: string }>(
        '/api/config'
      );
      if (!cli?.trim())
        throw new Error('実行用CLIを取得できませんでした。画面を更新してください。');
      const { sessionId } = await requestJson<{ sessionId: string }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'default' }),
      });
      const displayMessage = `${label}を作りたいので、相談に乗ってください。`;
      openSetupSession({
        sessionId,
        displayMessage,
        prompt: `${displayMessage}
設定画面から開始した作成相談です。まず用途や希望を聞いてください。
現在の会話は相談用のdefaultワークスペースです。作成先と同じとは限りません。

以下は現在のxangiインスタンス専用のCLIです。PATH上のxangiへ置き換えないでください。
利用できるコマンド（実行前に ${cli} tool help workspace / agent / team で最新の引数・制約を確認）:
- ${cli} workspace list
- ${cli} agent list
- ${cli} team list
- ${cli} workspace create --name NAME --path ABSOLUTE_PATH
- ${cli} agent create --name NAME --workspace-id ID --prompt TEXT
- ${cli} team create --name NAME --members-json '[{"agentId":"ID","role":"役割"}]' --prompt TEXT
- ${cli} team show NAME_OR_ID
削除を明示的に依頼された場合だけ、${cli} team delete NAME_OR_ID / ${cli} agent delete AGENT_ID / ${cli} workspace delete WORKSPACE_IDを使用できます。Workspaceは登録解除のみでファイルは保持されます。使用中なら参照元を説明し、無理に消さないでください。
チームのリーダーや同時実行数などの任意設定はteamのhelpを参照してください。

最初に3種類の一覧を取得し、登録済みの名前・ID・作業場所・担当を確認してください。上記のNAME/ID/TEXTは例示なので、そのまま実行しないでください。
用途に必要な名前、作業場所、担当への指示、メンバー構成を会話で具体化し、既存設定を再利用できるなら提案してください。チームには利用可能ならデフォルト担当 xangi:default も使えます。

ワークスペースの場所を決める前に、候補の実パス（シンボリックリンク先を含む）と上位ディレクトリのAGENTS.md、AGENTS.override.md、CLAUDE.md、Gitルートを確認してください。指示ファイルの探索範囲はバックエンドによって異なり、登録だけでは親の指示から隔離されません。
独立した用途なら既存ワークスペースやリポジトリの配下を避けた兄弟ディレクトリなどを提案してください。親の指示を引き継ぐ場所なら対象ファイルと影響を説明し、利用者の意図を確認してください。子のAGENTS.mdを置けば親の指示がすべて無効になるとは扱わないでください。既存の親の指示は変更しないでください。
workspace createは既存ディレクトリの登録です。新しいフォルダは作成を依頼された場合に用意し、登録可能範囲を勝手に広げないでください。

設定ファイルを直接編集せず、上記の作成コマンドを使って必要な依存から順に保存してください。保存後は一覧やteam showで結果を確認し、途中で失敗したら成功済みのIDを保持して重複作成を避けてください。チームの作成だけで実行はしないでください。`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      openingRef.current = false;
      setOpening(false);
    }
  }

  return (
    <div className="catalog-create-actions">
      <button
        type="button"
        className="primary catalog-create"
        aria-label={`${label}を作成`}
        onClick={onClick}
        disabled={disabled || opening}
      >
        ＋ 作成
      </button>
      <button
        type="button"
        className="secondary catalog-create"
        aria-label={`${label}をAIと相談して作成`}
        onClick={() => void consult()}
        disabled={disabled || opening}
      >
        {opening ? '会話を準備中…' : 'AIと相談して作成'}
      </button>
      {error && <p role="alert">会話を開けませんでした: {error}</p>}
    </div>
  );
}

export function CatalogRow({
  name,
  children,
  onEdit,
  onDelete,
  deleteLabel = '削除',
  disabled,
  deleteDisabled,
  disabledReason,
}: {
  name: string;
  children?: ReactNode;
  onEdit: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  disabled?: boolean;
  deleteDisabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="catalog-row">
      <div className="catalog-row-copy">
        <strong>{name}</strong>
        {children}
      </div>
      <div className="catalog-row-actions">
        <button
          type="button"
          className="secondary"
          aria-label={`${name}を編集`}
          disabled={disabled}
          onClick={onEdit}
        >
          編集
        </button>
        {onDelete && (
          <button
            type="button"
            className="danger"
            aria-label={`${name}を${deleteLabel}`}
            disabled={deleteDisabled}
            onClick={onDelete}
          >
            {deleteLabel}
          </button>
        )}
      </div>
      {disabledReason && <small className="catalog-row-note">{disabledReason}</small>}
    </div>
  );
}

export function CatalogFormActions({
  creating,
  saving,
  disabled,
  onCancel,
}: {
  creating: boolean;
  saving: boolean;
  disabled?: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="project-form-actions catalog-form-actions">
      <button type="button" className="secondary" disabled={saving} onClick={onCancel}>
        キャンセル
      </button>
      <button type="submit" className="primary" disabled={saving || disabled}>
        {saving ? '保存中…' : creating ? '作成' : '保存'}
      </button>
    </div>
  );
}
