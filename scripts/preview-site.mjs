import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist/site');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ttf':'font/ttf','.mp4':'video/mp4','.vtt':'text/vtt; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.zip':'application/zip','.exe':'application/octet-stream'};
const server=http.createServer(async(request,response)=>{
  try {
    if(!['GET','HEAD'].includes(request.method))return response.writeHead(405).end();
    const url=new URL(request.url,'http://127.0.0.1');
    const pathname=decodeURIComponent(url.pathname);
    const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(root+path.sep)||pathname.split('/').some(part=>part.startsWith('.')))return response.writeHead(403).end();
    const info=await stat(target);if(!info.isFile())return response.writeHead(404).end();
    const data=await readFile(target);
    const headers={'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
    const range=request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=Number(range[1]),end=Math.min(Number(range[2]||info.size-1),info.size-1);if(start>end||start>=info.size)return response.writeHead(416,{'Content-Range':'bytes */'+info.size}).end();response.writeHead(206,{...headers,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${info.size}`,'Content-Length':end-start+1});return response.end(request.method==='HEAD'?undefined:data.subarray(start,end+1));}
    response.writeHead(200,{...headers,'Accept-Ranges':'bytes','Content-Length':info.size});response.end(request.method==='HEAD'?undefined:data);
  }catch{response.writeHead(404).end('Not found');}
});
server.listen(5281,'127.0.0.1',()=>console.log('官网预览：http://127.0.0.1:5281/'));
