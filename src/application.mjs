import { readFile, writeFile, mkdir, rename, stat, lstat, copyFile, unlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function feedbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'wj.qq.com' && !url.username && !url.password
      && url.pathname.startsWith('/s2/') && value.length < 600 ? url.href : '';
  } catch { return ''; }
}

export async function atomicJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function readSettings(directory) {
  try {
    const bytes = await readFile(join(directory, 'app-settings.json'));
    if (bytes.length > 8192) throw new Error();
    const data = JSON.parse(bytes);
    return { enabled: data.enabled === true, hexEnabled: data.hexEnabled === true,
      model: ['deepseek-flash', 'deepseek-v4-pro'].includes(data.model) ? data.model : 'deepseek-flash' };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('应用设置无法读取，请从备份恢复后重试。');
  }
}

// 只迁移已知个人文件；先校验和备份，失败撤销本次新增文件，不改源目录。
export async function migrateUserData(source, target) {
  source = resolve(source); target = resolve(target);
  if (source === target) return { copied: 0 };
  const files = [];
  for (const [from, to, limit] of [
    ['data/appearance.json', 'appearance.json', 262144],
    ['data/song-blacklist.json', 'song-blacklist.json', 1048576],
    ['.runtime/desktop-display-5178.json', 'runtime/desktop-display-5178.json', 4096],
  ]) {
    const path = join(source, from);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !info.isFile() || info.size > limit) throw new Error('旧版配置文件无效。');
    const bytes = await readFile(path);
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (to === 'appearance.json' && (value.version !== 1 || !Array.isArray(value.backgrounds) || value.backgrounds.length > 80)) throw new Error('旧版外观配置无效。');
    if (to === 'song-blacklist.json' && (value.version !== 1 || !Array.isArray(value.entries))) throw new Error('旧版歌曲名单无效。');
    files.push({ path, to });
    if (to === 'appearance.json') {
      for (const image of value.backgrounds) {
        if (!/^[a-f0-9]{64}$/.test(image.id) || !['jpg','png','webp'].includes(image.extension)) throw new Error('旧版背景索引无效。');
        const imagePath = join(source, 'data/backgrounds', image.id + '.' + image.extension);
        const imageInfo = await lstat(imagePath);
        if (!imageInfo.isFile() || imageInfo.isSymbolicLink() || imageInfo.size > 10485760) throw new Error('旧版背景文件无效。');
        if (createHash('sha256').update(await readFile(imagePath)).digest('hex') !== image.id) throw new Error('旧版背景校验失败。');
        files.push({ path: imagePath, to: 'backgrounds/' + image.id + '.' + image.extension });
      }
    }
  }
  if (!files.length) return { copied: 0 };
  for (const file of files) {
    if (await stat(join(target, file.to)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }))
      throw new Error('已有个人设置，未覆盖；请使用新的用户数据目录导入。');
  }
  const backup = join(target, 'backups', 'import-' + Date.now());
  for (const file of files) {
    await mkdir(resolve(backup, file.to, '..'), { recursive: true });
    await copyFile(file.path, join(backup, file.to));
  }
  const created = [];
  try {
    for (const file of files) {
      const destination = join(target, file.to);
      await mkdir(resolve(destination, '..'), { recursive: true });
      await copyFile(join(backup, file.to), destination, 1);
      created.push(destination);
    }
  } catch (error) {
    for (const path of created) await unlink(path).catch(() => {});
    throw error;
  }
  return { copied: created.length };
}

export class LauncherBridge {
  constructor({ url = process.env.AZUSA_LAUNCHER_URL, secret = process.env.AZUSA_LAUNCHER_SECRET, fetcher = fetch } = {}) {
    this.url = /^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(url || '') ? url : '';
    this.secret = secret || '';
    this.fetcher = fetcher;
  }
  get available() { return Boolean(this.url && this.secret); }
  async call(action = null) {
    if (!this.available) return { available: false };
    const result = await this.fetcher(this.url + (action ? '/command' : '/state'), {
      method: action ? 'POST' : 'GET', headers: { 'X-Azusa-Launcher': this.secret, 'Content-Type': 'application/json' },
      ...(action ? { body: JSON.stringify({ action }) } : {}), signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!result.ok) throw new Error('启动器暂时无法响应，请从托盘打开。');
    const value = await result.json();
    return { available: true, state: String(value.state || 'idle').slice(0, 40),
      message: String(value.message || '').slice(0, 300), version: String(value.version || '').slice(0, 40),
      nextVersion: String(value.nextVersion || '').slice(0, 40), notes: String(value.notes || '').slice(0, 3000),
      progress: Math.max(0, Math.min(100, Number(value.progress) || 0)), feedbackUrl: feedbackUrl(value.feedbackUrl) };
  }
}

export function diagnostic(version, snapshot, managed) {
  return { application: 'Azusa HexPick', version, managed,
    mode: snapshot.mode, status: snapshot.status, source: snapshot.sourceKind,
    connection: snapshot.connection, desktopConnected: Boolean(snapshot.helperConnected),
    aiConfigured: Boolean(snapshot.ai?.configured), aiEnabled: Boolean(snapshot.ai?.enabled),
    aiRequests: Number(snapshot.ai?.requests) || 0,
    received: Number(snapshot.receivedMessages) || 0, generatedAt: new Date().toISOString() };
}
