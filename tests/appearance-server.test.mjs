import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));

test('真实服务中的外观、上传、只读权限与计票连续性', {timeout:30000}, async t => {
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const directory=await mkdtemp(join(tmpdir(),'azusa-appearance-http-'));
  const child=spawn(process.execPath,['server.mjs','--lan'],{cwd:new URL('../',import.meta.url),env:{...process.env,AZUSA_PORT:String(port),AZUSA_APPEARANCE_DIR:directory,AZUSA_SONG_BLACKLIST_FILE:join(directory,'songs.json')},stdio:'ignore',windowsHide:true});
  t.after(async()=>{child.kill();await wait(600);await rm(directory,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+port;
  const call=async(path,value)=>{
    const response=await fetch(origin+path,value?{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify(value)}:{});
    return {status:response.status,value:await response.json()};
  };
  let health;
  for(let i=0;i<100;i++){try{health=(await call('/api/health')).value;break;}catch{await wait(40);}}
  assert.ok(health);
  const before=(await call('/api/state')).value;
  await call('/api/control',{action:'replay-load',dataset:'azusa-p3',position:1480,speed:1});
  await call('/api/control',{action:'replay-play',mode:'hex',counting:'messages',seconds:60});
  const collecting=(await call('/api/state')).value;
  const style=await call('/api/appearance',{target:'console',patch:{theme:'paper'}});
  assert.equal(style.status,200);assert.equal(style.value.settings.panel.theme,'mist');
  const after=(await call('/api/state')).value;
  assert.equal(after.roundId,collecting.roundId);assert.equal(after.status,'collecting');assert.equal(after.source.generation,collecting.source.generation);
  assert.equal(after.ai.requests,0);
  const jpg=await readFile(new URL('../public/assets/azusa-wallpaper.jpg',import.meta.url));
  const upload=await fetch(origin+'/api/backgrounds/import?name=fixture&artist=test',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Panel-Control':'1'},body:jpg});
  assert.equal(upload.status,200);const {imported}=await upload.json();
  assert.equal((await fetch(origin+'/backgrounds/'+imported)).status,200);
  assert.equal((await fetch(origin+'/api/appearance',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await call('/api/appearance',{target:'console',patch:{theme:'invalid'}})).status,400);
  assert.equal((await call('/api/state')).value.error,before.error);
  assert.equal((await fetch(origin+'/api/backgrounds/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Panel-Control':'1'},body:'fake image'})).status,400);
  for(const viewer of health.viewerUrls){
    const remote=new URL(viewer),token=remote.searchParams.get('token');
    assert.equal((await fetch(remote.origin+'/backgrounds/'+imported)).status,403);
    assert.equal((await fetch(remote.origin+'/backgrounds/'+imported+'?token='+token)).status,200);
    assert.equal((await fetch(remote.origin+'/api/appearance?token='+token)).status,403);
    assert.equal((await fetch(remote.origin+'/api/appearance?token='+token,{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:'{}'})).status,403);
    break;
  }
  await call('/api/backgrounds/delete',{id:imported});assert.equal((await fetch(origin+'/backgrounds/'+imported)).status,404);
  await wait(1200);const continuous=(await call('/api/state')).value;
  assert.equal(continuous.roundId,collecting.roundId);assert.ok(continuous.receivedMessages>=collecting.receivedMessages);
  for(const mode of ['equipment','songs']) {
    await call('/api/control',{action:'round',mode,counting:'messages',seconds:60});
    const modeState=(await call('/api/state')).value;
    for(const theme of ['mist','fluent','paper','sakura','mint','graphite']) {
      assert.equal((await call('/api/appearance',{target:'console',patch:{theme},sync:true})).status,200);
      const next=(await call('/api/state')).value;
      assert.equal(next.roundId,modeState.roundId);assert.equal(next.mode,mode);
      assert.equal(next.status,'collecting');assert.equal(next.ai.requests,0);
      assert.ok(next.receivedMessages>=modeState.receivedMessages);
      assert.equal(next.appearance.settings.desktop.theme,theme);
    }
  }
});
