(() => {
  'use strict';

  const protocol = globalThis.FeishuExtensionProtocol;
  if (!globalThis.chrome?.runtime?.id) return;

  const { MESSAGES } = protocol;
  const SNAPSHOT_MAX_AGE = 10 * 60 * 1000;
  const PENDING_KEY = 'feishu-pending-paste';
  const $ = (id) => document.getElementById(id);
  const state = {
    tab: null,
    pending: null,
    cacheReady: false,
    snapshot: null,
    loading: true,
    task: null,
    confirm: null,
    needsPageReload: false,
    flash: null,
    cacheActionsOpen: false,
  };

  function docKey(url) {
    if (!protocol.isSupportedDocumentUrl(url)) return '';
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.split('/').slice(0, 3).join('/');
  }

  function activeCache() {
    return state.pending?.expiresAt > Date.now() ? state.pending : null;
  }

  let toastTimer;
  function cleanNoticeText(text) {
    return String(text || '').replace(/^(?:[\u26A0\u2705\u23F3\uFE0F]|\uD83D[\uDCCB\uDCF7])+\s*/u, '').trim();
  }

  function isErrorNotice(text) {
    const raw = String(text || '').trim();
    return /^⚠️/u.test(raw);
  }

  function setFeedback(text, tone = 'error') {
    clearTimeout(toastTimer);
    const toast = $('popup-toast');
    const clean = cleanNoticeText(text);
    toast.dataset.tone = clean ? tone : '';
    toast.textContent = clean;
    if (clean) {
      toastTimer = setTimeout(() => { toast.textContent = ''; }, 7000);
    }
  }

  const pad = (n) => String(n).padStart(2, '0');

  function formatTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60_000);
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
    const m = Math.floor((Date.now() - ts) / 60_000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m}分钟前`;
    return `${Math.floor(m / 60)}小时前`;
  }

  function stats(counts) {
    const fragment = document.createDocumentFragment();
    for (const [value, unit] of counts) {
      const span = document.createElement('span');
      const number = document.createElement('b');
      span.className = 'stat';
      number.textContent = value;
      span.append(number, unit);
      fragment.append(span);
    }
    return fragment;
  }

  function summaryStats(summary) {
    const counts = [[summary.blockCount, '块'], [summary.imageCount, '图']];
    if (summary.whiteboardCount > 0) counts.push([summary.whiteboardCount, '画板']);
    return stats(counts);
  }

  function renderCard(action, description, disabled) {
    const card = $(`${action}-btn`);
    const task = state.task?.action === action ? state.task : null;
    const confirm = state.confirm?.action === action ? state.confirm : null;
    const title = action === 'extract' ? '提取' : '粘贴';
    const doneState = state.flash === action;
    card.dataset.state = task ? 'busy' : confirm ? 'confirm' : doneState ? 'done' : '';
    card.disabled = disabled && !task;
    card.setAttribute('aria-disabled', String(disabled));
    card.setAttribute('aria-busy', String(Boolean(task)));
    $(`${action}-title`).textContent = task ? `${title}中` : confirm ? confirm.title : doneState ? `已${title}` : title;
    const progress = task?.progress;
    const label = progress?.label || '准备中';
    const total = Number(progress?.total) || 0;
    const done = Math.min(Number(progress?.done) || 0, total);
    $(`${action}-desc`).replaceChildren(task ? (total ? `${label} ${done}/${total}` : label)
      : confirm ? confirm.description : description);
    const counts = action === 'extract' ? state.snapshot?.summary : activeCache()?.summary;
    $(`${action}-desc`).title = counts?.equationCount ? `${counts.equationCount} 个公式` : '';
    const blocks = counts?.blockCount || 0;
    const images = counts?.imageCount || 0;
    const imagePhase = /^(convert|upload|image-)/.test(progress?.phase || '');
    const blocksSeg = card.querySelector('.bar-blocks');
    const imagesSeg = card.querySelector('.bar-images');
    const imageShare = Math.max(0.24, Math.min(0.45, (images * 3) / (blocks + images * 3)));
    blocksSeg.hidden = Boolean(task && !blocks && images);
    imagesSeg.hidden = Boolean(task && !images);
    blocksSeg.style.flexGrow = blocks && images ? String((1 - imageShare).toFixed(2)) : '1';
    imagesSeg.style.flexGrow = blocks && images ? String(imageShare.toFixed(2)) : '1';
    const activeSegment = !imagesSeg.hidden && (imagePhase || blocksSeg.hidden) ? imagesSeg : blocksSeg;
    for (const segment of [blocksSeg, imagesSeg]) {
      const fill = segment.querySelector('i');
      const active = task && segment === activeSegment;
      fill.classList.toggle('is-indeterminate', Boolean(active && !total));
      fill.style.width = active && total ? `${100 * done / total}%`
        : task && imagePhase && segment === blocksSeg ? '100%' : '';
    }
  }

  function render() {
    const cache = activeCache();
    const supported = Boolean(docKey(state.tab?.url));
    const snapshot = state.snapshot;
    const stale = snapshot && Date.now() - snapshot.updatedAt >= SNAPSHOT_MAX_AGE;
    const snapshotReady = snapshot && !stale;
    const replacing = state.confirm?.action === 'extract';
    const clearMessage = state.confirm?.action === 'clear' ? state.confirm.message : '';
    const actionBusy = Boolean(state.task);
    const actionsDisabled = state.loading || actionBusy || !supported || !snapshotReady || !state.cacheReady;
    const unavailable = state.loading ? '读取快照中' : !supported ? '当前页不支持' : state.needsPageReload ? '' : '先刷新快照';

    $('head').classList.toggle('is-unsupported', !supported && !state.loading);
    $('head').classList.toggle('is-stale', Boolean(stale));
    $('doc-title').textContent = supported
      ? (state.tab.title || '未命名文档').replace(/\s*[-–—|]\s*(飞书云文档|飞书文档|Feishu Docs?|Lark Docs?|Lark)\s*$/i, '')
      : state.loading ? '识别当前页' : '非飞书文档页面';
    $('doc-title').title = state.tab?.title || '';
    $('doc-status').textContent = supported
      ? state.loading ? '读取中' : stale ? '已过期' : snapshot ? formatAge(snapshot.updatedAt) : '待刷新'
      : '';
    $('refresh-btn').disabled = state.loading || actionBusy;
    const refreshTip = state.needsPageReload ? '刷新飞书页面'
      : state.loading ? '正在刷新快照'
      : !supported ? '重新识别当前页'
      : stale ? '快照已过期，点击刷新'
      : snapshot ? `刷新快照 · ${formatAge(snapshot.updatedAt)}` : '刷新快照';
    $('refresh-btn').dataset.tip = refreshTip;
    $('refresh-btn').setAttribute('aria-label', refreshTip);
    $('refresh-btn').classList.toggle('is-attention', Boolean((state.needsPageReload || stale) && !state.loading));
    $('refresh-btn').classList.toggle('is-spinning', state.loading);

    renderCard('extract', snapshotReady ? summaryStats(snapshot.summary) : unavailable, actionsDisabled);
    renderCard('paste', !snapshotReady || !supported ? unavailable : cache
      ? cache.kind === 'images' ? stats([[cache.summary.imageCount, '张图片']]) : summaryStats(cache.summary)
      : state.cacheReady ? '缓存为空' : '读取缓存中', actionsDisabled || !cache);

    $('cache-card').classList.toggle('is-empty', !cache);
    $('cache-card').classList.toggle('is-images', cache?.kind === 'images');
    $('cache-card').classList.toggle('is-replacing', replacing);
    $('cache-card').classList.toggle('is-muted', Boolean(cache && (!supported || stale)));
    $('cache-card').tabIndex = cache ? 0 : -1;
    $('cache-title').textContent = cache?.title || (state.cacheReady ? '缓存区为空' : '读取缓存中');
    const cacheTime = cache ? formatTime(cache.ts) : '';
    $('cache-card').title = cache
      ? `${cache.title} · ${cache.savedFromHost} · ${cacheTime}提取 · 右键或按 Enter 管理缓存`
      : '';
    $('cache-pill').classList.toggle('is-warn', replacing);
    $('cache-pill').textContent = cache ? (replacing ? '将被替换' : cacheTime) : (state.cacheReady ? '待提取' : '');
    $('images-btn').disabled = !supported || state.loading || actionBusy || !state.cacheReady || !snapshotReady || !snapshot.summary.imageCount;
    $('images-count').textContent = snapshotReady ? String(snapshot.summary.imageCount) : '';
    $('images-label').textContent = state.task?.action === 'imagesExtract'
      ? state.task.progress?.total
        ? `${state.task.progress.label} ${state.task.progress.done}/${state.task.progress.total}`
        : state.task.progress?.label || '图片提取中' : '仅提取图片';
    const showClear = Boolean(cache && state.cacheActionsOpen);
    $('feedback').hidden = !showClear;
    $('feedback-text').textContent = clearMessage;
    $('clear-btn').hidden = !showClear;
    $('clear-btn').disabled = actionBusy || state.loading;
    $('clear-btn').textContent = state.confirm?.action === 'clear' ? '确认清空' : '清空缓存';
  }

  async function message(source, data = {}) {
    return chrome.runtime.sendMessage({ source, ...data });
  }

  let cacheRevision = 0;
  async function refreshCache() {
    const revision = ++cacheRevision;
    const response = await message(MESSAGES.PENDING_PASTE_QUERY);
    if (revision !== cacheRevision) return;
    if (!response?.ok) throw new Error(response?.error || '无法读取提取缓存');
    if (state.pending?.pendingId !== response.pending?.pendingId) {
      clearConfirm();
      state.cacheActionsOpen = false;
    }
    state.pending = response.pending;
    state.cacheReady = true;
  }

  async function sendAction(action, expectedPendingId) {
    if (!state.tab?.id || !docKey(state.tab.url)) throw new Error('当前标签页不是受支持的飞书文档');
    let result;
    try {
      const currentTab = await chrome.tabs.get(state.tab.id);
      if (docKey(currentTab?.url) !== docKey(state.tab.url)) throw new Error('当前文档已切换，请刷新快照');
      result = await chrome.tabs.sendMessage(state.tab.id, { source: MESSAGES.UI, action, expectedPendingId });
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/i.test(error.message)) {
        const missing = new Error('请刷新当前飞书页面以加载扩展');
        missing.reload = true;
        throw missing;
      }
      throw error;
    }
    if (result?.status !== 'success') throw new Error(result?.error || '页面脚本没有返回结果');
    return result;
  }

  async function scan() {
    const { summary } = await sendAction('scan');
    if (!['blockCount', 'imageCount', 'equationCount', 'whiteboardCount'].every(
      (key) => Number.isInteger(summary?.[key]) && summary[key] >= 0)) {
      throw new Error('飞书未返回完整的文档统计，请重试');
    }
    state.snapshot = { summary, updatedAt: Date.now() };
    const key = protocol.getSnapshotCacheKey(state.tab.id, state.tab.url);
    await chrome.storage.session.set({
      [key]: { ...state.snapshot, tabId: state.tab.id, url: state.tab.url.split('#')[0] },
    });
  }

  function fail(error) {
    if (error.reload) {
      state.snapshot = null;
      state.needsPageReload = true;
      setFeedback('');
      return;
    }
    setFeedback(error.message || String(error), 'error');
  }

  async function refresh(manual = false) {
    if (state.task) return;
    clearConfirm();
    state.loading = true;
    setFeedback('');
    render();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tab = tab;
      state.needsPageReload = false;
      await refreshCache();
      if (docKey(tab?.url)) {
        const beforeQuery = progressRevision;
        const response = await message(MESSAGES.PROGRESS_QUERY, { tabId: tab.id });
        if (beforeQuery === progressRevision && response?.progress) {
          applyProgress(response.progress);
        }
        const key = protocol.getSnapshotCacheKey(tab.id, tab.url);
        const saved = (await chrome.storage.session.get(key))[key];
        state.snapshot = saved || null;
        if (!state.task && (manual || !saved)) await scan();
      } else {
        state.snapshot = null;
      }
    } catch (error) {
      fail(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  let confirmTimer;
  function clearConfirm() {
    clearTimeout(confirmTimer);
    state.confirm = null;
  }

  function requestConfirmation(action, details) {
    if (state.confirm?.action === action) {
      if (performance.now() - state.confirm.startedAt < 350) return false;
      clearConfirm();
      return true;
    }
    clearConfirm();
    state.confirm = { action, ...details, startedAt: performance.now() };
    confirmTimer = setTimeout(() => {
      clearConfirm();
      render();
    }, 4000);
    render();
    return false;
  }

  let flashTimer;

  async function finish(action, notice) {
    if (action === 'extract' || action === 'imagesExtract') await refreshCache();
    if (action === 'paste') {
      state.snapshot = null;
      try {
        await scan();
      } catch (error) {
        if (error.reload) fail(error);
        else setFeedback(`${notice || '粘贴流程已结束'}。快照未更新：${error.message}`, 'error');
        return;
      }
    }
    const label = { extract: '文档已提取到缓存', paste: '粘贴完成', imagesExtract: '图片已提取到缓存' }[action];
    $('live').textContent = notice || label || '';
    if (action === 'extract' || action === 'paste') {
      state.flash = action;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        state.flash = null;
        render();
      }, 1600);
      // 正常成功由卡片勾选与计数更新表达，仅真正的报错/警告（⚠️）才显示错误提示条
      if (notice && isErrorNotice(notice)) {
        setFeedback(notice, 'error');
      }
    }
  }

  async function run(action) {
    if (state.task || state.loading) return;
    const cache = activeCache();
    if (action === 'extract' && cache && docKey(cache.savedFromHref) !== docKey(state.tab?.url)
      && !requestConfirmation(action, {
        title: '确认覆盖', description: '再点一次替换',
    })) return;
    if (action === 'paste' && cache) {
      const same = docKey(cache.savedFromHref) === docKey(state.tab?.url);
      const hasContent = state.snapshot?.summary.blockCount > 0;
      if ((same || hasContent) && !requestConfirmation(action, {
        title: '仍要粘贴', description: same ? '缓存来自本页' : '目标已有正文',
      })) return;
    }
    clearConfirm();
    state.flash = null;
    clearTimeout(flashTimer);
    state.cacheActionsOpen = false;
    state.task = { action, local: true };
    setFeedback('');
    render();
    try {
      const result = await sendAction(action, cache?.pendingId ?? null);
      if (action === 'images' && result.summary?.imageCount >= 0) window.close();
      else await finish(action, result.notice);
    } catch (error) {
      fail(error);
    } finally {
      state.task = null;
      render();
    }
  }

  let progressRevision = 0;
  function applyProgress(message) {
    const current = state.task;
    if (!message.requestId || !protocol.isUiAction(message.action)) return;
    if (current && (current.action !== message.action
      || current.requestId && current.requestId !== message.requestId)) return;
    if (message.state === 'done') {
      if (current?.local) return;
      state.task = null;
      if (message.status === 'error') setFeedback(message.error || '操作未完成', 'error');
      else {
        state.loading = true;
        void finish(message.action, message.notice).catch(fail).finally(() => {
          state.loading = false;
          render();
        });
      }
      return;
    }
    clearConfirm();
    setFeedback('');
    state.task = { ...current, action: message.action, requestId: message.requestId, progress: message };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (message?.source === MESSAGES.PROGRESS && sender.tab?.id === state.tab?.id && sender.frameId === 0) {
      progressRevision++;
      applyProgress(message);
      render();
    }
    if (message?.source !== MESSAGES.CLIPBOARD_WRITE_TARGET) return false;
    const validation = protocol.validateClipboardBridgePayload({
      imageDataUrl: String(message.imageDataUrl || ''),
      pasteAfterWrite: false,
    });
    if (!validation.ok || !document.hasFocus()) {
      respond({ ok: false, error: validation.error || '扩展弹窗当前未获得焦点' });
      return false;
    }
    globalThis.FeishuExtensionImageClipboard.writeImageDataUrl(message.imageDataUrl)
      .then(() => respond({ ok: true, written: true }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PENDING_KEY]) {
      void refreshCache().catch(fail).finally(render);
    }
  });

  for (const action of ['extract', 'paste', 'images']) {
    $(`${action}-btn`).addEventListener('click', () => void run(action));
  }
  $('refresh-btn').addEventListener('click', async () => {
    if (!state.needsPageReload) {
      await refresh(true);
      return;
    }
    state.loading = true;
    render();
    try {
      await chrome.tabs.reload(state.tab.id);
      window.close();
    } catch (error) {
      fail(error);
    } finally {
      state.loading = false;
      render();
    }
  });
  function openCacheActions(event) {
    if (!activeCache() || state.task || state.loading) return;
    event.preventDefault();
    state.cacheActionsOpen = true;
    render();
    $('clear-btn').focus();
  }

  $('cache-card').addEventListener('contextmenu', openCacheActions);
  $('cache-card').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') openCacheActions(event);
  });
  $('clear-btn').addEventListener('click', async () => {
    const cache = activeCache();
    if (!cache || state.loading || state.task) return;
    if (!requestConfirmation('clear', { message: '将移除当前提取缓存' })) return;
    state.loading = true;
    render();
    try {
      const result = await message(MESSAGES.PENDING_PASTE_CLEAR, { expectedPendingId: cache.pendingId });
      if (!result?.ok) throw new Error(result?.error || '无法清空缓存');
      await refreshCache();
      $('live').textContent = '缓存已清空';
    } catch (error) {
      fail(error);
    } finally {
      state.loading = false;
      render();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.key === 'Escape' && (state.confirm || state.cacheActionsOpen)) {
      event.preventDefault();
      if (state.cacheActionsOpen) $('cache-card').focus();
      state.cacheActionsOpen = false;
      clearConfirm();
      render();
      return;
    }
    const action = { e: 'extract', p: 'paste', i: 'images', r: 'refresh' }[event.key.toLowerCase()];
    if (action) $(`${action}-btn`).click();
  });
  setInterval(render, 1000);
  void refresh();
})();
