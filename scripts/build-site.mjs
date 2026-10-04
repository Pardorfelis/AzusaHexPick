import {readFile,writeFile,mkdir,copyFile,rm,stat,readdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'site');
const formal = process.argv.includes('--release');
const withDownloads = process.argv.includes('--with-downloads') || formal;
const previewIndex=process.argv.indexOf('--preview-releases');
if(formal&&previewIndex>=0)throw new Error('正式官网不能使用预览发布目录。');
const releaseRelative=previewIndex>=0?process.argv[previewIndex+1]:'dist/releases';
if(!releaseRelative)throw new Error('请提供预览发布目录。');
const version = JSON.parse(await readSource('package.json','utf8')).version;
const base = JSON.parse(await readSource('site/config.json','utf8'));
let local = {};
try { local = JSON.parse(await readSource('site/config.local.json','utf8')); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
const config = {...base,...local};
const delivery = JSON.parse(await readSource('delivery.json','utf8'));
function safePath(relative) {
  const resolved = path.resolve(root,relative);
  if(!resolved.startsWith(root + path.sep)) throw new Error('素材路径不能越出项目目录。');
  return resolved;
}
async function checkedSource(relative) {
  const source = safePath(relative);
  const realRoot=await realpath(root),realSource=await realpath(source);
  if(!realSource.startsWith(realRoot+path.sep)) throw new Error('官网素材的真实路径越出项目目录。');
  let current=root;
  for(const part of path.relative(root,source).split(path.sep)) {
    current=path.join(current,part);
    if((await lstat(current)).isSymbolicLink()) throw new Error('官网不接受符号链接或目录链接素材。');
  }
  return source;
}
async function readSource(relative,encoding) {
  return readFile(await checkedSource(relative),encoding);
}
async function copy(relative,target) {
  const source=await checkedSource(relative);
  const destination = path.join(output,target);
  await mkdir(path.dirname(destination),{recursive:true});
  await copyFile(source,destination);
}
const isHttps = value => {
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&!/(localhost|example|\.invalid$)/i.test(url.hostname);}
  catch{return false;}
};
if(formal && !isHttps(config.baseUrl)) throw new Error('正式官网需先配置实际 HTTPS 域名。');
if(formal && (new URL(config.baseUrl).origin !== new URL(delivery.introductionUrl).origin ||
  new URL(delivery.updateBaseUrl).href !== new URL('updates/',config.baseUrl).href)) throw new Error('官网与客户端更新源必须使用同一个实际域名。');
if(output !== path.join(root,'dist','site')) throw new Error('构建输出目录不正确。');
await mkdir(output,{recursive:true});
// 仅清理固定构建目录，不触及源码和用户数据。
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for(const file of ['index.html','site.css','site.js']) await copy('site/'+file,file);
for(const [source,target] of [
  ['public/assets/azusa-brand.png','assets/brand.png'],['public/assets/azusa-computer.png','assets/computer.png'],
  ['launcher/Assets/avatar.jpg','assets/avatar.jpg'],['launcher/Assets/hero.png','assets/hero.png'],
  ['launcher/Assets/help.jpg','assets/help.jpg'],['public/assets/fonts/Manrope.ttf','assets/Manrope.ttf'],
  ['public/assets/fonts/OFL.txt','assets/OFL.txt'],['public/guide-assets/launcher.png','assets/launcher.png'],
  ['public/assets/README.md','credits/web-assets.md'],['launcher/Assets/README.md','credits/launcher-assets.md']
]) await copy(source,target);
const backgrounds = Array.isArray(config.backgrounds) ? config.backgrounds : [];
const selected = backgrounds.find(item=>item.id===config.background);
if(!selected) throw new Error('选中的背景不在本地图库中。');
let background = null;
if(selected.file) {
  const source = safePath(path.relative(root,path.resolve(root,'site',selected.file)));
  const extension=path.extname(source).toLowerCase();
  if(!['.jpg','.png','.webp'].includes(extension)||(await stat(source)).size>10*1024*1024) throw new Error('背景需要是 10 MB 以内的静态图片。');
  const bytes=await readSource(path.relative(root,source));
  const name=createHash('sha256').update(bytes).digest('hex').slice(0,16)+extension;
  await copy(path.relative(root,source),'backgrounds/'+name);
  background={url:'backgrounds/'+name,position:/^[\w% .-]+$/.test(selected.position??'')?selected.position:'center'};
}
let guide=await readSource('public/guide.html','utf8');
guide=guide.replace(/<a class="website-home" data-website-home hidden>返回官网<\/a>/,'<a class="website-home" data-website-home href="./">返回官网</a>');
await writeFile(path.join(output,'guide.html'),guide,'utf8');
await copy('public/guide.css','guide.css');
for(const file of await readdir(path.join(root,'public','guide-assets'))) if(/\.(png|jpg|webp)$/i.test(file)) await copy('public/guide-assets/'+file,'guide-assets/'+file);
for(const key of ['hex','songs','equipment']) await copy('public/guide-assets/'+key+'.png','media/'+key+'.png');
await copy('dist/delivery/cover.png','media/cover.png');
const movie='dist/delivery/AzusaHexPick-v'+version+'-demo.mp4';
let videoReady=false;
try {
  await copy(movie,'media/demo.mp4');
  const captions=(await readSource('dist/delivery/demo.srt','utf8')).replace(/^\uFEFF/,'').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g,'$1.$2');
  await writeFile(path.join(output,'media','demo.vtt'),'WEBVTT\n\n'+captions,'utf8');
  videoReady=true;
}catch(error){if(error.code!=='ENOENT')throw error;}
const downloads={};
if(withDownloads) {
  const releases=JSON.parse(await readSource(path.join(releaseRelative,'releases.win.json'),'utf8'));
  if(!releases.Assets?.some(asset=>asset.Version===version&&asset.Type==='Full')) throw new Error('当前版本的完整更新包还未生成。');
  const portable=await checkedSource(path.join(releaseRelative,'AzusaHexPickApp-win-Portable.zip'));
  const python=process.env.AZUSA_BUILD_PYTHON||path.join(root,'.runtime','tools','py-build','Scripts','python.exe');
  const check=spawnSync(python,[path.join(root,'scripts','verify-site-portable.py'),portable,version,...(formal?[config.baseUrl]:[])],{encoding:'utf8',windowsHide:true});
  if(check.status!==0)throw new Error('便携包版本核查失败：'+(check.stderr||check.stdout));
  for(const [type,source,suffix] of [['installer','AzusaHexPick-'+version+'-Setup.exe','Setup.exe'],['portable','AzusaHexPickApp-win-Portable.zip','Portable.zip']]) {
    const target='downloads/AzusaHexPick-'+version+'-'+suffix;
    await copy(path.join(releaseRelative,source),target);
    const bytes=await readFile(path.join(output,target));
    downloads[type]={url:target,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  if(formal) {
    const evidence=JSON.parse(await readSource(path.join(releaseRelative,'AzusaHexPick-'+version+'-Setup.exe.manifest.json'),'utf8'));
    const full=releases.Assets.find(asset=>asset.Version===version&&asset.Type==='Full');
    if(evidence.preview!==false||evidence.version!==version||evidence.installerSha256?.toLowerCase()!==downloads.installer.sha256||
       evidence.fullPackageFileName!==full.FileName||evidence.fullPackageSha256?.toLowerCase()!==full.SHA256.toLowerCase()||
       evidence.delivery?.introductionUrl!==delivery.introductionUrl||evidence.delivery?.updateBaseUrl!==delivery.updateBaseUrl) throw new Error('安装向导的载荷与正式官网配置不一致。');
  }
  // 本站更新源只携带真实稳定渠道的包。包先核查，清单供部署脚本最后发布。
  const assets=releases.Assets.filter(asset=>/^0\.\d+\.\d+$/.test(asset.Version)&&Number(asset.Version.split('.')[2])<100&&asset.PackageId==='AzusaHexPickApp');
  for(const asset of assets) {
    if(!new RegExp('^AzusaHexPickApp-'+asset.Version.replaceAll('.','\\.')+'-(full|delta)\\.nupkg$').test(asset.FileName)) throw new Error('更新清单中的文件名不符合稳定渠道规则。');
    const bytes=await readSource(path.join(releaseRelative,asset.FileName));
    if(bytes.length!==asset.Size || createHash('sha256').update(bytes).digest('hex').toLowerCase()!==String(asset.SHA256).toLowerCase()) throw new Error('更新包大小或哈希与清单不一致。');
    await copy(path.join(releaseRelative,asset.FileName),'updates/'+asset.FileName);
  }
  await writeFile(path.join(output,'updates','releases.win.json'),JSON.stringify({Assets:assets})+'\n','utf8');
}
if(formal&&(!videoReady||!downloads.installer||!downloads.portable)) throw new Error('正式官网需要已验证的视频、安装版和便携版。');
const release={version,preview:!formal,ready:Boolean(downloads.installer&&downloads.portable),videoReady,downloads,background,parallax:config.parallax!==false};
await writeFile(path.join(output,'release.json'),JSON.stringify(release,null,2)+'\n','utf8');
const credits=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>素材与说明 · 梓有妙选</title><link rel="stylesheet" href="guide.css"></head><body><main><header><h1>素材与说明</h1><p><a href="./">返回官网</a></p></header><section><h2>关于这个工具</h2><p>梓有妙选｜Azusa HexPick 由粉丝溣符雨发起与维护，帮助整理海克斯、点歌和出装弹幕，不代表主播或官方出品。示例来自直播回放，结果供参考。</p></section><section><h2>图片和字体</h2><p>图片由维护者提供，版权属于原作者及相应权利人。作者与完整版权声明由维护者补充；未确认的授权不作推定。</p><p><a href="credits/web-assets.md">网页素材说明</a> · <a href="credits/launcher-assets.md">启动器素材说明</a> · <a href="assets/OFL.txt">Manrope 字体许可</a></p></section><section><h2>演示配乐</h2><p>《Canon in D Major》— Kevin MacLeod，来源：<a href="https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100301">incompetech.com</a>，<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>。演示中节选、调低音量并加入淡入淡出。</p></section><section><h2>隐私与反馈</h2><p>官网不读取你的本机配置，不包含 API Key 或直播控制接口。反馈通过腾讯问卷提供，诊断信息可选择附带。<a href="https://wj.qq.com/s2/28082013/eqvo/">打开问题反馈</a>。</p></section><footer class="credit">溣符雨 · 维护</footer></main></body></html>`;
await writeFile(path.join(output,'credits.html'),credits,'utf8');
async function walk(directory){let files=[];for(const item of await readdir(directory,{withFileTypes:true})){const full=path.join(directory,item.name);if(item.isDirectory())files.push(...await walk(full));else files.push(full);}return files;}
const entries=[];
for(const file of await walk(output)) {const data=await readFile(file);entries.push({path:path.relative(output,file).split(path.sep).join('/'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
await writeFile(path.join(output,'site-manifest.json'),JSON.stringify({version,formal,baseUrl:config.baseUrl,files:entries},null,2)+'\n','utf8');
console.log(JSON.stringify({version,formal,files:entries.length,ready:release.ready,videoReady,output}));
