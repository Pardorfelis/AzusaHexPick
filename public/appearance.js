'use strict';

// 外观状态与轮次表单独立，主题变化不发起计票控制请求。
window.HexAppearance = (() => {
  const byId = id => document.getElementById(id);
  const readonly = location.pathname === '/panel' || new URLSearchParams(location.search).has('token');
  const token = new URLSearchParams(location.search).get('token');
  const system = matchMedia('(prefers-color-scheme: light)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const mouse = matchMedia('(hover: hover) and (pointer: fine)');
  let themes = [], state = null, library = [], target = 'console', pending = false, editing = null;
  let lastSignature = '', lastBackground = '', frame = null, pointer = [0, 0], settings = null;
  let motionPaused = false;
  const url = path => { const value = new URL(path, location.origin); if (token) value.searchParams.set('token', token); return value.href; };
  const node = (tag, className, content) => { const value = document.createElement(tag); value.className = className; if (content !== undefined) value.textContent = content; return value; };
  const notice = (message, error = false) => { byId('appearance-status').textContent = message; byId('appearance-status').classList.toggle('is-error', error); };
  function themeFor(id) { return themes.find(theme => theme.id === (id === 'system' ? system.matches ? 'fluent' : 'mist' : id)) || themes[0]; }
  async function request(path, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url(path), { cache: 'no-store', ...options, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '外观未能保存，请重试。');
      return result;
    } catch (error) { throw new Error(error.name === 'AbortError' ? '保存等待超时，请检查当前样式后再试。' : error.message); }
    finally { clearTimeout(timer); }
  }
  function apply() {
    if (!state || !themes.length) return;
    settings = state.settings[readonly ? 'panel' : 'console'];
    const theme = themeFor(settings.theme), root = document.documentElement;
    const signature = JSON.stringify([settings, theme.id, state.selected?.[readonly ? 'panel' : 'console']]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    root.dataset.theme = theme.id; root.dataset.scheme = theme.scheme;
    root.style.colorScheme = theme.scheme;
    for (const [key, value] of Object.entries(theme.css)) root.style.setProperty('--' + key, value);
    root.style.setProperty('--radius', theme.radius + 'px');
    for (const [key, alpha] of [['glass',.86],['result-glass',.94],['header-glass',.83]]) {
      const color = key === 'header-glass' ? theme.css.page : theme.css.surface;
      const rgb = [1,3,5].map(index => parseInt(color.slice(index, index + 2), 16));
      root.style.setProperty('--' + key, `rgba(${rgb.join(',')},${alpha})`);
    }
    const selected = state.selected?.[readonly ? 'panel' : 'console'];
    const image = byId('wallpaper-image'), background = selected?.url ? url(selected.url) : '';
    document.body.classList.toggle('has-wallpaper', Boolean(background));
    document.body.classList.toggle('panel-transparent', readonly && !background);
    root.dataset.backgroundStrength = settings.strength || 'quiet';
    if (background !== lastBackground) {
      lastBackground = background;
      if (background) image.src = background; else image.removeAttribute('src');
    }
    byId('wallpaper-credit').hidden = !background || selected?.builtin;
    byId('wallpaper-credit').textContent = selected?.builtin ? '' : selected?.artist ? '背景插画：' + selected.artist : '背景插画：作者未填写';
    syncMotion();
  }
  function syncMotion() {
    const paused = motionPaused || reduced.matches || settings?.motion === false;
    document.body.classList.toggle('motion-paused', paused);
    const button = byId('motion-toggle');
    button.setAttribute('aria-pressed', String(paused)); button.textContent = paused ? '启用动效' : '暂停动效';
    if (!canMove()) resetMotion();
  }
  function canMove() { return settings?.parallax && mouse.matches && !document.hidden && !reduced.matches && !motionPaused && settings.motion !== false && Boolean(lastBackground); }
  function resetMotion() {
    if (frame !== null) cancelAnimationFrame(frame); frame = null; pointer = [0,0];
    byId('wallpaper-image').style.transform = 'translate3d(0,0,0)';
  }
  function move(event) {
    if (!canMove()) return;
    pointer = [(event.clientX / innerWidth - .5) * 16, (event.clientY / innerHeight - .5) * 16];
    const distance = Math.hypot(...pointer);
    if (distance > 8) pointer = pointer.map(value => value * 8 / distance);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; if (canMove()) byId('wallpaper-image').style.transform = `translate3d(${pointer[0]}px,${pointer[1]}px,0)`; });
  }
  function update(value) {
    if (!value || !value.settings) return;
    const changed = !state || state.revision !== value.revision;
    state = value; apply();
    if (changed && !readonly && !byId('appearance-settings').hidden) reloadLibrary().catch(error => notice(error.message, true));
  }
  async function reloadLibrary() {
    const value = await request('/api/appearance');
    library = value.backgrounds; state = value; apply(); renderPicker();
    if (value.warning) notice(value.warning, true);
  }
  async function perform(task) {
    if (pending || readonly) return;
    pending = true; byId('appearance-settings').setAttribute('aria-busy', 'true'); notice('正在保存…');
    busyControls();
    try {
      const result = await task(); state = result; library = result.backgrounds;
      apply(); renderPicker(); notice(result.duplicate ? '这张图片已在图库中，可以重复使用。' : '已保存，即时生效。');
      return result;
    } catch (error) { notice(error.message || '保存未完成，请重试。', true); }
    finally { pending = false; byId('appearance-settings').setAttribute('aria-busy', 'false'); busyControls(); }
  }
  function busyControls() {
    byId('appearance-content').querySelectorAll('button,input,select').forEach(button=>{button.disabled=pending;});
  }
  const patch = values => perform(() => request('/api/appearance', { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Panel-Control':'1' }, body: JSON.stringify({ target, patch: values }) }));
  function selectTarget(value, focus = false) {
    target = value;
    for (const name of ['console','panel','desktop']) {
      const button = byId('appearance-' + name); button.setAttribute('aria-selected', String(name === target)); button.tabIndex = name === target ? 0 : -1;
      if (focus && name === target) button.focus();
    }
    byId('appearance-content').setAttribute('aria-labelledby', 'appearance-' + value);
    byId('appearance-wallpapers').hidden = value === 'desktop'; byId('appearance-desktop-note').hidden = value !== 'desktop';
    closeForm(); renderPicker(); notice('');
  }
  function renderPicker() {
    if (!state || !themes.length) return;
    const focused = document.activeElement?.dataset;
    const focusTheme = focused?.themeId, focusBackground = focused?.backgroundId;
    const setting = state.settings[target], buttons = [];
    for (const theme of [{ id:'system', name:'跟随系统', description:'浅色云白，深色雾光。', ...themeFor('system') , id: 'system', name: '跟随系统' }, ...themes]) {
      const button = node('button', 'theme-choice'); button.type = 'button'; button.dataset.themeId = theme.id;
      button.setAttribute('aria-pressed', String(theme.id === setting.theme)); button.title = theme.description;
      const preview = node('span', 'theme-preview'); preview.style.backgroundColor = theme.css.page;
      const previewPane = node('span', 'preview-pane'); previewPane.style.backgroundColor = theme.css.surface;
      const previewLine = node('span', 'preview-line'); previewLine.style.backgroundColor = theme.css.brand;
      preview.append(previewPane, previewLine);
      const strip = node('span', 'theme-strip'); for (const key of ['page','surface','brand','good','signature']) { const swatch = node('i', ''); swatch.style.backgroundColor = theme.css[key]; strip.append(swatch); }
      button.append(preview, node('span', 'theme-name', theme.name), strip);
      button.addEventListener('click', () => patch({ theme: theme.id })); buttons.push(button);
    }
    byId('appearance-themes').replaceChildren(...buttons);
    if (focusTheme) buttons.find(button => button.dataset.themeId === focusTheme)?.focus();
    if (target === 'desktop') { busyControls(); return; }
    const gallery = library.map(item => {
      const button = node('button', 'background-choice'); button.type = 'button'; button.dataset.backgroundId = item.id; button.setAttribute('aria-pressed', String(item.id === setting.background));
      if (item.url) { const img = node('img',''); img.src = url(item.url); img.alt = ''; img.loading = 'lazy'; button.append(img); }
      else button.append(node('span','no-background','无'));
      button.append(node('span','background-name',item.name)); button.addEventListener('click', () => { closeForm(); patch({background:item.id}); }); return button;
    });
    byId('background-gallery').replaceChildren(...gallery);
    if (focusBackground) gallery.find(button => button.dataset.backgroundId === focusBackground)?.focus();
    byId('background-strength').value = setting.strength; byId('background-parallax').checked = setting.parallax;
    const chosen = library.find(item => item.id === setting.background);
    byId('background-attribution').textContent = chosen?.builtin ? (chosen.id === 'none' ? '界面自身的底色' : '内置默认背景') : chosen?.artist || '作者未填写';
    byId('background-edit').hidden = !chosen || chosen.builtin; byId('background-delete').hidden = !chosen || chosen.builtin;
    busyControls();
  }
  function closeForm() { editing = null; byId('background-form').hidden = true; byId('background-add').setAttribute('aria-expanded','false'); }
  function showForm(item = null) {
    editing = item?.id || null; byId('background-form').hidden = false;
    byId('background-add').setAttribute('aria-expanded','true'); byId('background-file').hidden = Boolean(editing);
    byId('background-file').previousElementSibling.hidden = Boolean(editing); byId('background-file').value = '';
    for (const field of ['name','artist','source']) byId('background-' + field).value = item?.[field] || '';
    byId('background-save').textContent = editing ? '保存署名' : '导入并使用'; byId('background-name').focus();
  }
  function openPicker(open) {
    byId('appearance-settings').hidden = !open; byId('appearance-open').setAttribute('aria-expanded', String(open));
    if (!open) { byId('appearance-open').focus(); return; }
    reloadLibrary().then(() => byId('appearance-' + target).focus()).catch(error => notice(error.message, true));
  }
  function bind() {
    byId('wallpaper-image').addEventListener('error', () => { document.body.classList.remove('has-wallpaper'); if (!readonly) notice('背景图片无法读取，请重新选择或导入。',true); });
    document.addEventListener('pointermove', move, { passive: true }); document.addEventListener('pointerleave', resetMotion);
    document.addEventListener('visibilitychange', resetMotion); window.addEventListener('pagehide', resetMotion);
    system.addEventListener('change', () => { lastSignature = ''; apply(); if (!readonly && !byId('appearance-settings').hidden) renderPicker(); });
    reduced.addEventListener('change', syncMotion); mouse.addEventListener('change', resetMotion);
    if (readonly) return;
    byId('motion-toggle').addEventListener('click', () => {
      motionPaused = !document.body.classList.contains('motion-paused'); syncMotion();
      perform(() => request('/api/appearance', {method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify({target:'console',patch:{motion:!motionPaused}})}));
    });
    byId('appearance-open').addEventListener('click', () => openPicker(byId('appearance-settings').hidden));
    byId('appearance-close').addEventListener('click', () => openPicker(false));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !byId('appearance-settings').hidden) openPicker(false); });
    document.addEventListener('pointerdown', event => { if (!byId('appearance-settings').hidden && !byId('appearance-settings').contains(event.target) && !byId('appearance-open').contains(event.target)) openPicker(false); });
    for (const name of ['console','panel','desktop']) {
      const button = byId('appearance-' + name); button.addEventListener('click', () => selectTarget(name));
      button.addEventListener('keydown', event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
        event.preventDefault(); const names=['console','panel','desktop']; const index=event.key==='Home'?0:event.key==='End'?2:(names.indexOf(target)+(event.key==='ArrowRight'?1:2))%3; selectTarget(names[index],true);
      } });
    }
    byId('appearance-sync').addEventListener('click', () => perform(() => request('/api/appearance', {method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify({target,patch:{theme:state.settings[target].theme},sync:true})})));
    byId('background-strength').addEventListener('change',event=>patch({strength:event.target.value}));
    byId('background-parallax').addEventListener('change',event=>patch({parallax:event.target.checked}));
    byId('background-add').addEventListener('click',()=>showForm()); byId('background-cancel').addEventListener('click',closeForm);
    byId('background-edit').addEventListener('click',()=>showForm(library.find(item=>item.id===state.settings[target].background)));
    byId('background-delete').addEventListener('click',()=>perform(()=>request('/api/backgrounds/delete',{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify({id:state.settings[target].background})})));
    byId('background-form').addEventListener('submit',async event=>{
      event.preventDefault(); const metadata=Object.fromEntries(['name','artist','source'].map(field=>[field,byId('background-'+field).value]));
      const editId=editing, applyTarget=target;
      const file=byId('background-file').files[0];
      if (!editId && (!file || file.size>10*1024*1024 || !file.size)) { notice('请选择 10 MB 以内的 JPG、PNG 或 WebP 静态图片。',true); return; }
      const result=await perform(async()=>{
        if(editId) return request('/api/backgrounds/edit',{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify({id:editId,...metadata})});
        const imported=await request('/api/backgrounds/import?'+new URLSearchParams(metadata),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Panel-Control':'1'},body:file});
        return {...await request('/api/appearance',{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Control':'1'},body:JSON.stringify({target:applyTarget,patch:{background:imported.imported}})}),duplicate:imported.duplicate};
      });
      if(result) closeForm();
    });
  }
  bind();
  request('/themes.json').then(value=>{themes=value;apply();}).catch(()=>{if(!readonly)notice('主题库无法读取，请重新打开页面。',true);});
  return { update };
})();
