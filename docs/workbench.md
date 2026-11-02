# 共有作業画面 v1

2026-11-02 引き継ぎ後: 独自Terminalの開発は中止。現在のWorkbenchは公式karaage0703/xangi-terminal (terminal.open)をiframe表示する。公式Terminalには以下の独自APIやAI/ユーザー間の端末共有契約を適用しない。表示要求の監視はcapabilityを確認して対応プロバイダーだけに行う。既存のLinuxホストは変更せず、Workbenchの静的UIとフロントエンドのWorkbenchだけでも表示できる。公式Terminal v0.1.3はmanaged時のCSPに同一origin埋め込み許可が必要。詳細と実機検証は隣接xangi-workbenchのREADME・docs/verification.mdを参照。

2026-11-02。実装順は本体 → xangi-workbench → xangi-terminal → xangi-browser。
参照元は xangi-agentic-wrapper の docs/extension-migration.md、src/browser.ts、src/terminal.ts、public/browser.js、public/terminal.js。

本体は既存チャットの横または下にWorkbench拡張のUIを配置する。Workbenchは作業パネルのタブ、分割方向・比率、表示要求の重複排除を管理し、TerminalがPTY、BrowserがChromiumを所有する。v1はチャット＋一つの作業領域で、作業領域内のタブを切り替える。任意の多分割は後続。

## ホスト契約

- schemaVersion 2 / managed-http。`.mjs`のentrypointはホストと同じNodeで実行する。既存の実行ファイル入口も維持する。
- ホストはextension_requestにX-Xangi-Actor: agent、UI/HTTP/WebSocket中継にX-Xangi-Actor: userを付与する。クライアントからの同名ヘッダーは転送しない。拡張はBearer認証に加えてこの値を検証し、本文のactorは信用しない。
- ユーザーAPIは `/api/user/`、AI APIは `/api/agent/`。異なる操作者の経路を拒否する。AIはuser経路から権限を奪えない。
- Workbench iframeから親へのメッセージは `{type:'xangi.workbench.layout',schemaVersion:1,visible,direction,ratio}`。親は同一originとiframeのcontentWindow、スキーマを検証する。URLやHTMLは受け付けない。
- 親からの `{type:'xangi.workbench.visibility',visible}` をWorkbenchから子ビューへ伝え、非表示・非選択時は画像とPTY出力のポーリングを止める。実行は継続する。

## 操作と寿命

Terminalは最大12の独立PTY。ユーザーの表示先とAIの既定作業先を分離する。ログインは新しいユーザー所有PTYを作り、固有requestIdで表示する。ユーザー区間の出力はAIへ返さず、明示返却で破棄する。

Browserは一時BrowserContextと最大20タブ。Wrapperに合わせ、選択中タブは共有、権限はブラウザ全体で管理する。ユーザー所有時は全タブのURL・タイトル・本文・画像をAIに返さない。AIは本文・要素座標を読み、navigate/back/forward/reload/move/click/type/key/scroll/new_tab/switch_tab/close_tabを実行する。任意JS実行は公開しない。ユーザーとAIのポインタ位置は別々に保持する。

パネルを閉じる・隠す操作と実行終了を分離する。stop APIはAI所有の作業だけを止め、拡張プロセス終了では全リソースを破棄する。stdin終了・SIGTERM・SIGINTで停止する。PTY・Chromiumは再起動で復元しない。

v1の実行エンジンは各拡張プロセスに一つ。複数チャットから同じエンジンを共有する。チャットごとの分離、AI停止への自動連動、Tatsuta内蔵ツールの切り替えは別途アダプターが必要。stop API自体は本変更で提供する。

## 検証と導入

認証・操作者偽装・古いversion・表示要求の再実行抑制・実PTY・実Chromium・接頭辞付きUIを検証する。導入は各READMEに従って依存を準備し、manifestをlinkしてstartする。今回の実装作業では既存環境の登録・配備・稼働Tatsutaの切り替えは行わない。

境界線のドラッグは本体が処理し、Workbenchへ {type: 'xangi.workbench.resize', schemaVersion: 1, ratio} を送る。同一origin・親window・15〜85の範囲を検証して内部比率を同期し、通知ループを作らない。スマホは上下境界のタッチドラッグ、キーボードは矢印とHome/Endに対応する。スライダーは表示しない。
