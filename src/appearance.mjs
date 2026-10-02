import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export class AppearanceError extends Error {}
const fail = message => { throw new AppearanceError(message); };
const targets = ['console', 'panel', 'desktop'];
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function dimensions(width, height) {
  if (!width || !height || width > 8192 || height > 8192 || width * height > 20000000)
    fail('图片尺寸过大或无效，请使用不超过 2000 万像素的静态图片。');
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// 只接受静态栅格格式，校验结构、尺寸、尾标记，拒绝动画及截断文件。
export function imageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES)
    fail('背景图片应为 10 MB 以内的 JPG、PNG 或 WebP 文件。');
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, header = false, ended = false;
    const data = [];
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset), end = offset + length + 12;
      if (end > buffer.length) fail('PNG 图片不完整，请重新选择。');
      const kind = buffer.toString('ascii', offset + 4, offset + 8);
      if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) fail('PNG 图片校验失败。');
      if (!header && kind !== 'IHDR') fail('PNG 图片头无效。');
      if (kind === 'IHDR') {
        if (header || length !== 13) fail('PNG 图片头无效。');
        dimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12));
        header = true;
      }
      if (kind === 'acTL') fail('背景仅支持静态图片，请选择 JPG、PNG 或 WebP 静态图。');
      if (kind === 'IDAT') data.push(buffer.subarray(offset + 8, end - 4));
      offset = end;
      if (kind === 'IEND') { ended = length === 0 && offset === buffer.length; break; }
    }
    if (!header || !ended || !data.length) fail('PNG 图片不完整，请重新选择。');
    try { inflateSync(Buffer.concat(data), { maxOutputLength: 170000000 }); }
    catch { fail('PNG 图片数据损坏，请重新选择。'); }
    return { extension: 'png', type: 'image/png' };
  }
  if (buffer[0] === 255 && buffer[1] === 216 && buffer.at(-2) === 255 && buffer.at(-1) === 217) {
    let offset = 2, frame = false, scan = false;
    while (offset < buffer.length - 2) {
      if (buffer[offset++] !== 255) fail('JPG 图片结构无效。');
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) fail('JPG 图片不完整，请重新选择。');
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        if (length < 8) fail('JPG 图片头无效。');
        dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)); frame = true;
      }
      if (marker === 0xda) { scan = offset + length < buffer.length - 2; break; }
      offset += length;
    }
    if (!frame || !scan) fail('JPG 图片缺少图像数据。');
    return { extension: 'jpg', type: 'image/jpeg' };
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.length < 26 || buffer.readUInt32LE(4) + 8 !== buffer.length) fail('WebP 图片不完整，请重新选择。');
    let offset = 12, frame = false;
    while (offset + 8 <= buffer.length) {
      const kind = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
      if (start + length > buffer.length) fail('WebP 图片数据损坏。');
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && (buffer[start] & 2)))
        fail('背景仅支持静态图片，请选择 JPG、PNG 或 WebP 静态图。');
      if (kind === 'VP8 ' && length >= 10 && buffer.subarray(start + 3, start + 6).equals(Buffer.from([157,1,42]))) {
        dimensions(buffer.readUInt16LE(start + 6) & 0x3fff, buffer.readUInt16LE(start + 8) & 0x3fff); frame = true;
      }
      if (kind === 'VP8L' && length >= 5 && buffer[start] === 47) {
        const bits = buffer.readUInt32LE(start + 1);
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); frame = true;
      }
      offset = start + length + (length % 2);
    }
    if (!frame || offset !== buffer.length) fail('WebP 图片缺少有效图像数据。');
    return { extension: 'webp', type: 'image/webp' };
  }
  fail('无法读取背景，请选择完整的 JPG、PNG 或 WebP 静态图片。');
}

export class AppearanceStore {
  constructor({ directory, themes, save }) {
    this.directory = directory;
    this.path = join(directory, 'appearance.json');
    this.images = join(directory, 'backgrounds');
    this.themes = new Set(['system', ...themes.map(theme => theme.id)]);
    this.revision = 0;
    this.warning = '';
    this.queue = Promise.resolve();
    this.save = save || (async value => {
      await mkdir(directory, { recursive: true });
      const temporary = this.path + '.tmp';
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
      await rename(temporary, this.path);
    });
    this.value = { version: 1, settings: {
      console: { theme: 'mist', background: 'default', strength: 'quiet', parallax: true, motion: true },
      panel: { theme: 'mist', background: 'none', strength: 'quiet', parallax: false, motion: true },
      desktop: { theme: 'mist' },
    }, backgrounds: [] };
    this.defaults = structuredClone(this.value);
  }
  async load() {
    try {
      const raw = await readFile(this.path);
      if (raw.length > 262144) throw new Error();
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.backgrounds) || value.backgrounds.length > 80) throw new Error();
      this.value.backgrounds = value.backgrounds.filter(item => validId(item?.id) && ['jpg','png','webp'].includes(item.extension))
        .map(item => ({ id: item.id, extension: item.extension, name: clean(item.name, 60), artist: clean(item.artist, 80), source: clean(item.source, 300) }));
      for (const target of targets) this.value.settings[target] = this.normalized(target, value.settings?.[target] || {});
    } catch (error) {
      if (error.code !== 'ENOENT') { this.warning = '外观配置无法读取，已采用默认样式；重新选择后可保存。';
        this.value = structuredClone(this.defaults); }
    }
    return this;
  }
  library() {
    return [{ id: 'none', name: '无背景', artist: '', source: '', builtin: true, url: '' },
      { id: 'default', name: '梓色凝望', artist: '代宋传（B 站）', source: '', builtin: true, url: '/assets/azusa-wallpaper.jpg' },
      ...this.value.backgrounds.map(item => ({ ...item, builtin: false, url: '/backgrounds/' + item.id }))];
  }
  snapshot() {
    const selected = {};
    for (const target of ['console', 'panel']) selected[target] = this.library().find(item => item.id === this.value.settings[target].background);
    return structuredClone({ revision: this.revision, settings: this.value.settings, selected });
  }
  read() { return { ...this.snapshot(), backgrounds: this.library(), warning: this.warning }; }
  normalized(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('外观设置格式无效。');
    const setting = { ...this.value.settings[target] };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'theme' && this.themes.has(value)) setting.theme = value;
      else if (target !== 'desktop' && key === 'background' && this.library().some(item => item.id === value)) setting.background = value;
      else if (target !== 'desktop' && key === 'strength' && ['quiet','soft','clear'].includes(value)) setting.strength = value;
      else if (target !== 'desktop' && ['parallax','motion'].includes(key) && typeof value === 'boolean') setting[key] = value;
      else fail('外观选项无效，请重新选择。');
    }
    return setting;
  }
  transaction(task) {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }
  async commit(next) {
    try { await this.save(next); }
    catch { fail('外观未能保存，请检查本机数据目录的写入权限后重试。'); }
    this.value = next; this.revision++; this.warning = '';
    return this.read();
  }
  update({ target, patch, sync = false }) {
    return this.transaction(async () => {
      if (!targets.includes(target)) fail('请选择控制台、网页副屏或桌面窗。');
      const setting = this.normalized(target, patch);
      const next = structuredClone(this.value); next.settings[target] = setting;
      if (sync === true) for (const other of targets) next.settings[other].theme = setting.theme;
      return this.commit(next);
    });
  }
  import(buffer, metadata) {
    return this.transaction(async () => {
      const format = imageFormat(buffer), id = createHash('sha256').update(buffer).digest('hex');
      if (this.value.backgrounds.some(item => item.id === id)) return { ...this.read(), imported: id, duplicate: true };
      if (this.value.backgrounds.length >= 80) fail('背景图库已达 80 张，请删除不用的背景后再导入。');
      const item = { id, extension: format.extension, name: clean(metadata.name, 60) || '自定义背景',
        artist: clean(metadata.artist, 80), source: clean(metadata.source, 300) };
      const path = join(this.images, id + '.' + format.extension);
      const next = structuredClone(this.value); next.backgrounds.push(item);
      try {
        await mkdir(this.images, { recursive: true }); await writeFile(path + '.tmp', buffer);
        await rename(path + '.tmp', path);
        return { ...await this.commit(next), imported: id, duplicate: false };
      } catch (error) {
        await unlink(path).catch(() => {}); await unlink(path + '.tmp').catch(() => {});
        if (error instanceof AppearanceError) throw error;
        fail('背景未能保存，请检查本机数据目录的写入权限后重试。');
      }
    });
  }
  edit({ id, name, artist, source }) {
    return this.transaction(async () => {
      if (!validId(id) || !this.value.backgrounds.some(item => item.id === id)) fail('只能修改自定义背景。');
      const next = structuredClone(this.value), item = next.backgrounds.find(item => item.id === id);
      Object.assign(item, { name: clean(name, 60) || '自定义背景', artist: clean(artist, 80), source: clean(source, 300) });
      return this.commit(next);
    });
  }
  delete(id) {
    return this.transaction(async () => {
      const item = this.value.backgrounds.find(item => item.id === id);
      if (!validId(id) || !item) fail('只能删除自定义背景。');
      const next = structuredClone(this.value); next.backgrounds = next.backgrounds.filter(item => item.id !== id);
      for (const target of ['console','panel']) if (next.settings[target].background === id) next.settings[target].background = 'none';
      const result = await this.commit(next);
      await unlink(join(this.images, id + '.' + item.extension)).catch(() => {});
      return result;
    });
  }
  async image(id) {
    if (!validId(id)) return null;
    const item = this.value.backgrounds.find(item => item.id === id);
    if (!item) return null;
    try {
      const content = await readFile(join(this.images, id + '.' + item.extension));
      if (content.length > MAX_IMAGE_BYTES) return null;
      return { content, type: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[item.extension] };
    } catch { return null; }
  }
}
