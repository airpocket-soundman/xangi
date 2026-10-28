"""Run after npm run build:web: uv run --with playwright python tests/browser/chat-composer-height.py.
Uses synthetic API responses; never sends messages to a live backend.
BASELINE=1 verifies the old stuck-height behavior.
"""
import asyncio
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('SCREENSHOT_DIR', '/tmp/chat-composer-height'))

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        try:
            for width, height in [(390, 844), (1280, 900)]:
                context = await browser.new_context(viewport={'width': width, 'height': height})
                page = await context.new_page()
                errors, posts = [], []
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.add_init_script('window.EventSource=class{addEventListener(){} close(){}}')
                session = dict(id='height-test', title='入力欄テスト', platform='web', lifecycle='open', isActive=False, messages=[])
                async def route(r):
                    path = urlparse(r.request.url).path
                    if path == '/api/chat':
                        posts.append(r.request.post_data_json)
                        await r.fulfill(content_type='text/event-stream', body='event: done\ndata: {}\n\n')
                    elif path == '/api/sessions/height-test':
                        await r.fulfill(json=session)
                    elif path == '/api/sessions':
                        await r.fulfill(json={'sessions': [session], 'meta': {'hasMore': False}})
                    elif path.startswith('/api/'):
                        await r.fulfill(json={'agents': [], 'teams': [], 'projects': [], 'history': [], 'commands': [], 'skills': [], 'models': [], 'backends': []})
                    else:
                        f = ROOT / 'web/app' / path.removeprefix('/app/').lstrip('/')
                        if not f.is_file(): f = ROOT / 'web/app/index.html'
                        await r.fulfill(body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
                await page.route('**/*', route)
                await page.goto('http://chat.test/chat/height-test')
                field = page.locator('textarea.pane-input')
                await expect(field).to_be_enabled()
                initial = await field.evaluate('(e) => e.getBoundingClientRect().height')
                long_text = '\n'.join(['長文の入力テストです'] * 12)
                await field.fill(long_text)
                await expect(field).to_have_css('height', '120px')
                await field.fill('短文')
                await expect(field).not_to_have_css('height', '120px')
                assert await field.evaluate('(e) => e.getBoundingClientRect().height') <= 50
                await field.fill(long_text)
                await page.get_by_role('button', name='送信', exact=True).click()
                await expect(field).to_have_value('')
                target = 120 if os.environ.get('BASELINE') else initial
                await expect(field).to_have_css('height', f'{target:g}px')
                await expect(field).to_be_enabled()
                assert posts and posts[0]['message'] == long_text, posts
                await page.screenshot(path=str(OUT / f'{width}.png'))
                assert not errors, errors
                print(json.dumps({'width': width, 'initial': initial, 'after_send': target, 'baseline': bool(os.environ.get('BASELINE')), 'status': 'PASS'}), flush=True)
                await context.close()
        finally:
            await browser.close()

asyncio.run(main())
