const prohibited = /(purchase|checkout|pay(?:ment)?|subscribe|order|donat|transfer|delete|remove|publish|send|submit|confirm|購入|注文|決済|支払|契約|課金|送金|寄付|削除|公開|送信|確定|申込)/i;
const sensitive = /(password|passcode|otp|secret|token|cvv|card|パスワード|認証コード|カード番号)/i;

export function validateAction(action) {
  if (!action || !['navigate','snapshot','click','fill','screenshot'].includes(action.type)) return 'unsupported_action';
  if (action.type === 'click' && (!action.name || prohibited.test(action.name))) return 'approval_required';
  if (action.type === 'fill' && (!action.name || sensitive.test(action.name))) return 'vault_required';
  return null;
}

export function validateUrl(raw, hosts) {
  const url = new URL(raw);
  const loopback = ['localhost','127.0.0.1'].includes(url.hostname);
  if (!((url.protocol === 'https:') || (loopback && url.protocol === 'http:'))) throw Error('scheme_denied');
  if (!hosts.includes(url.hostname)) throw Error('domain_denied');
  if (url.username || url.password) throw Error('credentials_in_url');
  return url.href;
}

export function scrub(text) {
  return String(text).split('\n').filter(line => !sensitive.test(line)).join('\n').slice(0, 20000);
}
