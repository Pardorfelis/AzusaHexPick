import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppearanceStore, imageFormat } from '../src/appearance.mjs';

const themes = JSON.parse(await readFile(new URL('../public/themes.json', import.meta.url)));
const jpg = await readFile(new URL('../public/assets/azusa-wallpaper.jpg', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'azusa-appearance-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  return new AppearanceStore({directory,themes,...extra}).load();
}

test('三处独立保存，同步只同步主题，重启恢复背景和动效', async t => {
  const store = await fixture(t);
  assert.equal(store.snapshot().settings.console.background,'default');
  assert.equal(store.snapshot().settings.panel.background,'none');
  await store.update({target:'panel',patch:{theme:'paper',background:'default'}});
  assert.equal(store.snapshot().settings.console.theme,'mist');
  await store.update({target:'desktop',patch:{theme:'fluent'},sync:true});
  assert.deepEqual(Object.values(store.snapshot().settings).map(item=>item.theme),['fluent','fluent','fluent']);
  assert.equal(store.snapshot().settings.panel.background,'default');
  const reloaded = await new AppearanceStore({directory:store.directory,themes}).load();
  assert.deepEqual(reloaded.snapshot().settings,store.snapshot().settings);
  assert.equal(store.snapshot().revision,2);
});

test('导入真实 JPG 与 PNG、内容去重、修改署名、删除当前背景回退', async t => {
  const store = await fixture(t);
  const value = await store.import(jpg,{name:'自定义梓梓',artist:'测试作者',source:'本地文件'});
  const id = value.imported;
  assert.equal(value.duplicate,false);
  assert.equal((await store.import(jpg,{})).duplicate,true);
  assert.equal(store.value.backgrounds.length,1);
  await store.update({target:'console',patch:{background:id}});
  await store.update({target:'panel',patch:{background:id}});
  await store.edit({id,name:'新名称',artist:'新作者',source:'https://example.test/art'});
  assert.equal(store.snapshot().selected.console.artist,'新作者');
  assert.equal((await store.image(id)).type,'image/jpeg');
  assert.equal(await store.image('../appearance.json'),null);
  assert.equal(imageFormat(png).extension,'png');
  await store.delete(id);
  assert.equal(await store.image(id),null);
  assert.equal(store.snapshot().settings.console.background,'none');
  assert.equal(store.snapshot().settings.panel.background,'none');
  await assert.rejects(store.delete('default'));
});

test('拒绝伪装图片、截断、PNG 校验损坏、动画与超限', () => {
  for(const buffer of [Buffer.from('<svg></svg>'),jpg.subarray(0,-2),png.subarray(0,-4),Buffer.alloc(10*1024*1024+1)])
    assert.throws(()=>imageFormat(buffer));
  const corrupt=Buffer.from(png); corrupt[45]^=1; assert.throws(()=>imageFormat(corrupt));
  const webp=Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22,4);webp.write('WEBP',8);webp.write('VP8X',12);webp.writeUInt32LE(10,16);webp[20]=2;
  assert.throws(()=>imageFormat(webp),/静态/);
});

test('写入失败不替换状态，导入失败删除孤立图片，坏配置采用完整默认', async t => {
  const store=await fixture(t,{save:async()=>{throw new Error('模拟磁盘失败');}}), before=store.snapshot();
  await assert.rejects(store.update({target:'console',patch:{theme:'paper'}}),/未能保存/);
  assert.deepEqual(store.snapshot(),before);
  await assert.rejects(store.import(jpg,{name:'失败'}),/未能保存/);
  assert.equal(store.value.backgrounds.length,0);
  await writeFile(store.path,JSON.stringify({version:1,backgrounds:[],settings:{console:{theme:'paper'},panel:{theme:'invalid'}}}));
  const reloaded=await new AppearanceStore({directory:store.directory,themes}).load();
  assert.equal(reloaded.snapshot().settings.console.theme,'mist');
  assert.match(reloaded.warning,/默认/);
});

test('并发更新按顺序保存，不覆盖其他显示位置，非法字段不落盘', async t => {
  const store=await fixture(t);
  await Promise.all([store.update({target:'console',patch:{theme:'sakura'}}),store.update({target:'panel',patch:{theme:'mint'}}),store.update({target:'desktop',patch:{theme:'system'}})]);
  assert.deepEqual(Object.values(store.snapshot().settings).map(item=>item.theme),['sakura','mint','system']);
  await assert.rejects(store.update({target:'desktop',patch:{background:'default'}}));
  await assert.rejects(store.update({target:'console',patch:{theme:'unknown'}}));
  assert.equal(store.revision,3);
});

function luminance(hex) {
  const values=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return values[0]*.2126+values[1]*.7152+values[2]*.0722;
}
function contrast(a,b){const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return(values[0]+.05)/(values[1]+.05);}
test('所有主题正文、次要文字、状态、署名和主按钮达到阅读对比度',()=>{
  for(const theme of themes){
    for(const foreground of ['text','muted','brand-hover','good','warning','danger','signature'])
      for(const background of ['page','surface','inset','raised','brand-soft'])
        assert.ok(contrast(theme.css[foreground],theme.css[background])>=4.5,`${theme.id} ${foreground}/${background} ${contrast(theme.css[foreground],theme.css[background])}`);
    assert.ok(contrast(theme.css['on-brand'],theme.css.brand)>=4.5,theme.id+' button');
  }
});

test('半透明层在最强背景设置与极端图片明暗下保持文字对比度', () => {
  const rgb = hex => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  const blend = (front,back,alpha) => front.map((value,i) => value*alpha+back[i]*(1-alpha));
  const hex = values => '#' + values.map(value => Math.round(value).toString(16).padStart(2,'0')).join('');
  for (const theme of themes) {
    for (const picture of [[0,0,0],[255,255,255]]) {
      const ground = blend(rgb(theme.css.page),picture,.22);
      for (const [surface,alpha] of [['page',.83],['surface',.86],['surface',.94]]) {
        const background = hex(blend(rgb(theme.css[surface]),ground,alpha));
        for (const foreground of ['text','muted','brand-hover','good','warning','danger','signature'])
          assert.ok(contrast(theme.css[foreground],background)>=4.5,`${theme.id} ${foreground}/${surface} 半透明`);
      }
    }
  }
});
