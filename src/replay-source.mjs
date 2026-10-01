import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export class ReplaySource {
  constructor({ directory, onMessage, onStatus, now = Date.now }) {
    this.directory = directory;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.now = now;
    this.generation = 0;
    this.timer = null;
    this.dataset = null;
    this.position = 0;
    this.index = 0;
    this.speed = 1;
    this.playing = false;
    this.state = 'idle';
  }

  async list() {
    const names = await readdir(this.directory).catch(() => []);
    const datasets = [];
    for (const name of names.filter(name => /^[a-z0-9-]+\.json$/.test(name))) {
      const value = JSON.parse(await readFile(resolve(this.directory, name), 'utf8'));
      datasets.push({
        id: value.id, label: value.label, duration: value.duration,
        count: value.messages.length, coverage: value.coverage,
        windows: value.windows || [],
      });
    }
    return datasets;
  }

  async load(id, position = 0, speed = 1) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('无效的回放编号。');
    this.stop();
    const generation = this.generation;
    const value = JSON.parse(await readFile(resolve(this.directory, id + '.json'), 'utf8'));
    if (generation !== this.generation) return false;
    if (!Array.isArray(value.messages)) throw new Error('回放格式不正确。');
    this.dataset = value;
    this.speed = speed;
    this.seek(position);
  }

  seek(position) {
    if (!this.dataset) throw new Error('请先选择回放。');
    this.pause();
    this.position = Math.max(0, Math.min(Number(position) || 0, this.dataset.duration));
    this.index = this.dataset.messages.findIndex(message => message.at >= this.position);
    if (this.index < 0) this.index = this.dataset.messages.length;
    this.generation += 1;
    this.emit('paused');
  }

  play() {
    if (!this.dataset || this.playing) return;
    this.playing = true;
    this.anchorTime = this.now();
    this.anchorPosition = this.position;
    this.emit('playing');
    const generation = this.generation;
    this.timer = setInterval(() => this.tick(generation), 40);
    this.timer.unref?.();
  }

  tick(generation = this.generation) {
    if (!this.playing || generation !== this.generation) return;
    this.position = Math.min(this.dataset.duration,
      this.anchorPosition + (this.now() - this.anchorTime) / 1000 * this.speed);
    const source = 'replay:' + this.generation;
    while (this.playing && generation === this.generation && this.index < this.dataset.messages.length
        && this.dataset.messages[this.index].at <= this.position) {
      const message = this.dataset.messages[this.index++];
      this.onMessage({
        ...message, id: this.generation + ':' + message.id,
        at: this.now(), replayAt: message.at, source,
      });
    }
    if (generation === this.generation && this.playing && this.position >= this.dataset.duration) {
      this.pause();
      this.emit('ended');
    }
  }

  pause() {
    if (this.playing) this.tickPosition();
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.emit('paused');
  }

  tickPosition() {
    this.position = Math.min(this.dataset.duration,
      this.anchorPosition + (this.now() - this.anchorTime) / 1000 * this.speed);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.generation += 1;
    this.emit('stopped');
  }

  emit(state) {
    this.state = state;
    this.onStatus({
      state, generation: this.generation,
      dataset: this.dataset?.id || null, position: this.position,
      duration: this.dataset?.duration || 0, speed: this.speed,
    });
  }

  snapshot() {
    return {
      state: this.state, generation: this.generation,
      dataset: this.dataset?.id || null, label: this.dataset?.label || '',
      position: this.position, duration: this.dataset?.duration || 0,
      speed: this.speed, count: this.dataset?.messages.length || 0,
    };
  }
}
