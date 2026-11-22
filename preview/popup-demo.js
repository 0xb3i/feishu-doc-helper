/*
 * 弹出窗交互原型（v3）。数据全部是模拟的，不连接后端。
 * 预览场景通过 ?scenario= 切换：default | empty | same | stale | unsupported | images
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    head: $('head'),
    title: $('doc-title'),
    status: $('doc-status'),
    refresh: $('refresh-btn'),
    extract: $('extract-btn'),
    extractTitle: $('extract-title'),
    extractDesc: $('extract-desc'),
    paste: $('paste-btn'),
    pasteTitle: $('paste-title'),
    pasteDesc: $('paste-desc'),
    cacheCard: $('cache-card'),
    cacheTitle: $('cache-title'),
    cachePill: $('cache-pill'),
    imagesBtn: $('images-btn'),
    imagesLabel: $('images-label'),
    imagesCount: $('images-count'),
    live: $('live'),
  };
  const barsOf = (btn) => ({
    blocksSeg: btn.querySelector('.bar-blocks'),
    blocksFill: btn.querySelector('.bar-blocks i'),
    imagesSeg: btn.querySelector('.bar-images'),
    imagesFill: btn.querySelector('.bar-images i'),
  });

  const MIN = 60 * 1000;
  const CONFIRM_MS = 4000;
  const CONFIRM_GUARD_MS = 350;

  /* —— 模拟数据 —— */

  const SOURCE = { docId: 'doc-a', title: '2026 Q4 产品路线图', host: 'acme.feishu.cn', blocks: 128, images: 24 };
  const TARGET = { docId: 'doc-b', title: 'Q4 产品路线图（迁移副本）', host: 'newco.feishu.cn', blocks: 36, images: 4 };

  const page = (doc, status = 'fresh') => ({
    supported: true,
    ...doc,
    snapshot: { status, takenAt: Date.now() - 2 * MIN },
  });
  const docCache = (doc, at) => ({ kind: 'doc', ...doc, extractedAt: at });

  const SCENARIOS = {
    default: () => ({ page: page(TARGET), cache: docCache(SOURCE, Date.now() - 40 * MIN) }),
    empty: () => ({ page: page(SOURCE), cache: null }),
    same: () => ({ page: page(SOURCE), cache: docCache(SOURCE, Date.now() - 40 * MIN) }),
    stale: () => ({ page: page(SOURCE, 'stale'), cache: docCache(TARGET, Date.now() - 26 * 60 * MIN) }),
    unsupported: () => ({
      page: { supported: false, title: '', host: 'www.example.com', blocks: 0, images: 0 },
      cache: docCache(SOURCE, Date.now() - 40 * MIN),
    }),
    images: () => ({
      page: page(TARGET),
      cache: { kind: 'images', ...SOURCE, blocks: 0, images: 6, extractedAt: Date.now() - 25 * MIN },
    }),
  };

  const scenario = new URLSearchParams(location.search).get('scenario') || 'default';
  const state = {
    ...(SCENARIOS[scenario] || SCENARIOS.default)(),
    task: null, // { kind: 'extract' | 'paste', progress }
    confirm: null, // { kind, at }
    flash: null, // 'extract' | 'paste'
    refreshing: false,
    pasted: null, // { kind, blocks, images }
  };

  let confirmTimer = 0;
  let flashTimer = 0;

  /* —— 格式化 —— */

  const pad = (n) => String(n).padStart(2, '0');

  function formatTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / MIN);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const d = new Date(ts);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const days = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
    if (days === 1) return `昨天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function formatAge(ts) {
    const m = Math.floor((Date.now() - ts) / MIN);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m}分钟前`;
    return `${Math.floor(m / 60)}小时前`;
  }

  const announce = (text) => {
    el.live.textContent = text;
  };

  /* —— 派生状态 —— */

  const isStale = () => state.page.supported && state.page.snapshot.status === 'stale';
  const isSamePage = () => !!state.cache && state.page.supported && state.cache.docId === state.page.docId;
  const busy = () => !!state.task || state.refreshing;

  function modeOf(kind) {
    if (state.task?.kind === kind) return 'busy';
    if (state.confirm?.kind === kind) return 'confirm';
    if (state.flash === kind) return 'done';
    return '';
  }

  function splitProgress(progress, blocks, images) {
    if (blocks > 0 && images > 0) {
      const split = 0.62;
      const b = Math.min(1, progress / split);
      const im = progress <= split ? 0 : Math.min(1, (progress - split) / (1 - split));
      return { phase: progress < split ? 'blocks' : 'images', b, im };
    }
    if (blocks > 0) return { phase: 'blocks', b: progress, im: 0 };
    return { phase: 'images', b: 0, im: progress };
  }

  function applyMode(btn, mode, disabled, counts) {
    btn.dataset.state = mode;
    btn.disabled = disabled && mode !== 'busy';
    btn.setAttribute('aria-busy', String(mode === 'busy'));
    const { blocksSeg, blocksFill, imagesSeg, imagesFill } = barsOf(btn);

    if (mode === 'busy' && counts) {
      const { blocks, images } = counts;
      const hasBlocks = blocks > 0;
      const hasImages = images > 0;
      blocksSeg.hidden = !hasBlocks;
      imagesSeg.hidden = !hasImages;

      if (hasBlocks && hasImages) {
        const imgShare = Math.max(0.24, Math.min(0.45, (images * 3) / (blocks + images * 3)));
        blocksSeg.style.flexGrow = String((1 - imgShare).toFixed(2));
        imagesSeg.style.flexGrow = String(imgShare.toFixed(2));
      } else {
        blocksSeg.style.flexGrow = '1';
        imagesSeg.style.flexGrow = '1';
      }

      const { b, im } = splitProgress(state.task.progress, blocks, images);
      blocksFill.style.width = `${b * 100}%`;
      imagesFill.style.width = `${im * 100}%`;
    } else {
      blocksSeg.hidden = false;
      imagesSeg.hidden = false;
      blocksFill.style.width = '';
      imagesFill.style.width = '';
    }
  }

  /* —— 渲染 —— */

  function renderHead() {
    const { page: pg, refreshing } = state;
    const stale = isStale() && !refreshing;

    el.head.classList.toggle('is-unsupported', !pg.supported);
    el.head.classList.toggle('is-stale', stale);

    el.title.textContent = pg.supported ? pg.title : '非飞书文档页面';
    el.title.title = pg.supported ? `${pg.title} · ${pg.host}` : pg.host;

    if (!pg.supported) {
      el.status.textContent = '';
    } else if (refreshing) {
      el.status.textContent = '刷新中';
    } else if (stale) {
      el.status.textContent = '已过期';
    } else {
      el.status.textContent = formatAge(pg.snapshot.takenAt);
    }

    const refreshTip = refreshing
      ? '正在刷新快照'
      : !pg.supported
        ? '重新识别当前页'
        : stale
          ? '快照已过期，点击刷新'
          : `刷新快照 · ${formatAge(pg.snapshot.takenAt)}`;
    el.refresh.dataset.tip = refreshTip;
    el.refresh.setAttribute('aria-label', refreshTip);
    el.refresh.classList.toggle('is-spinning', refreshing);
    el.refresh.classList.toggle('is-attention', stale);
    el.refresh.disabled = !!state.task;
  }

  function setStats(node, pairs) {
    node.replaceChildren(
      ...pairs.map(([num, unit]) => {
        const span = document.createElement('span');
        span.className = 'stat';
        const b = document.createElement('b');
        b.textContent = String(num);
        span.append(b, document.createTextNode(unit));
        return span;
      }),
    );
  }

  function renderExtract() {
    const { page: pg, task } = state;
    const mode = modeOf('extract');
    const titles = { busy: '提取中', confirm: '确认覆盖', done: '已提取' };
    el.extractTitle.textContent = titles[mode] || '提取';

    if (mode === 'busy') {
      const { phase, b, im } = splitProgress(task.progress, pg.blocks, pg.images);
      el.extractDesc.textContent =
        phase === 'blocks'
          ? `文档块 ${Math.round(pg.blocks * b)} / ${pg.blocks}`
          : `图片 ${Math.round(pg.images * im)} / ${pg.images}`;
    } else if (mode === 'confirm') {
      el.extractDesc.textContent = '再点一次替换';
    } else if (!pg.supported) {
      el.extractDesc.textContent = '当前页不支持';
    } else if (isStale()) {
      el.extractDesc.textContent = '先刷新快照';
    } else {
      const paste = task?.kind === 'paste' && state.cache ? splitProgress(task.progress, state.cache.blocks, state.cache.images) : null;
      const blocks = pg.blocks + Math.round((state.cache?.blocks || 0) * (paste ? paste.b : 0));
      const images = pg.images + Math.round((state.cache?.images || 0) * (paste ? paste.im : 0));
      setStats(el.extractDesc, [
        [blocks, '块'],
        [images, '图'],
      ]);
    }

    applyMode(el.extract, mode, !pg.supported || isStale() || busy(), { blocks: pg.blocks, images: pg.images });
  }

  function renderPaste() {
    const { page: pg, task, cache, pasted } = state;
    const mode = modeOf('paste');
    const titles = { busy: '粘贴中', confirm: '仍要粘贴', done: '已粘贴' };
    el.pasteTitle.textContent = titles[mode] || '粘贴';

    if (mode === 'busy') {
      const { phase, b, im } = splitProgress(task.progress, cache.blocks, cache.images);
      el.pasteDesc.textContent =
        phase === 'blocks'
          ? `文档块 ${Math.round(cache.blocks * b)} / ${cache.blocks}`
          : `图片 ${Math.round(cache.images * im)} / ${cache.images}`;
    } else if (mode === 'confirm') {
      el.pasteDesc.textContent = '缓存来自本页';
    } else if (!pg.supported) {
      el.pasteDesc.textContent = '当前页不支持';
    } else if (isStale()) {
      el.pasteDesc.textContent = '先刷新快照';
    } else if (!cache) {
      el.pasteDesc.textContent = '缓存为空';
    } else if (pasted) {
      el.pasteDesc.textContent =
        pasted.kind === 'images' ? `已写入 ${pasted.images} 张图` : `已写入 ${pasted.blocks} 块`;
    } else if (cache.kind === 'images') {
      setStats(el.pasteDesc, [[cache.images, '张图片']]);
    } else {
      setStats(el.pasteDesc, [
        [cache.blocks, '块'],
        [cache.images, '图'],
      ]);
    }

    el.paste.title = cache ? `写入来自「${cache.title}」的缓存` : '';
    applyMode(
      el.paste,
      mode,
      !cache || !pg.supported || isStale() || busy(),
      cache ? { blocks: cache.blocks, images: cache.images } : null,
    );
  }

  function renderCache() {
    const { page: pg, cache } = state;
    const replacing = state.confirm?.kind === 'extract' && !!cache;
    const muted = !pg.supported || isStale();

    el.cacheCard.classList.toggle('is-empty', !cache);
    el.cacheCard.classList.toggle('is-images', cache?.kind === 'images');
    el.cacheCard.classList.toggle('is-replacing', replacing);
    el.cacheCard.classList.toggle('is-muted', !!cache && muted);

    if (!cache) {
      el.cacheTitle.textContent = '缓存区为空';
      el.cachePill.textContent = '待提取';
      el.cachePill.className = 'cache-tag';
      el.cacheCard.title = '在源文档点击「提取」即可写入缓存';
      return;
    }

    el.cacheTitle.textContent = cache.title;
    el.cacheCard.title = `${cache.kind === 'images' ? '图片缓存' : '文档缓存'} · ${cache.title} (${cache.host})`;

    if (replacing) {
      el.cachePill.textContent = '将被替换';
      el.cachePill.className = 'cache-tag is-warn';
    } else {
      el.cachePill.textContent = formatTime(cache.extractedAt);
      el.cachePill.className = 'cache-tag';
    }
  }

  function renderImagesCta() {
    const { page: pg } = state;
    const stale = isStale();
    const disabled = !pg.supported || stale || !pg.images || busy();

    el.imagesBtn.disabled = disabled;
    el.imagesLabel.textContent = '仅提取图片';

    if (!pg.supported || stale) {
      el.imagesCount.textContent = '';
    } else if (!pg.images) {
      el.imagesCount.textContent = '0';
    } else {
      el.imagesCount.textContent = String(pg.images);
    }
  }

  function render() {
    renderHead();
    renderExtract();
    renderPaste();
    renderCache();
    renderImagesCta();
  }

  /* —— 任务（模拟） —— */

  function runTask(kind, durationMs) {
    clearTimeout(flashTimer);
    state.flash = null;
    state.task = { kind, progress: 0 };
    render();
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / durationMs);
        state.task.progress = 1 - Math.pow(1 - t, 1.6);
        render();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  function flash(kind) {
    clearTimeout(flashTimer);
    state.flash = kind;
    render();
    flashTimer = setTimeout(() => {
      state.flash = null;
      render();
    }, 1600);
  }

  /* —— 确认：再点一次才执行，350ms 内的连点无效，4 秒后失效 —— */

  function needsConfirm(kind) {
    if (state.confirm?.kind === kind) {
      if (performance.now() - state.confirm.at < CONFIRM_GUARD_MS) return true;
      clearConfirm();
      return false;
    }
    clearConfirm();
    state.confirm = { kind, at: performance.now() };
    confirmTimer = setTimeout(() => {
      state.confirm = null;
      render();
    }, CONFIRM_MS);
    render();
    return true;
  }

  function clearConfirm() {
    clearTimeout(confirmTimer);
    state.confirm = null;
  }

  /* —— 操作 —— */

  async function onExtract() {
    const { page: pg, cache } = state;
    if (busy() || !pg.supported || isStale()) return;
    if (cache && cache.docId !== pg.docId && needsConfirm('extract')) return;
    clearConfirm();
    state.pasted = null;

    await runTask('extract', 2200);
    state.task = null;
    state.cache = docCache(pg, Date.now());
    flash('extract');
    announce(`已提取「${pg.title}」到缓存`);
  }

  async function onPaste() {
    const { page: pg, cache } = state;
    if (busy() || !cache || !pg.supported || isStale()) return;
    if (isSamePage() && needsConfirm('paste')) return;
    clearConfirm();
    state.pasted = null;

    await runTask('paste', 2000);
    state.task = null;
    pg.blocks += cache.blocks;
    pg.images += cache.images;
    pg.snapshot = { status: 'fresh', takenAt: Date.now() };
    state.pasted = { kind: cache.kind, blocks: cache.blocks, images: cache.images };
    flash('paste');
    announce(
      cache.kind === 'images'
        ? `已写入 ${cache.images} 张图片`
        : `已写入 ${cache.blocks} 块、${cache.images} 张图片`,
    );
  }

  async function onRefresh() {
    if (busy()) return;
    clearConfirm();
    state.refreshing = true;
    state.pasted = null;
    render();
    await new Promise((r) => setTimeout(r, 850));
    state.refreshing = false;
    if (state.page.supported) state.page.snapshot = { status: 'fresh', takenAt: Date.now() };
    render();
    announce('快照已刷新');
  }

  function onOpenImages() {
    const { page: pg, cache } = state;
    if (el.imagesBtn.disabled) return;
    clearConfirm();
    const message = {
      type: 'fdm:open-image-panel',
      count: pg.images,
      replaceTitle: cache && cache.docId !== pg.docId ? cache.title : null,
    };
    if (window.parent !== window) window.parent.postMessage(message, '*');
  }

  el.extract.addEventListener('click', onExtract);
  el.paste.addEventListener('click', onPaste);
  el.refresh.addEventListener('click', onRefresh);
  el.imagesBtn.addEventListener('click', onOpenImages);

  /* —— 与预览页通信 —— */

  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type !== 'fdm:images-extracted') return;
    const pg = state.page;
    state.cache = {
      kind: 'images',
      docId: pg.docId,
      title: pg.title,
      host: pg.host,
      blocks: 0,
      images: msg.count,
      extractedAt: Date.now(),
    };
    state.pasted = null;
    render();
    announce(`已提取 ${msg.count} 张图片到缓存`);
  });

  if (window.parent !== window) {
    const report = () =>
      window.parent.postMessage(
        { type: 'fdm:popup-height', height: Math.ceil(document.body.getBoundingClientRect().height) },
        '*',
      );
    new ResizeObserver(report).observe(document.body);
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'fdm:request-height') report();
    });
  }

  render();
})();
