"""Project接続設定→新規スレッド→Slack継続を隔離ブラウザで確認する。"""
import mimetypes
from datetime import datetime, timezone
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2] / 'web/app'
out = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/project-channel-browser'))
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/snap/bin/chromium'), headless=True, args=['--no-sandbox'])
    try:
        for width in [1280, 375]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            projects, sessions, posts, errors, pending = [], [], [], [], []
            def route(r):
                u=urlparse(r.request.url); path=u.path; method=r.request.method
                if path.endswith('/stream'):
                    r.fulfill(content_type='text/event-stream',body=': ready\n\n'); return
                if path == '/api/config': data={'uploadAccept':None,'uploadMaxBytes':64000000,'allowedBackends':['codex']}
                elif path == '/api/agents': data={'agents':[{'id':'a1','name':'実装担当','prompt':''}]}
                elif path == '/api/teams': data={'teams':[{'id':'t1','name':'開発チーム'}]}
                elif path == '/api/projects' and method == 'POST':
                    projects.append(dict(r.request.post_data_json,id='p1')); data={'project':projects[-1]}
                elif path == '/api/projects': data={'projects':projects}
                elif path == '/api/runtime-settings/channels': data={'channels':[{'id':'C123','name':'#開発'}]}
                elif path == '/api/sessions' and method == 'POST':
                    body=r.request.post_data_json; posts.append(body)
                    session={'id':'linked-session','title':'開発Project','projectId':'p1','platform':'slack','contextKey':'C123:123.4','updatedAt':'2026-10-23T00:00:00Z','isActive':False,'lifecycle':'open','linkedChannel':True}
                    if body.get('secret'): session.update(id='secret_test',title='シークレット',platform='web',linkedChannel=False)
                    sessions.append(session); data={'sessionId':session['id']}
                elif path == '/api/sessions': data={'sessions':sessions}
                elif path.endswith('/slack-continue'):
                    posts.append(r.request.post_data_json); pending.append(r); return
                elif path.endswith('/close'):
                    posts.append({'closed':path.split('/')[3]}); sessions[:]=[s for s in sessions if s['id']!=path.split('/')[3]]; data={'ok':True}
                elif path.endswith('/turn-history'): data={'history':[]}
                elif path.endswith('/external-chat-link'): data={'platform':'slack','url':'https://example.test/thread'}
                elif path.startswith('/api/sessions/'):
                    data={**next((s for s in sessions if s['id']==path.split('/')[3]), {}),'messages':next((s.get('messages',[]) for s in sessions if s['id']==path.split('/')[3]), []),'total':0,'hasMore':False}
                elif path.startswith('/api/'): data={}
                else:
                    file=root/('index.html' if path=='/' or path.startswith('/chat/') else path.removeprefix('/app/').lstrip('/'))
                    r.fulfill(status=200 if file.exists() else 404,body=file.read_bytes() if file.exists() else b'',content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream');return
                r.fulfill(json=data)
            context.route('**/*',route)
            page=context.new_page();page.set_default_timeout(10000);page.on('pageerror',lambda e: errors.append(str(e)))
            page.goto('http://project-test.test/')
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            expect(page.locator('.sidebar-projects')).to_have_count(1)
            page.get_by_role('button',name='新規プロジェクト',exact=True).click()
            form=page.locator('.project-form')
            form.get_by_label('名前',exact=True).fill('開発Project')
            form.get_by_label('共通指示').fill('変更を検証してください')
            form.get_by_label('新しい会話の担当').select_option('team:t1')
            form.get_by_role('combobox',name='接続先',exact=True).select_option('slack')
            form.get_by_role('combobox',name='チャンネル',exact=True).select_option('C123')
            page.screenshot(path=str(out/f'project-{width}.png'),full_page=True)
            assert form.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            form.get_by_role('button',name='作成',exact=True).click()
            expect(form).not_to_be_visible()
            assert projects[0]['defaultAgentId']=='team:t1'
            assert projects[0]['channel']=={'platform':'slack','channelId':'C123'}
            page.reload()
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            page.locator('.sidebar').get_by_role('button',name='＋ 新しい会話',exact=True).click()
            assert not posts and not sessions, 'New must not create a remote thread before input'
            page.get_by_placeholder('Slackへ送るメッセージを入力').fill('続けてください')
            page.get_by_role('button',name='送信',exact=True).click()
            expect(page.get_by_label('送信したメッセージ')).to_contain_text('続けてください')
            for _ in range(100):
                if pending: break
                page.wait_for_timeout(20)
            assert pending, 'Input must appear while the response is still pending'
            sessions[0]['messages']=[{'id':'server-user-1','role':'user','content':'続けてください','createdAt':datetime.now(timezone.utc).isoformat()}]
            pending.pop().fulfill(json={'ok':True,'response':None})
            expect(page.get_by_placeholder('Slackへ送るメッセージを入力')).to_have_value('')
            expect(page).to_have_url('http://project-test.test/chat/linked-session')
            assert posts[0]=={'projectId':'p1','message':'続けてください'}
            assert posts[-1]=={'message':'続けてください'}
            expect(page.get_by_role('button',name='このSlackで続ける')).to_have_count(0)
            expect(page.get_by_role('button',name='Web会話として分岐')).to_have_count(0)
            expect(page.get_by_label('送信したメッセージ')).to_have_count(0)
            expect(page.locator('.message.user').filter(has_text='続けてください')).to_have_count(1)
            page.get_by_placeholder('Slackへ送るメッセージを入力').fill('再送する本文')
            page.get_by_role('button',name='送信',exact=True).click()
            expect(page.get_by_label('送信したメッセージ')).to_contain_text('再送する本文')
            assert pending
            pending.pop().fulfill(status=503,json={'error':'接続できません'})
            expect(page.get_by_placeholder('Slackへ送るメッセージを入力')).to_have_value('再送する本文')
            expect(page.get_by_label('送信したメッセージ')).to_have_count(0)
            page.screenshot(path=str(out/f'continuation-{width}.png'),full_page=True)
            sessions.append({'id':'child-session','title':'子エージェントの調査','projectId':'p1','platform':'web','updatedAt':'2026-10-23T00:01:00Z','isActive':False,'lifecycle':'open'})
            page.reload()
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            if width > 768: page.locator('.session-row').filter(has_text='子エージェントの調査').hover()
            page.get_by_role('button',name='子エージェントの調査を別ペインで開く',exact=True).click()
            expect(page.locator('.pane')).to_have_count(2)
            if width <= 768: expect(page.locator('.sidebar')).not_to_be_in_viewport()
            page.screenshot(path=str(out/f'child-panes-{width}.png'),full_page=True)
            if width <= 768: page.get_by_role('button',name='サイドバーを開く').click()
            toggle=page.get_by_label('新しい会話の種類と担当')
            toggle.focus(); page.keyboard.press('Enter')
            expect(page.get_by_role('button',name='シークレット会話',exact=False)).to_be_visible()
            page.keyboard.press('Escape')
            expect(page.locator('.new-chat-menu')).not_to_have_attribute('open','')
            toggle.click()
            page.screenshot(path=str(out/f'secret-menu-{width}.png'),full_page=True)
            page.get_by_role('button',name='シークレット会話',exact=False).click()
            expect(page.get_by_text('シークレット · Webのみ',exact=True)).to_be_visible()
            assert posts[-1]['secret'] is True and posts[-1]['projectId']=='p1'
            if width <= 768: expect(page.locator('.sidebar')).not_to_be_in_viewport()
            page.screenshot(path=str(out/f'secret-chat-{width}.png'),full_page=True)
            page.get_by_role('button',name='終了して破棄',exact=True).click()
            expect(page.get_by_text('シークレット会話を破棄しました',exact=True)).to_be_visible()
            assert posts[-1]=={'closed':'secret_test'}
            assert not errors,errors
            print(f'PASS {width}: Project保存・再読込・新規スレッド・Slack継続',flush=True)
            context.close()
    finally: browser.close()
