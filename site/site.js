(() => {
  'use strict';
  const root = document.documentElement;
  const wallpaper = document.querySelector('.wallpaper');
  const motion = document.querySelector('.motion-toggle');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  let enabled = true, hasBackground = false, paused = false, frame = 0, nextX = 0, nextY = 0;
  try { paused = localStorage.getItem('hexpick-site-motion') === 'paused'; } catch {}
  const mayMove = () => enabled && hasBackground && !paused && !reduced.matches && pointer.matches && !document.hidden;
  function stop() {
    cancelAnimationFrame(frame); frame = 0;
    wallpaper.style.removeProperty('--parallax-x'); wallpaper.style.removeProperty('--parallax-y');
  }
  function paint() {
    frame = 0;
    if (!mayMove()) return stop();
    wallpaper.style.setProperty('--parallax-x', nextX + 'px');
    wallpaper.style.setProperty('--parallax-y', nextY + 'px');
  }
  function motionLabel() {
    motion.setAttribute('aria-pressed', String(paused));
    motion.querySelector('span').textContent = paused ? '恢复动效' : '暂停动效';
    if (!mayMove()) stop();
  }
  motion.addEventListener('click', () => {
    paused = !paused;
    try { localStorage.setItem('hexpick-site-motion', paused ? 'paused' : 'on'); } catch {}
    motionLabel();
  });
  document.addEventListener('pointermove', event => {
    if (!mayMove()) return;
    const x = (event.clientX / innerWidth - .5) * 16;
    const y = (event.clientY / innerHeight - .5) * 16;
    const scale = Math.min(1, 8 / Math.max(1, Math.hypot(x, y)));
    nextX = x * scale;
    nextY = y * scale;
    if (!frame) frame = requestAnimationFrame(paint);
  }, {passive:true});
  document.addEventListener('pointerleave', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', stop);
  reduced.addEventListener('change', motionLabel);
  pointer.addEventListener('change', motionLabel);
  motionLabel();
  const size = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  fetch('release.json', {cache:'no-cache'}).then(response => {
    if (!response.ok) throw new Error('没有版本资料');
    return response.json();
  }).then(release => {
    document.querySelectorAll('[data-version]').forEach(element => element.textContent = 'v' + release.version);
    const preview = release.preview === true;
    document.querySelector('[data-preview-warning]').hidden = !preview;
    document.querySelector('[data-compatibility]').textContent = preview
      ? 'Windows 10／11 · 不用另装运行环境 · 在线更新等待正式发布'
      : 'Windows 10／11 · 不用另装运行环境 · 后续点一下更新';
    document.querySelector('[data-update-note]').textContent = preview
      ? '正式更新源发布后，有新版程序就会提醒你。当前预览包先用于本机检查。'
      : '以后有新版，程序会提醒你。选「更新并重新打开」，个人设置和长期黑名单都会保留。';
    enabled = release.parallax !== false;
    if (release.background?.url && /^backgrounds\/[\w.-]+\.(jpg|png|webp)$/i.test(release.background.url)) {
      hasBackground = true;
      root.style.setProperty('--background-url', 'url("' + release.background.url + '")');
      if (/^[\w% .-]+$/.test(release.background.position ?? '')) root.style.setProperty('--background-position', release.background.position);
    }
    motion.hidden = !enabled;
    motionLabel();
    for (const type of ['installer', 'portable']) {
      const asset = release.downloads?.[type];
      if (!asset || !/^downloads\/AzusaHexPick-[\d.]+-(Setup\.exe|Portable\.zip)$/.test(asset.url)) continue;
      const link = document.querySelector('[data-download="' + type + '"]');
      link.href = asset.url;
      link.removeAttribute('aria-disabled');
      link.textContent = type === 'installer' ? '下载安装版' : '下载便携版';
      document.querySelector('[data-file-note="' + type + '"]').textContent = 'Windows x64 · ' + (type === 'installer' ? 'EXE' : 'ZIP') + ' · ' + size(asset.bytes);
      if (/^[a-f0-9]{64}$/i.test(asset.sha256)) {
        const checksum = document.createElement('code'); checksum.className = 'checksum';
        checksum.textContent = (type === 'installer' ? '安装版' : '便携版') + ' SHA-256：' + asset.sha256;
        document.querySelector('[data-checksums]').append(checksum);
      }
    }
    document.querySelector('[data-download-status]').textContent = release.ready
      ? (release.preview ? '这是本地预览包，正式下载与更新源仍在准备。' : '这是 v' + release.version + ' 的 Windows 试用包。')
      : '本地预览中，正式下载包还未发布。';
    if (!release.videoReady) {
      document.querySelector('video').removeAttribute('controls');
      document.querySelector('video source').removeAttribute('src');
      document.querySelector('.video-pending').hidden = false;
      document.querySelector('[data-video-download]').hidden = true;
    }
  }).catch(() => {
    document.querySelector('[data-download-status]').textContent = '暂时没能读取下载信息，请刷新页面重试。';
  });
})();
