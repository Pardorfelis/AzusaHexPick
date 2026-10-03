import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { feedbackUrl, migrateUserData, readSettings, atomicJson, LauncherBridge, diagnostic } from '../src/application.mjs';

test('反馈只打开官方公开问卷，不接受伪装域名或带凭据链接', () => {
  assert.equal(feedbackUrl('https://wj.qq.com/s2/28082013/eqvo/'), 'https://wj.qq.com/s2/28082013/eqvo/');
  for (const value of ['javascript:alert(1)','http://wj.qq.com/s2/test','https://wj.qq.com.evil.test/s2/test',
    'https://wj.qq.com@evil.test/s2/test','https://user:password@wj.qq.com/s2/test','https://wj.qq.com/login','invalid'])
    assert.equal(feedbackUrl(value), '');
});

test('迁移配置及背景前备份，不迁移密钥，不覆盖已有设置', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'azusa-migration-')); t.after(() => rm(folder,{recursive:true,force:true}));
  const old = join(folder,'old'), target = join(folder,'new');
  await mkdir(join(old,'data/backgrounds'),{recursive:true});
  const image = Buffer.from('fixture-image'), id = createHash('sha256').update(image).digest('hex');
  await writeFile(join(old,'data/backgrounds',id+'.jpg'),image);
  const appearance = {version:1,settings:{desktop:{theme:'sakura'}},backgrounds:[{id,extension:'jpg'}]};
  await writeFile(join(old,'data/appearance.json'),JSON.stringify(appearance));
  await writeFile(join(old,'.env.local'),'DEEPSEEK_API_KEY=synthetic-never-copy');
  assert.equal((await migrateUserData(old,target)).copied,2);
  assert.deepEqual(JSON.parse(await readFile(join(target,'appearance.json'))),appearance);
  assert.deepEqual(await readFile(join(target,'backgrounds',id+'.jpg')),image);
  assert.ok((await readdir(join(target,'backups'))).length);
  assert.equal((await readdir(target)).includes('.env.local'),false);
  await assert.rejects(migrateUserData(old,target),/已有个人设置/);
  assert.equal((await readFile(join(old,'.env.local'),'utf8')).includes('synthetic-never-copy'),true);
});

test('损坏或越界的迁移数据不生成目标配置', async t => {
  const folder = await mkdtemp(join(tmpdir(),'azusa-migration-')); t.after(()=>rm(folder,{recursive:true,force:true}));
  const old = join(folder,'old'), target = join(folder,'new'); await mkdir(join(old,'data'),{recursive:true});
  await writeFile(join(old,'data/appearance.json'),JSON.stringify({version:1,backgrounds:[{id:'../../secret',extension:'jpg'}]}));
  await assert.rejects(migrateUserData(old,target));
  await assert.rejects(readFile(join(target,'appearance.json')));
  await writeFile(join(old,'data/appearance.json'),'{broken');
  await assert.rejects(migrateUserData(old,target));
});

test('个人 AI 开关原子保存，损坏配置不会静默覆盖', async t => {
  const folder = await mkdtemp(join(tmpdir(),'azusa-settings-')); t.after(()=>rm(folder,{recursive:true,force:true}));
  assert.equal(await readSettings(folder),null);
  await atomicJson(join(folder,'app-settings.json'),{enabled:true,hexEnabled:false,model:'deepseek-flash'});
  assert.deepEqual(await readSettings(folder),{enabled:true,hexEnabled:false,model:'deepseek-flash'});
  await writeFile(join(folder,'app-settings.json'),'invalid');
  await assert.rejects(readSettings(folder),/无法读取/);
  assert.equal(await readFile(join(folder,'app-settings.json'),'utf8'),'invalid');
});

test('启动器桥接只使用本机目标，结果只返回显示字段', async () => {
  let called = 0;
  const blocked = new LauncherBridge({url:'https://example.com',secret:'test',fetcher:()=>{called++;}});
  assert.equal(blocked.available,false); assert.deepEqual(await blocked.call(),{available:false}); assert.equal(called,0);
  const bridge = new LauncherBridge({url:'http://127.0.0.1:5179',secret:'test-only',fetcher:async(url,options)=>{
    assert.equal(options.headers['X-Azusa-Launcher'],'test-only'); assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({state:'available',version:'0.7.0',nextVersion:'0.7.1',progress:120,secret:'not-public', feedbackUrl:'https://evil.test'})};
  }});
  const value = await bridge.call('check-update');
  assert.equal(value.progress,100); assert.equal(value.feedbackUrl,''); assert.equal('secret' in value,false);
});

test('诊断只带明确白名单，不带原文、用户标识或私有错误', () => {
  const value = diagnostic('0.7.0',{mode:'songs',status:'locked',sourceKind:'replay',helperConnected:true,
    source:{token:'private'},error:'C:/private/user',raw:['personal-message'],ai:{key:'synthetic-key',configured:true,requests:3}},true);
  const text = JSON.stringify(value);
  for (const secret of ['synthetic-key','personal-message','private/user','token']) assert.equal(text.includes(secret),false);
  assert.equal(value.aiRequests,3); assert.equal(value.desktopConnected,true);
});

test('应用版开关持久化、保存失败回退、更新门禁与只读权限实际集成', {timeout:30000}, async t => {
  const directory = await mkdtemp(join(tmpdir(),'azusa-app-integration-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const management = http.createServer((request,response)=> {
    assert.equal(request.headers['x-azusa-launcher'],'synthetic-bridge-secret');
    response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({state:'current',version:'0.7.0'}));
  });
  management.listen(0,'127.0.0.1'); await once(management,'listening');
  t.after(()=>new Promise(resolve=>management.close(resolve)));
  const reserve = http.createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
  const port = reserve.address().port; await new Promise(resolve=>reserve.close(resolve));
  const child = spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),stdio:'ignore',windowsHide:true,
    env:{...process.env,AZUSA_USER_DATA:directory,AZUSA_APPEARANCE_DIR:directory,AZUSA_PORT:String(port),
      AZUSA_SONG_BLACKLIST_FILE:join(directory,'song-blacklist.json'),DEEPSEEK_API_KEY:'synthetic-no-paid-requests',
      AZUSA_LAUNCHER_URL:'http://127.0.0.1:'+management.address().port,AZUSA_LAUNCHER_SECRET:'synthetic-bridge-secret'}});
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}});
  const url='http://127.0.0.1:'+port;
  const get = async route => (await fetch(url+route)).json();
  const post = (route,value) => fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify(value)});
  for(let i=0;i<100;i++){try{if((await get('/api/health')).version)break;}catch{}await new Promise(resolve=>setTimeout(resolve,40));}
  const first=await get('/api/state');
  assert.equal(first.ai.enabled,true); assert.equal(first.ai.hexEnabled,false); assert.equal(first.ai.requests,0);
  assert.equal((await get('/api/appearance')).settings.desktop.theme,'fluent');
  assert.equal((await post('/api/control',{action:'ai',enabled:false,hexEnabled:false,model:'deepseek-flash'})).status,200);
  assert.equal((JSON.parse(await readFile(join(directory,'app-settings.json')))).enabled,false);
  // 用目录占位制造原子写入失败，不能使内存中的开关偷偷开启。
  await rm(join(directory,'app-settings.json')); await mkdir(join(directory,'app-settings.json'));
  assert.equal((await post('/api/control',{action:'ai',enabled:true})).status,400);
  assert.equal((await get('/api/state')).ai.enabled,false);
  await rm(join(directory,'app-settings.json'),{recursive:true});
  assert.equal((await post('/api/control',{action:'replay-load',dataset:'azusa-p3',position:1480,speed:1})).status,200);
  assert.equal((await post('/api/control',{action:'replay-play',mode:'hex',seconds:60})).status,200);
  assert.equal((await post('/api/control',{action:'prepare-update'})).status,400);
  assert.equal((await post('/api/application',{action:'update'})).status,409);
  assert.equal((await post('/api/control',{action:'replay-pause'})).status,200);
  assert.equal((await post('/api/control',{action:'prepare-update'})).status,200);
  assert.equal((await post('/api/control',{action:'replay-play',mode:'hex',seconds:60})).status,400);
  assert.equal((await post('/api/control',{action:'cancel-update'})).status,200);
  assert.equal((await get('/api/state')).ai.requests,0);
  assert.equal((await fetch(url+'/api/application',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"settings"}'})).status,403);
});
