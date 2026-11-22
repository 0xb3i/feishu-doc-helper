(() => {
  'use strict';
  if (window.FDMImagePanel) return;

  const scriptSrc = document.currentScript && document.currentScript.src;
  const styles = globalThis.FeishuImagePanelStyles;
  const assetUrl = (path) => new URL(`../${path}`, scriptSrc).href;

  const ICON_CHECK = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.75 8.25 2.75 2.75 5.75-6"/></svg>';
  const ICON_CLOSE = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>';
  const ICON_EXTRACT =
    '<svg class="icon icon-idle" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.75v7M5.25 7 8 9.75 10.75 7"/><path d="M3 10.25v1.5c0 .83.67 1.5 1.5 1.5h7c.83 0 1.5-.67 1.5-1.5v-1.5"/></svg>';

  const formatSize = (bytes) =>
    bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  let current = null;

  function open({ images, onExtract, replaceTitle = null } = {}) {
    if (current) return current.focus();

    const host = document.createElement('div');
    host.id = 'fdm-image-panel';
    host.style.visibility = 'hidden';
    const root = host.attachShadow({ mode: styles ? 'closed' : 'open' });
    const sheet = styles ? new CSSStyleSheet() : null;
    if (sheet) {
      sheet.replaceSync(styles);
      root.adoptedStyleSheets = [sheet];
    }

    root.innerHTML = `
      ${sheet ? '' : `<link rel="stylesheet" href="${assetUrl('shared/base.css')}">
        <link rel="stylesheet" href="${assetUrl('content/image-panel.css')}">`}
      <div class="scrim" data-act="close"></div>
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="fdm-title" tabindex="-1">
        <header class="head">
          <h2 id="fdm-title">选择图片</h2>
          <span class="count" data-ref="count"></span>
          <span class="head-spacer"></span>
          <button class="text-btn" type="button" data-act="toggle-all" disabled>全选</button>
          <span class="head-divider" aria-hidden="true"></span>
          <button class="icon-btn" type="button" data-act="close" aria-label="关闭">${ICON_CLOSE}</button>
        </header>
        <div class="grid-wrap">
          <div class="grid" data-ref="grid" role="group" aria-label="文档中的图片"></div>
        </div>
        <div class="toast panel-toast" data-ref="error" data-tone="error" aria-live="polite"></div>
        <footer class="foot">
          <div class="summary">
            <span class="summary-main is-muted" data-ref="summary">未选择</span>
          </div>
          <button class="btn" type="button" data-act="download" disabled hidden>下载所选</button>
          <button class="btn" type="button" data-act="cancel">取消</button>
          <button class="btn btn-primary" type="button" data-act="extract" disabled>
            ${ICON_EXTRACT}${ICON_CHECK.replace('class="icon"', 'class="icon icon-done"')}
            <span class="btn-label">${replaceTitle ? '替换并提取' : '提取所选'}</span>
          </button>
        </footer>
      </div>`;

    const $ = (name) => root.querySelector(`[data-ref="${name}"]`);
    const grid = $('grid');
    const errorEl = $('error');
    const downloadBtn = root.querySelector('[data-act="download"]');
    const closeBtns = Array.from(root.querySelectorAll('button[data-act="close"], button[data-act="cancel"]'));
    const countEl = $('count');
    const summary = $('summary');
    const idleLabel = replaceTitle ? '替换并提取' : '提取所选';
    const toggleAllBtn = root.querySelector('[data-act="toggle-all"]');
    const extractBtn = root.querySelector('[data-act="extract"]');
    const panel = root.querySelector('.panel');

    const state = { images: [], selected: new Set(), anchor: -1, busy: false, downloadOpen: false };
    const previousFocus = document.activeElement;
    const previousOverflow = document.documentElement.style.overflow;

    /* —— 渲染 —— */

    function renderSkeleton() {
      grid.innerHTML = Array.from({ length: 10 }, () => '<div class="tile is-skeleton" aria-hidden="true"></div>').join('');
      countEl.textContent = '';
    }

    function renderEmpty(text, actionLabel) {
      grid.parentElement.innerHTML = `<div class="empty"><span>${text}</span>${
        actionLabel ? `<button class="btn" type="button" data-act="close">${actionLabel}</button>` : ''
      }</div>`;
    }

    function renderTiles() {
      grid.replaceChildren(
        ...state.images.map((img, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tile';
          b.dataset.index = String(i);
          b.setAttribute('aria-pressed', 'false');
          const dims = img.width > 0 && img.height > 0 ? `${img.width} × ${img.height}` : '';
          b.setAttribute('aria-label', [img.name || img.alt || `图片 ${i + 1}`, dims].filter(Boolean).join('，'));
          b.innerHTML = `<img alt="" loading="lazy" decoding="async"><span class="check">${ICON_CHECK}</span><span class="dims"></span>`;
          b.querySelector('.dims').textContent = dims;
          b.querySelector('img').src = img.src;
          return b;
        }),
      );
      countEl.textContent = `${state.images.length} 张`;
      toggleAllBtn.disabled = false;
    }

    function syncSelection() {
      const n = state.selected.size;
      grid.querySelectorAll('.tile').forEach((t) => {
        t.setAttribute('aria-pressed', String(state.selected.has(Number(t.dataset.index))));
      });
      grid.classList.toggle('has-selection', n > 0);
      const all = n === state.images.length && n > 0;
      toggleAllBtn.textContent = all ? '全不选' : '全选';
      if (n === 0) {
        summary.textContent = '未选择';
      } else {
        const bytes = [...state.selected].reduce((s, i) => s + (state.images[i].bytes || 0), 0);
        summary.textContent = `已选 ${n} 张${bytes ? `　${formatSize(bytes)}` : ''}`;
      }
      summary.classList.toggle('is-muted', n === 0);
      if (!n) state.downloadOpen = false;
      downloadBtn.hidden = !state.downloadOpen;
      extractBtn.disabled = downloadBtn.disabled = state.busy || n === 0;
    }

    function setExtractLabel(text, mode = '') {
      extractBtn.querySelector('.btn-label').textContent = text;
      extractBtn.dataset.state = mode;
      extractBtn.querySelector('.icon-idle').style.display = mode === 'done' ? 'none' : '';
    }

    /* —— 选择 —— */

    function toggle(index, { range = false } = {}) {
      if (range && state.anchor >= 0) {
        const on = !state.selected.has(index);
        const [a, b] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
        for (let i = a; i <= b; i++) on ? state.selected.add(i) : state.selected.delete(i);
      } else {
        state.selected.has(index) ? state.selected.delete(index) : state.selected.add(index);
      }
      state.anchor = index;
      syncSelection();
    }

    function toggleAll() {
      const all = state.selected.size === state.images.length;
      state.selected = all ? new Set() : new Set(state.images.map((_, i) => i));
      syncSelection();
    }

    function selectedImages() {
      return [...state.selected].sort((a, b) => a - b).map((index) => state.images[index]);
    }

    let errorTimer;

    async function extract() {
      if (state.busy || !state.selected.size) return;
      state.busy = true;
      const selected = selectedImages();
      grid.classList.add('is-busy');
      toggleAllBtn.disabled = true;
      closeBtns.forEach((button) => { button.disabled = true; });
      clearTimeout(errorTimer);
      errorEl.textContent = '';
      extractBtn.setAttribute('aria-busy', 'true');
      setExtractLabel('提取中', 'busy');
      syncSelection();
      try {
        await onExtract(selected, ({ label, done, total }) => {
          setExtractLabel(total ? `${label} ${done}/${total}` : label || '提取中', 'busy');
        });
        setExtractLabel(`已提取 ${selected.length} 张`, 'done');
        summary.textContent = `已提取 ${selected.length} 张到缓存`;
        setTimeout(() => {
          state.busy = false;
          close();
        }, 650);
      } catch (error) {
        state.busy = false;
        grid.classList.remove('is-busy');
        toggleAllBtn.disabled = false;
        closeBtns.forEach((button) => { button.disabled = false; });
        extractBtn.removeAttribute('aria-busy');
        setExtractLabel(idleLabel);
        errorEl.textContent = error.message || String(error);
        errorTimer = setTimeout(() => { errorEl.textContent = ''; }, 7000);
        syncSelection();
      }
    }

    let downloadTimers = [];
    function downloadSelected() {
      downloadTimers.forEach(clearTimeout);
      downloadTimers = selectedImages().map((img, index) => setTimeout(() => {
        const link = document.createElement('a');
        link.href = img.src;
        link.download = `feishu_img_${img.index + 1}.png`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
      }, index * 300));
    }

    /* —— 键盘 —— */

    function columns() {
      return getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
    }

    function focusTile(i) {
      const tiles = grid.querySelectorAll('.tile');
      if (!tiles.length) return;
      const t = tiles[Math.max(0, Math.min(tiles.length - 1, i))];
      t.focus();
      t.scrollIntoView({ block: 'nearest' });
    }

    function focusables() {
      return [...root.querySelectorAll('button:not([disabled])')].filter((b) => b.offsetParent !== null);
    }

    panel.addEventListener('keydown', (e) => {
      const active = root.activeElement;
      const index = active && active.classList.contains('tile') ? Number(active.dataset.index) : -1;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (state.downloadOpen) {
          state.downloadOpen = false;
          syncSelection();
          if (active === downloadBtn) panel.focus();
        } else {
          close();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && state.images.length && !state.busy) {
        e.preventDefault();
        state.selected = new Set(state.images.map((_, i) => i));
        syncSelection();
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && (index >= 0 || active === panel)) {
        e.preventDefault();
        if (index < 0) return focusTile(0);
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[e.key];
        focusTile(index + step);
      } else if (e.key === 'Tab') {
        const list = focusables();
        const first = list[0];
        const last = list[list.length - 1];
        if (!first) {
          e.preventDefault();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    root.addEventListener('contextmenu', (e) => {
      if (!styles || !e.isTrusted || state.busy || !state.selected.size || !e.target.closest('.tile')) return;
      e.preventDefault();
      state.downloadOpen = true;
      syncSelection();
      downloadBtn.focus();
    });

    root.addEventListener('click', (e) => {
      const target = e.target.closest('[data-act], .tile');
      if (!target || state.busy || styles && !e.isTrusted) return;
      if (target.classList.contains('tile')) {
        toggle(Number(target.dataset.index), { range: e.shiftKey });
        return;
      }
      const act = target.dataset.act;
      if (act === 'cancel' || act === 'close') close();
      if (act === 'download') downloadSelected();
      if (act === 'toggle-all') toggleAll();
      if (act === 'extract') void extract();
    });

    root.addEventListener('wheel', (e) => {
      if (!e.target.closest || !e.target.closest('.grid-wrap')) e.preventDefault();
    }, { passive: false });

    /* —— 打开与关闭 —— */

    function close() {
      if (current?.close !== close || state.busy) return;
      current = null;
      clearTimeout(errorTimer);
      downloadTimers.forEach(clearTimeout);
      host.classList.remove('is-open');
      host.classList.add('is-closing');
      document.documentElement.style.overflow = previousOverflow;
      setTimeout(() => {
        host.remove();
        if (!current && previousFocus?.isConnected) previousFocus.focus();
      }, 160);
    }

    current = { focus: () => panel.focus(), close };
    document.documentElement.appendChild(host);
    document.documentElement.style.overflow = 'hidden';

    const sheets = [...root.querySelectorAll('link')].map(
      (l) => new Promise((r) => {
        l.addEventListener('load', r, { once: true });
        l.addEventListener('error', r, { once: true });
      }),
    );

    Promise.all(sheets).then(() => {
      if (current?.close !== close) return;
      host.style.visibility = '';
      requestAnimationFrame(() => {
        host.classList.add('is-open');
        panel.focus({ preventScroll: true });
      });
    });

    renderSkeleton();
    Promise.resolve(images)
      .then((list) => {
        if (current?.close !== close) return;
        state.images = Array.isArray(list) ? list : [];
        if (!state.images.length) {
          countEl.textContent = '0 张';
          renderEmpty('这篇文档里没有图片', '关闭');
          return;
        }
        renderTiles();
        syncSelection();
      })
      .catch(() => {
        if (current?.close === close) renderEmpty('图片列表读取失败，请刷新快照后重试', '关闭');
      });

    return current;
  }

  window.FDMImagePanel = { open, close: () => current && current.close() };
})();
