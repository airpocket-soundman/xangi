import http from 'node:http';
import { chromium } from 'playwright';
import { validateAction, validateUrl, scrub } from './policy.mjs';
import { executeBatch } from './batch.mjs';

const secret = process.env.BROWSER_CONTROL_TOKEN;
if (!secret || secret.length < 32) throw Error('Set BROWSER_CONTROL_TOKEN (32+ characters)');
const hosts = (process.env.BROWSER_ALLOWED_HOSTS ?? 'localhost,127.0.0.1').split(',').map(x=>x.trim());
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({acceptDownloads:false, serviceWorkers:'block'});
const page = await context.newPage();
await context.route('**/*', route => {
  try { validateUrl(route.request().url(), hosts); return route.continue(); }
  catch { return route.abort('blockedbyclient'); }
});

async function run(a) {
  if (a?.type === 'batch') return executeBatch(a.steps, run);
  const denied = validateAction(a);
  if (denied) return {ok:false,error:denied};
  switch(a.type) {
    case 'navigate': await page.goto(validateUrl(a.url,hosts), {waitUntil:'domcontentloaded'}); return {ok:true,url:page.url()};
    case 'snapshot': return {ok:true,url:page.url(),tree:scrub(await page.locator('body').ariaSnapshot())};
    case 'click': await page.getByRole(a.role??'button',{name:a.name,exact:true}).click({timeout:5000}); return {ok:true,url:page.url()};
    case 'fill': await page.getByRole('textbox',{name:a.name,exact:true}).fill(String(a.value??''),{timeout:5000}); return {ok:true};
    case 'screenshot': return {ok:true,mime:'image/png',base64:(await page.screenshot()).toString('base64')};
  }
}

const server=http.createServer(async(req,res)=>{
  const reply=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.headers.authorization!==`Bearer ${secret}`) return reply(401,{error:'unauthorized'});
  if(req.method!=='POST'||req.url!=='/action') return reply(404,{error:'not_found'});
  let body='';
  for await(const chunk of req){body+=chunk;if(body.length>65536)return reply(413,{error:'too_large'});}
  try{return reply(200,await run(JSON.parse(body)));}
  catch(e){return reply(400,{ok:false,error:String(e.message).slice(0,160)});}
});
server.listen(Number(process.env.BROWSER_PORT??18991),'127.0.0.1');
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>browser.close().finally(()=>process.exit(0))));
