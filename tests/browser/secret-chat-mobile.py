"""Run after build with uv run --with playwright python tests/browser/secret-chat-mobile.py."""
import asyncio
import mimetypes
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2] / 'web/app'

async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True)
        page = await context.new_page()
        await page.add_init_script('window.EventSource=class{addEventListener(){} close(){}}')
        created = []
        async def route(r):
            path = urlparse(r.request.url).path
            if path == '/api/sessions' and r.request.method == 'POST':
                created.append(r.request.post_data_json)
                await r.fulfill(json={'sessionId':'secret_test'})
            elif path == '/api/sessions/secret_test':
                await r.fulfill(json={'id':'secret_test','title':'シークレット','platform':'web','lifecycle':'open','messages':[]})
            elif path == '/api/sessions':
                await r.fulfill(json={'sessions':[], 'meta':{'hasMore':False}})
            elif path.startswith('/api/'):
                await r.fulfill(json={'agents':[],'teams':[],'projects':[],'history':[],'commands':[],'skills':[],'models':[],'backends':[]})
            else:
                f = ROOT / path.removeprefix('/app/').lstrip('/')
                if not f.is_file(): f = ROOT / 'index.html'
                await r.fulfill(body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        await page.route('**/*', route)
        await page.goto('http://chat.test/')
        await page.get_by_role('button', name='サイドバーを開く').click()
        summary = page.get_by_label('新しい会話の種類と担当')
        await summary.click()
        await summary.focus()
        # Safari can blur the summary without focusing a tapped button.
        await summary.evaluate("e => e.dispatchEvent(new FocusEvent('focusout', {bubbles:true, relatedTarget:null}))")
        await page.get_by_role('button', name='シークレット会話').click(timeout=2000)
        await expect(page.get_by_text('シークレット · Webのみ')).to_be_visible()
        assert len(created) == 1 and created[0]['secret'] is True, created
        await page.get_by_role('button', name='サイドバーを開く').click()
        await summary.click()
        await page.keyboard.press('Escape')
        await expect(page.get_by_role('button', name='シークレット会話')).not_to_be_visible()
        print('PASS: secret conversation opens after focus leaves the menu summary')
        await browser.close()

asyncio.run(main())
