"""On-demand configured channels: request isolation and PC/mobile workflows."""
import json
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='configured-channels-browser-'))
print(out, flush=True)
runtime = {'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex'], 'applyMode': 'next-turn'}, 'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}}, 'respondToBots': {'enabled': True, 'value': False}}
entries = [{'id': str(123456789012345678+i), 'name': '#開発チャンネル'+str(i), 'group': '開発サーバー', 'nameAvailable': True, 'override': {'backend': 'codex', 'model': 'example-long-model-name-for-layout-check', 'effort': 'high'}} for i in range(24)]
entries[1]['nameAvailable'] = False
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 390]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            pending, calls, errors = [], [], []
            def route(r):
                u = urlparse(r.request.url); path = u.path
                if path == '/api/runtime-settings/configured-channels':
                    calls.append(parse_qs(u.query)['platform'][0]); pending.append(r); return
                if path == '/api/runtime-settings': data = runtime
                elif path == '/api/runtime-settings/channels': data = {'status': 'available', 'channels': [{'id': entries[0]['id'], 'name': entries[0]['name']}]}
                elif path == '/api/runtime-settings/channel': data = {'backend': {'value': 'codex', 'model': entries[0]['override']['model'], 'effective': {'backend': 'codex'}}, 'llmMode': {'value': 'inherit', 'effective': 'agent'}, 'autoReply': {'value': 'inherit', 'effective': 'off'}}
                elif path == '/api/startup-settings': data = {'groups': []}
                elif path == '/api/connection-settings': data = {'groups': [], 'backends': []}
                elif path == '/api/models': data = {'status': 'available', 'models': [], 'supportedEfforts': []}
                elif path == '/api/workspaces': data = {'workspaces': []}
                elif path == '/api/agents': data = {'agents': []}
                elif path == '/api/sessions/stream': r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path == '/settings' else path.removeprefix('/app/'))
                    r.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(file.name)[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto('http://settings.test/settings', wait_until='networkidle')
            card = page.locator('[aria-labelledby="settings-channel-title"]')
            button = card.get_by_role('button', name='個別設定のあるチャンネルを見る')
            expect(button).to_be_visible(); assert calls == []
            button.focus(); page.keyboard.press('Enter')
            expect(card.get_by_text('個別設定を読み込み中…')).to_be_visible()
            expect(card.get_by_label('プラットフォーム')).to_be_enabled()
            page.wait_for_timeout(30); assert len(pending) == 1
            pending.pop().fulfill(json={'channels': entries})
            expect(card.get_by_text('個別設定：24チャンネル')).to_be_visible()
            expect(card.locator('.settings-configured-list > li')).to_have_count(24)
            expect(card.get_by_text('ID: '+entries[1]['id'], exact=True)).to_be_visible()
            assert card.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            card.locator('.settings-configured-channels > button').evaluate('(e) => e.scrollIntoView({block: "start"})')
            page.screenshot(path=str(out / f'overview-{width}.png'))
            card.get_by_role('button', name='個別設定の一覧を閉じる').click(); button.click()
            expect(card.get_by_text('個別設定：24チャンネル')).to_be_visible(); assert len(calls) == 1
            card.locator('.settings-configured-name').last.click()
            expect(card.get_by_label('チャンネル', exact=True)).to_have_value(entries[-1]['id'])
            expect(card.get_by_label('チャンネル', exact=True)).to_be_focused()
            button.click(); page.wait_for_timeout(30)
            pending.pop().fulfill(status=500, json={'error': '一覧取得テストエラー'})
            expect(card.get_by_role('alert')).to_have_text('一覧取得テストエラー')
            card.get_by_role('button', name='再試行', exact=True).click(); page.wait_for_timeout(30)
            pending.pop().fulfill(json={'channels': []})
            expect(card.get_by_text('このプラットフォームにバックエンドの個別設定があるチャンネルはありません。')).to_be_visible()
            card.get_by_label('プラットフォーム').select_option('slack')
            expect(button).to_have_attribute('aria-expanded', 'false'); assert len(calls) == 3
            button.click(); page.wait_for_timeout(30); assert calls[-1] == 'slack'
            card.get_by_label('プラットフォーム').select_option('discord')
            pending.pop().fulfill(json={'channels': [{'id': 'C123', 'name': '#Slack-only', 'nameAvailable': True, 'override': {'backend': 'codex'}}]})
            expect(button).to_have_attribute('aria-expanded', 'false')
            expect(card.get_by_text('#Slack-only')).to_have_count(0)
            assert not errors, errors
            print(json.dumps({'width': width, 'initial_requests': 0, 'cache': True, 'select_last': True, 'retry_empty': True, 'platform_race': True}))
            context.close()
    finally: browser.close()
