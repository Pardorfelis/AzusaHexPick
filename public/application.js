'use strict';
(() => {
  if (location.pathname === '/panel' || new URLSearchParams(location.search).has('token')) return;
  const $ = id => document.getElementById(id);
  // 管理入口的可用性由启动器状态决定，不能被计票页的全局按钮刷新覆盖。
  for (const id of ['application-desktop','application-settings','onboard-settings','application-check','application-update','feedback-open'])
    $(id).dataset.applicationControl = 'true';
  let application = null, collecting = false, pending = false;
  const show = message => { $('application-message').textContent = message; $('application-message').hidden = !message; };
  const request = async (path, value) => {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(6000),
      ...(value ? { method: 'POST', headers: {'Content-Type':'application/json', 'X-Panel-Control':'1'}, body: JSON.stringify(value) } : {}) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '操作未完成，请稍后重试。');
    return body;
  };
  async function refresh() {
    if (document.hidden) return;
    try {
      application = await request('/api/application');
      const launcher = application.launcher;
      $('application-version').textContent = 'v' + application.version;
      $('application-update-state').textContent = launcher.available ? launcher.message : '请使用梓有妙选.exe 启动，开启一键更新与设置。';
      $('application-update-notes').textContent = launcher.notes || '';
      $('application-update').hidden = !launcher.nextVersion;
      $('application-update').disabled = collecting || pending || ['preparing','downloading','applying','checking'].includes(launcher.state);
      $('application-check').disabled = !launcher.available || pending;
      for (const id of ['application-settings','onboard-settings','application-desktop']) {
        $(id).disabled = !launcher.available || pending;
        $(id).title = launcher.available ? '' : '请先通过梓有妙选.exe 启动。';
      }
      $('application-progress').hidden = launcher.state !== 'downloading';
      $('application-progress').value = launcher.progress || 0;
      $('feedback-open').disabled = !application.feedbackUrl;
      $('feedback-state').textContent = application.feedbackUrl
        ? '遇到问题可以在这里告诉溣符雨，提交后他会收到提醒。诊断信息可以按需附上。'
        : '反馈问卷还未设置。请在启动器设置中填入问卷链接。';
    } catch { $('application-update-state').textContent = '暂时连不上服务，请从托盘打开启动器，检查是否已开始使用。'; }
  }
  async function action(name) {
    if (pending) return;
    pending = true;
    try {
      await request('/api/application', {action: name});
      show({ 'check-update':'正在检查更新，结果会显示在「更新与帮助」。', update:'更新进度会显示在启动器中。', settings:'启动器设置已打开。', desktop:'桌面副屏已打开。' }[name] || '操作已完成。');
    }
    catch (error) { show(error.message); }
    finally { pending = false; await refresh(); }
  }
  for (const [id, name] of [['application-check','check-update'],['application-update','update'],
    ['application-settings','settings'],['onboard-settings','settings'],['application-desktop','desktop']])
    $(id).addEventListener('click', () => action(name));
  $('application-exit').addEventListener('click', async () => {
    if (!window.confirm('确认退出全部吗？\n\n桌面副屏和服务会关闭，本场灰名单会清空。个人设置和长期黑名单保留。')) return;
    try { await request('/api/control', {action:'exit-all'}); show('已退出。下次双击梓有妙选.exe 即可打开。'); }
    catch (error) { show(error.message); }
  });
  $('onboard-dismiss').addEventListener('click', () => {
    $('onboarding').hidden = true;
    try { localStorage.setItem('azusa-onboarding-v07','done'); } catch { }
  });
  $('onboard-show').addEventListener('click', () => { $('onboarding').hidden = false; $('onboarding').scrollIntoView({block:'nearest'}); });
  try { $('onboarding').hidden = localStorage.getItem('azusa-onboarding-v07') === 'done'; } catch { }
  $('feedback-diagnostics').addEventListener('click', async () => {
    try { $('feedback-diagnostic-text').value = JSON.stringify(await request('/api/application/diagnostics'), null, 2); $('feedback-diagnostic-text').hidden = false; }
    catch { $('feedback-result').textContent = '暂时无法读取诊断信息，直接填写问题也可以。'; }
  });
  $('feedback-open').addEventListener('click', async () => {
    if (!application?.feedbackUrl) return;
    // 仅在主动填写时加载官方问卷，不向第三方自动附加任何诊断或弹幕。
    $('feedback-external').href = application.feedbackUrl;
    if (!$('feedback-frame').hasAttribute('src')) $('feedback-frame').src = application.feedbackUrl;
    $('feedback-dialog').showModal();
  });
  $('feedback-close').addEventListener('click', () => $('feedback-dialog').close());
  window.HexApplication = { snapshot: value => { collecting = value.status === 'collecting';
    if ($('application-update')) $('application-update').disabled = collecting || pending || ['preparing','downloading','applying','checking'].includes(application?.launcher?.state); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  $('application-card').addEventListener('toggle', refresh);
  refresh();
  setInterval(refresh, 5000);
})();
