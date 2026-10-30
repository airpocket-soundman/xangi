import http from 'node:http';

/** Local-only deterministic site for evaluating browser interactions. */
export function createMockSite(port = 8123) {
  let submissions = 0;
  let purchases = 0;
  const server = http.createServer(async(req,res)=>{
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type='text/html') => {res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);};
    if(url.pathname === '/state') return send(200,JSON.stringify({submissions,purchases}),'application/json');
    if(url.pathname === '/purchase' && req.method === 'POST') {purchases++; return send(200,'purchase recorded');}
    if(url.pathname === '/preview' && req.method === 'POST') {submissions++; return send(200,'preview recorded');}
    const q = url.searchParams.get('q') ?? '';
    return send(200,`<!doctype html><html><head><title>Mock Catalog</title></head><body>
      <h1>Mock Catalog</h1><form method="GET"><label>Query <input name="q" value="${q.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}"></label><button>Search</button></form>
      <table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody>
      <tr><td>Widget A</td><td>1200</td></tr><tr><td>Widget B</td><td>3000</td></tr></tbody></table>
      <form method="POST" action="/preview"><button>Preview</button></form>
      <form method="POST" action="/purchase"><button>Place order</button></form>
      </body></html>`);
  });
  return {server, listen:()=>new Promise(resolve=>server.listen(port,'127.0.0.1',resolve)), close:()=>new Promise(resolve=>server.close(resolve))};
}

if(process.argv[1]?.endsWith('mock-site.mjs')) {
  const mock=createMockSite(Number(process.env.MOCK_PORT??8123));
  await mock.listen();
  console.log('Mock site listening on localhost');
}
