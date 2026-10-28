"""Exercise scrolled catalog editors and a pending CLI update in the built UI."""
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
runtime = {
    'backend': {'enabled': True, 'value': {'backend': 'codex'}, 'options': ['codex'], 'applyMode': 'next-turn'},
    'replySuggestions': {'enabled': True, 'value': 'inherit', 'effective': {'web': True, 'discord': True, 'slack': True}, 'applyMode': 'immediate'},
    'respondToBots': {'enabled': True, 'value': False, 'applyMode': 'immediate'},
}
connections = {'groups': [], 'backends': [{'id': 'codex', 'label': 'Codex', 'installed': True, 'version': 'old', 'state': 'logged-in', 'apiKeyConfigured': False, 'updateSupported': True}]}
agents = [{'id': f'a{i}', 'name': f'Agent{i}', 'prompt': ''} for i in range(40)]
workspaces = [{'id': f'w{i}', 'name': f'Workspace{i}', 'path': f'/srv/{i}', 'isDefault': False} for i in range(40)]
teams = [{'id': f't{i}', 'name': f'Team{i}', 'prompt': '', 'members': []} for i in range(40)]

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'), headless=True, args=['--no-sandbox'])
    try:
        for width in (1280, 390):
            context = browser.new_context(viewport={'width': width, 'height': 800})
            pending, saved = [], []
            def route(r):
                path = urlparse(r.request.url).path
                if path == '/api/backend-tools/update':
                    pending.append(r)
                    return
                if path == '/api/runtime-settings':
                    if r.request.method == 'POST':
                        saved.append(r.request.post_data_json)
                        data = {'message': '保存しました', 'settings': runtime}
                    else: data = runtime
                elif path == '/api/config': data = {'allowedBackends': ['codex']}
                elif path == '/api/connection-settings': data = connections
                elif path == '/api/startup-settings': data = {'groups': []}
                elif path == '/api/runtime-settings/channels': data = {'status': 'disabled', 'channels': []}
                elif path == '/api/models': data = {'status': 'available', 'models': [], 'supportedEfforts': []}
                elif path == '/api/workspaces': data = {'workspaces': workspaces}
                elif path == '/api/agents': data = {'agents': agents}
                elif path == '/api/teams': data = {'teams': teams, 'agents': agents}
                elif path == '/api/sessions/stream':
                    r.fulfill(content_type='text/event-stream', body=': ready\n\n'); return
                elif path.startswith('/api/'): data = {}
                else:
                    file = root / ('index.html' if path == '/settings' else path.removeprefix('/app/'))
                    r.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(file.name)[0] or 'application/octet-stream'); return
                r.fulfill(json=data)
            context.route('**/*', route)
            page = context.new_page()
            for section, name in [('workspaces', 'Workspace39'), ('agents', 'Agent39'), ('teams', 'Team39')]:
                page.goto(f'http://settings.test/settings#{section}')
                area = page.locator(f'#{section}')
                area.get_by_role('button', name=f'{name}を編集').click()
                form = area.locator('form.project-form')
                expect(form).to_be_focused()
                y = form.bounding_box()['y']
                assert 0 <= y < 120, (width, section, y)
                form.get_by_role('button', name='キャンセル').click()
            page.goto('http://settings.test/settings')
            page.get_by_role('button', name='更新', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='更新する').click()
            expect(page.get_by_role('dialog')).not_to_be_visible()
            expect(page.get_by_text('Codexを更新中です。ほかの操作を続けられます。')).to_be_visible()
            expect(page.get_by_role('button', name='更新中…')).to_be_disabled()
            page.locator('#respond-bots-setting').select_option('on')
            expect(page.get_by_text('保存しました', exact=True)).to_be_visible()
            assert saved and pending
            pending.pop().fulfill(json={**connections, 'message': 'Codexを更新しました'})
            expect(page.get_by_text('Codexを更新しました', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='更新', exact=True)).to_be_enabled()
            page.get_by_role('button', name='更新', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='更新する').click()
            expect(page.get_by_role('dialog')).not_to_be_visible()
            page.wait_for_function("document.querySelector('.settings-auth-update')?.textContent === '更新中…'")
            assert pending
            pending.pop().fulfill(status=400, json={'error': '更新に失敗しました'})
            expect(page.get_by_role('alert')).to_contain_text('更新に失敗しました')
            expect(page.get_by_role('button', name='更新', exact=True)).to_be_enabled()
            print(f'PASS width={width}: workspace, agent, team, pending update, concurrent save, success, failure', flush=True)
            context.close()
    finally:
        browser.close()
