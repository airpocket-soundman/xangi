"""Build first, then run with uv run --with playwright python tests/browser/chat-mobile-completion.py.
Synthetic API and isolated browser; no live conversations are modified.
"""
import asyncio
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('SCREENSHOT_DIR', '/tmp/chat-mobile-completion'))

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        try:
            for width, height in [(375, 812), (390, 844), (844, 390), (1280, 900)]:
                for state in ['open', 'running', 'closed', 'error']:
                    context = await browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
                    page = await context.new_page()
                    errors, posts = [], []
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    await page.add_init_script('window.EventSource=class{addEventListener(){} close(){}}')
                    session = dict(id='outside-list', title='Monitorから開いた会話', platform='discord', lifecycle='closed' if state == 'closed' else 'open', isActive=state == 'running', messages=[dict(id='m1', role='user', content='履歴を保持する')])
                    async def route(r):
                        path = urlparse(r.request.url).path
                        if path == '/api/sessions/outside-list/close':
                            posts.append(r.request.post_data_json)
                            if state == 'error':
                                await r.fulfill(status=500, json={'error': '保存に失敗しました'})
                            else:
                                session['lifecycle'] = 'closed'
                                await r.fulfill(json={'ok': True})
                        elif path == '/api/sessions/outside-list':
                            await r.fulfill(json=session)
                        elif path == '/api/sessions':
                            await r.fulfill(json={'sessions': [], 'meta': {'hasMore': False}})
                        elif path.startswith('/api/'):
                            await r.fulfill(json={'agents': [], 'teams': [], 'projects': [], 'history': [], 'commands': [], 'skills': [], 'models': [], 'backends': []})
                        else:
                            f = ROOT / 'web/app' / path.removeprefix('/app/').lstrip('/')
                            if not f.is_file(): f = ROOT / 'web/app/index.html'
                            await r.fulfill(body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
                    await page.route('**/*', route)
                    await page.goto('http://chat.test/chat/outside-list')
                    await expect(page.get_by_text('履歴を保持する', exact=True)).to_be_visible()
                    button = page.get_by_role('button', name='完了して閉じる', exact=True)
                    if state == 'closed':
                        await expect(button).to_have_count(0)
                    else:
                        await expect(button).to_be_visible()
                        box = await button.bounding_box()
                        assert box and box['x'] >= 0 and box['x'] + box['width'] <= width
                        if width <= 768 or height <= 500: assert box['height'] >= 44
                        if state == 'open': await page.screenshot(path=str(OUT / f'{width}-before.png'))
                        await button.click()
                        if state == 'running':
                            await expect(page.get_by_role('dialog')).to_be_visible()
                            assert not posts
                            await page.get_by_role('button', name='中断して完了', exact=True).click()
                        if state == 'error':
                            await expect(page.get_by_text('保存に失敗しました', exact=True)).to_be_visible()
                            await expect(button).to_be_visible()
                            assert session['lifecycle'] == 'open'
                        else:
                            await expect(button).to_have_count(0)
                            assert posts == [{'force': state == 'running'}], posts
                            await page.goto('http://chat.test/chat/outside-list')
                            await expect(page.get_by_text('履歴を保持する', exact=True)).to_be_visible()
                            await expect(button).to_have_count(0)
                    assert not errors, errors
                    await context.close()
                    print(f'PASS {width}x{height} {state}', flush=True)
        finally:
            await browser.close()

asyncio.run(main())
