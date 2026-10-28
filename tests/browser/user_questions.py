"""Question form round-trip against isolated API fixtures; no live chat messages."""
import mimetypes
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(tempfile.mkdtemp(prefix='user-questions-browser-'))
print('Evidence:', out, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 390]:
            context = browser.new_context(viewport={'width': width, 'height': 900})
            pending = [True]
            submissions = []
            session = {'id': 'question-session', 'title': '質問の確認', 'platform': 'web', 'isActive': True, 'status': 'active', 'messages': [], 'updatedAt': '2026-01-01T00:00:00Z'}
            question = {'id': 'request-1', 'expiresAt': 9999999999999, 'questions': [
                {'id': 'color', 'header': '色', 'question': 'どの色を使いますか？', 'options': [{'label': '赤', 'description': '明るい色'}, {'label': '青', 'description': '落ち着いた色'}], 'multiSelect': False, 'allowFreeText': True},
                {'id': 'parts', 'header': '内容', 'question': '含める項目を選んでください', 'options': [{'label': '概要', 'description': ''}, {'label': '詳細', 'description': ''}], 'multiSelect': True, 'allowFreeText': True}]}
            def route(r):
                path = urlparse(r.request.url).path
                if path == '/api/sessions/stream': r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                if path == '/api/config': data = {'uploadAccept': None, 'uploadMaxBytes': 64000000, 'allowedBackends': ['codex']}
                elif path == '/api/sessions': data = {'sessions': [session]}
                elif path == '/api/sessions/question-session': data = session
                elif path.endswith('/turns'): data = {'turns': []}
                elif path == '/api/user-input/question-session':
                    if r.request.method == 'POST':
                        submissions.append(r.request.post_data_json)
                        pending[0] = False
                        data = {'ok': True}
                    else: data = {'questions': [question] if pending[0] else []}
                elif path == '/api/workspaces': data = {'workspaces': [{'id': 'default', 'name': 'default', 'path': '/tmp', 'isDefault': True}]}
                elif path == '/api/projects': data = {'projects': []}
                elif path == '/api/agents': data = {'agents': []}
                elif path == '/api/teams': data = {'teams': []}
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path.startswith('/chat/') else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.is_file() else 404, body=file.read_bytes() if file.is_file() else b'', content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('http://question-test.local/chat/question-session')
            form = page.get_by_role('region', name='回答待ちの質問')
            expect(form).to_be_visible()
            assert form.locator('input:checked').count() == 0
            form.get_by_role('radio', name='青').check()
            form.get_by_role('checkbox', name='概要').check()
            form.get_by_role('checkbox', name='詳細').check()
            assert form.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.screenshot(path=str(out / f'questions-{width}.png'))
            form.get_by_role('button', name='回答を送信').click()
            expect(form).to_have_count(0)
            assert submissions[-1]['answer'] == {'answers': {'color': ['青'], 'parts': ['概要', '詳細']}}
            pending[0] = True
            page.reload()
            expect(form).to_be_visible()
            form.get_by_label('自由入力').first.fill('緑')
            form.get_by_label('自由入力').nth(1).fill('まとめ')
            form.get_by_role('button', name='回答を送信').click()
            expect(form).to_have_count(0)
            assert submissions[-1]['answer']['answers'] == {'color': ['緑'], 'parts': ['まとめ']}
            pending[0] = True
            page.reload()
            expect(form).to_be_visible()
            form.get_by_role('button', name='キャンセル').click()
            expect(form).to_have_count(0)
            assert submissions[-1]['answer'] == {'cancelled': True}
            assert not errors, errors
            print(f'{width}px: choice, multiple, free text, reload and cancel passed', flush=True)
            context.close()
    finally: browser.close()
