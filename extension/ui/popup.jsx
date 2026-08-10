import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/protocol.js';
import '../shared/image-clipboard.js';
import './popup.css';

const protocol = globalThis.FeishuExtensionProtocol;
const FEISHU_EXTENSION_UI = protocol.MESSAGES.UI;
const FEISHU_EXTENSION_PROGRESS = protocol.MESSAGES.PROGRESS;
const FEISHU_EXTENSION_PROGRESS_QUERY = protocol.MESSAGES.PROGRESS_QUERY;
const SNAPSHOT_CACHE_PREFIX = 'feishu-snapshot:';

function handleFocusedClipboardWrite(message, sender, sendResponse) {
  if (!message || message.source !== protocol.MESSAGES.CLIPBOARD_WRITE_TARGET) return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const validation = protocol.validateClipboardBridgePayload({
    imageDataUrl: String(message.imageDataUrl || ''),
    pasteAfterWrite: false,
  });
  if (!validation.ok) {
    sendResponse({ ok: false, error: validation.error });
    return false;
  }
  if (!document.hasFocus()) {
    sendResponse({ ok: false, error: '扩展弹窗当前未获得焦点' });
    return false;
  }
  globalThis.FeishuExtensionImageClipboard.writeImageDataUrl(String(message.imageDataUrl || ''))
    .then(function () { sendResponse({ ok: true, written: true }); })
    .catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
  return true;
}

chrome.runtime.onMessage.addListener(handleFocusedClipboardWrite);
window.addEventListener('unload', function () {
  chrome.runtime.onMessage.removeListener(handleFocusedClipboardWrite);
}, { once: true });

const ACTIONS = [
  {
    key: 'extract',
    title: '提取文档',
    description: '读取源文档结构，写入扩展共享缓存',
    icon: (
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 11v5m0 0 2-2m-2 2-2-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'paste',
    title: '粘贴副本',
    description: '把最近一次提取的内容写入目标文档',
    icon: (
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
        <rect x="8" y="2.5" width="8" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 4.5H6.5a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2H15" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8.5 11.5h7M8.5 15h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'images',
    title: '图片',
    description: '列出当前页面可提取图片',
    icon: (
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" strokeWidth="1.6" />
        <path d="m4.5 17 4-4a1.6 1.6 0 0 1 2.2 0l3.3 3.3m0 0 2-2a1.6 1.6 0 0 1 2.2 0l1.3 1.3m-5.5.7 1.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'snapshot',
    title: '快照',
    description: '重新读取页面结构，确认当前内容',
    icon: (
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
        <path d="M4 8.5a2 2 0 0 1 2-2h1.6l1-1.6a1 1 0 0 1 .85-.48h5.1a1 1 0 0 1 .85.48l1 1.6H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
];

const INITIAL_STATUS = {
  type: 'info',
  text: '选择一个操作开始。',
};

const ALERT_ICONS = {
  info: 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm32 664c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V456c0-4.4 3.6-8 8-8h48c4.4 0 8 3.6 8 8v272zm-32-344a48 48 0 1 1 0-96 48 48 0 0 1 0 96z',
  success: 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm193.5 301.7l-210.6 292a31.8 31.8 0 0 1-51.7 0L318.5 484.9c-3.8-5.3 0-12.7 6.5-12.7h46.9c10.2 0 19.9 4.9 25.9 13.3l71.2 98.8 157.2-218c6-8.3 15.6-13.3 25.9-13.3H699c6.5 0 10.3 7.4 6.5 12.7z',
  warning: 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm-32 232c0-4.4 3.6-8 8-8h48c4.4 0 8 3.6 8 8v272c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V296zm32 440a48 48 0 1 1 0-96 48 48 0 0 1 0 96z',
  error: 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm165.4 618.2l-66-.3L512 563.4l-99.3 118.4-66.1.3c-4.4 0-8-3.5-8-8 0-1.9.7-3.7 1.9-5.2l130.1-155L340.5 359a8.32 8.32 0 0 1-1.9-5.2c0-4.4 3.6-8 8-8l66.1.3L512 464.6l99.3-118.4 66-.3c4.4 0 8 3.5 8 8 0 1.9-.7 3.7-1.9 5.2L553.5 514l130 155c1.2 1.5 1.9 3.3 1.9 5.2 0 4.4-3.6 8-8 8z',
};

function isFeishuUrl(url) {
  return protocol.isSupportedDocumentUrl(url);
}

function getActiveTab() {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
    return Promise.reject(new Error('当前环境不是 Chrome 扩展页。'));
  }
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    return tabs && tabs[0] ? tabs[0] : null;
  });
}

function sendFeishuAction(action) {
  return getActiveTab().then(function (tab) {
    return sendFeishuActionToTab(tab, action);
  });
}

function sendFeishuActionToTab(tab, action) {
  const tabId = Number((tab && (tab.id || tab.tabId)) || 0);
  const url = String((tab && tab.url) || '');
  if (!tabId) return Promise.reject(new Error('没有找到当前标签页。'));
  if (url && !isFeishuUrl(url)) return Promise.reject(new Error('当前标签页不是飞书/Lark 文档。'));
  return chrome.tabs.sendMessage(tabId, {
    source: FEISHU_EXTENSION_UI,
    action: action,
  }).catch(function (error) {
    const message = String(error && error.message ? error.message : error);
    if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
      throw new Error('扩展刚安装或更新，当前页面还未加载脚本。请刷新此飞书文档页面后重试。');
    }
    throw error;
  });
}

function normalizeSummary(summary) {
  return {
    blockCount: Number((summary && summary.blockCount) || 0),
    equationCount: Number((summary && summary.equationCount) || 0),
    imageCount: Number((summary && summary.imageCount) || 0),
    whiteboardCount: Number((summary && summary.whiteboardCount) || 0),
  };
}

function normalizeOfficialSummary(summary) {
  const fields = ['blockCount', 'equationCount', 'imageCount', 'whiteboardCount'];
  const complete = summary && fields.every(function (field) {
    return Number.isInteger(summary[field]) && summary[field] >= 0;
  });
  return complete ? normalizeSummary(summary) : null;
}

function getSnapshotPageUrl(tab) {
  const rawUrl = String((tab && tab.url) || '');
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return rawUrl;
  }
}

function getSnapshotCacheKey(tab) {
  return SNAPSHOT_CACHE_PREFIX + Number((tab && (tab.tabId || tab.id)) || 0)
    + ':' + getSnapshotPageUrl(tab);
}

function loadSnapshotCache(tab) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    return Promise.resolve(null);
  }
  const key = getSnapshotCacheKey(tab);
  return chrome.storage.session.get(key).then(function (items) {
    const record = items && items[key];
    if (!record
      || Number(record.tabId || 0) !== Number((tab && (tab.tabId || tab.id)) || 0)
      || String(record.url || '') !== getSnapshotPageUrl(tab)) {
      return null;
    }
    return normalizeOfficialSummary(record.summary);
  }).catch(function () {
    return null;
  });
}

function saveSnapshotCache(tab, summary) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    return Promise.resolve();
  }
  const key = getSnapshotCacheKey(tab);
  const value = {};
  value[key] = {
    tabId: Number((tab && (tab.tabId || tab.id)) || 0),
    url: getSnapshotPageUrl(tab),
    summary: summary,
    updatedAt: Date.now(),
  };
  return chrome.storage.session.set(value);
}

function summarizeResult(action, result) {
  if (!result || result.status === 'error') {
    return (result && result.error) || '页面脚本没有返回结果。';
  }
  const summary = normalizeSummary(result.summary);
  if (action === 'extract') {
    return '已提取 ' + summary.blockCount + ' 文档块 · '
      + summary.equationCount + ' 公式 · '
      + summary.imageCount + ' 图片 · '
      + summary.whiteboardCount + ' 画板';
  }
  if (action === 'paste') return '粘贴流程已触发。';
  if (action === 'images') return '图片面板已打开。';
  if (action === 'snapshot') return '页面快照已刷新。';
  return '操作已完成。';
}

function getActionTitle(actionKey) {
  const action = ACTIONS.find(function (item) { return item.key === actionKey; });
  return action ? action.title : '未知操作';
}

function parseTab(tab) {
  const url = tab && tab.url ? tab.url : '';
  let host = '未识别';
  try {
    host = url ? new URL(url).host : '未识别';
  } catch (_error) {
    host = '未识别';
  }
  return {
    tabId: Number((tab && tab.id) || 0),
    loading: false,
    title: (tab && tab.title) || '未命名标签页',
    host: host,
    url: url,
    supported: isFeishuUrl(url),
    error: '',
  };
}

function StatusTag({ variant, children }) {
  return (
    <span className={'status-tag status-tag--' + variant}>
      <span className="status-tag__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function AlertBox({ type, title, text }) {
  return (
    <div className={'alert alert--' + type} role="status" aria-live="polite">
      <svg className="alert__icon" viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor" aria-hidden="true">
        <path d={ALERT_ICONS[type] || ALERT_ICONS.info} />
      </svg>
      <div className="alert__content">
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function ProgressBar({ percent, label, done, total }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="progress" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__head">
        <span className="progress__label">{label}</span>
        <span className="progress__count">{total > 0 ? done + ' / ' + total : clamped + '%'}</span>
      </div>
      <div className="progress__track">
        <div className="progress__fill" style={{ width: clamped + '%' }} />
      </div>
    </div>
  );
}

function Panel() {
  const [runningAction, setRunningAction] = useState('');
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [target, setTarget] = useState({
    tabId: 0,
    loading: true,
    title: '正在读取当前标签页',
    host: '读取中',
    url: '',
    supported: false,
    error: '',
  });
  const [overview, setOverview] = useState({ state: 'loading', summary: null, error: '' });
  const [lastResult, setLastResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const progressRequestIdRef = useRef('');
  const localActionRef = useRef(null);
  const nextLocalActionIdRef = useRef(0);
  const scanEpochRef = useRef(0);

  function scanMetrics(tab) {
    const epoch = scanEpochRef.current + 1;
    scanEpochRef.current = epoch;
    setOverview({ state: 'loading', summary: null, error: '' });
    return sendFeishuActionToTab(tab, 'scan').then(function (result) {
      if (scanEpochRef.current !== epoch) return;
      const summary = result && result.status !== 'error'
        ? normalizeOfficialSummary(result.summary)
        : null;
      if (!summary) {
        throw new Error((result && result.error) || '页面快照尚未准备完成');
      }
      setOverview({ state: 'ready', summary: summary, error: '' });
      return saveSnapshotCache(tab, summary).catch(function () {}).then(function () {
        return summary;
      });
    }).catch(function (error) {
      if (scanEpochRef.current !== epoch) return null;
      setOverview({
        state: 'error',
        summary: null,
        error: String(error && error.message ? error.message : error),
      });
      throw error;
    });
  }

  function loadTarget() {
    scanEpochRef.current += 1;
    const targetEpoch = scanEpochRef.current;
    setOverview({ state: 'loading', summary: null, error: '' });
    setTarget(function (previous) {
      return Object.assign({}, previous, { loading: true, error: '' });
    });
    getActiveTab().then(function (tab) {
      if (!tab) throw new Error('没有找到当前标签页。');
      const parsed = parseTab(tab);
      setTarget(parsed);
      if (!parsed.supported) {
        setOverview({ state: 'error', summary: null, error: '当前标签页不是飞书文档' });
        return;
      }
      return loadSnapshotCache(parsed).then(function (summary) {
        if (scanEpochRef.current !== targetEpoch) return;
        if (summary) {
          setOverview({ state: 'ready', summary: summary, error: '' });
          return;
        }
        return scanMetrics(parsed).catch(function () {});
      });
    }).catch(function (error) {
      scanEpochRef.current += 1;
      setOverview({ state: 'error', summary: null, error: '无法读取页面快照' });
      setTarget({
        tabId: 0,
        loading: false,
        title: '当前标签页不可用',
        host: '不可用',
        url: '',
        supported: false,
        error: String(error && error.message ? error.message : error),
      });
    });
  }

  function run(action) {
    const localActionId = nextLocalActionIdRef.current + 1;
    nextLocalActionIdRef.current = localActionId;
    localActionRef.current = { id: localActionId, action: action };
    setRunningAction(action);
    setProgress(null);
    setStatus({ type: 'info', text: '正在执行：' + getActionTitle(action) });
    sendFeishuAction(action).then(function (result) {
      if (!localActionRef.current || localActionRef.current.id !== localActionId) return;
      const isError = !result || result.status !== 'success';
      // 失败时必须展示 error；最后一条“正在处理”toast 只是过程状态，不能覆盖根因。
      const text = summarizeResult(action, result);
      const summary = normalizeSummary(result && result.summary);

      setStatus({ type: isError ? 'error' : 'success', text: text });
      setLastResult({
        action: action,
        type: isError ? 'error' : 'success',
        text: text,
        summary: summary,
      });
    }).catch(function (error) {
      if (!localActionRef.current || localActionRef.current.id !== localActionId) return;
      const text = String(error && error.message ? error.message : error);
      setStatus({ type: 'error', text: text });
      setLastResult({
        action: action,
        type: 'error',
        text: text,
        summary: normalizeSummary(),
      });
    }).finally(function () {
      if (!localActionRef.current || localActionRef.current.id !== localActionId) return;
      localActionRef.current = null;
      progressRequestIdRef.current = '';
      setRunningAction('');
      setProgress(null);
    });
  }

  function refreshSnapshot() {
    const localActionId = nextLocalActionIdRef.current + 1;
    nextLocalActionIdRef.current = localActionId;
    localActionRef.current = { id: localActionId, action: 'snapshot' };
    setRunningAction('snapshot');
    setProgress(null);
    setStatus({ type: 'info', text: '正在执行：' + getActionTitle('snapshot') });
    scanMetrics(target).then(function (summary) {
      if (!summary || !localActionRef.current || localActionRef.current.id !== localActionId) return;
      const text = summarizeResult('snapshot', { status: 'success', summary: summary });
      setStatus({ type: 'success', text: text });
      setLastResult({ action: 'snapshot', type: 'success', text: text, summary: summary });
    }).catch(function (error) {
      if (!localActionRef.current || localActionRef.current.id !== localActionId) return;
      const text = String(error && error.message ? error.message : error);
      setStatus({ type: 'error', text: text });
      setLastResult({
        action: 'snapshot',
        type: 'error',
        text: text,
        summary: normalizeSummary(),
      });
    }).finally(function () {
      if (!localActionRef.current || localActionRef.current.id !== localActionId) return;
      localActionRef.current = null;
      setRunningAction('');
      setProgress(null);
    });
  }

  useEffect(function () {
    loadTarget();
  }, []);

  useEffect(function () {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
      return undefined;
    }
    function onMessage(message, sender) {
      if (!message || message.source !== FEISHU_EXTENSION_PROGRESS) return;
      if (!sender || !sender.tab || sender.tab.id !== target.tabId) return;
      const requestId = String(message.requestId || '');
      if (!requestId) return;
      if (message.state === 'start') progressRequestIdRef.current = requestId;
      else if (progressRequestIdRef.current && progressRequestIdRef.current !== requestId) return;
      else if (!progressRequestIdRef.current) progressRequestIdRef.current = requestId;

      // 动作完成：清理进度与运行态。若该动作是在别处（关闭 popup 期间）跑完的，
      // 这里补一条完成提示。
      if (message.state === 'done') {
        progressRequestIdRef.current = '';
        setProgress(null);
        const localAction = localActionRef.current;
        if (localAction && localAction.action === message.action) return;
        setRunningAction(function (current) {
          if (current && current === message.action) {
            const ok = String(message.status || 'success') !== 'error';
            const detail = String(ok ? (message.notice || '') : (message.error || message.notice || '')).trim();
            setStatus({
              type: ok ? 'success' : 'error',
              text: detail || (ok
                ? getActionTitle(message.action) + '已完成。'
                : getActionTitle(message.action) + '执行失败。'),
            });
          }
          return current === message.action ? '' : current;
        });
        return;
      }

      if (message.action) {
        setRunningAction(function (current) { return current || message.action; });
      }
      const total = Number(message.total || 0);
      const done = Number(message.done || 0);
      if (message.state === 'start') return;
      if (total <= 0) {
        const label = String(message.label || '').trim();
        if (label) setStatus({ type: 'info', text: label + '…' });
        return;
      }
      const percent = total > 0 ? (done / total) * 100 : 0;
      setProgress({
        phase: String(message.phase || ''),
        label: String(message.label || '处理中'),
        done: done,
        total: total,
        percent: percent,
      });
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return function () { chrome.runtime.onMessage.removeListener(onMessage); };
  }, [target.tabId]);

  // popup 重开时，从后台恢复该标签页正在进行的进度。
  useEffect(function () {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }
    getActiveTab().then(function (tab) {
      if (!tab || !tab.id) return;
      chrome.runtime.sendMessage({ source: FEISHU_EXTENSION_PROGRESS_QUERY, tabId: tab.id }, function (response) {
        if (chrome.runtime.lastError) return;
        const record = response && response.progress;
        if (!record || record.state === 'done' || !record.action) return;
        const total = Number(record.total || 0);
        const done = Number(record.done || 0);
        setRunningAction(record.action);
        progressRequestIdRef.current = String(record.requestId || '');
        const label = String(record.label || '').trim();
        setStatus({
          type: 'info',
          text: total <= 0 && label ? label + '…' : '正在执行：' + getActionTitle(record.action),
        });
        if (total <= 0) return;
        setProgress({
          phase: String(record.phase || ''),
          label: String(record.label || '处理中'),
          done: done,
          total: total,
          percent: total > 0 ? (done / total) * 100 : 0,
        });
      });
    }).catch(function () {});
  }, []);

  const overviewLoading = target.loading || overview.state === 'loading';
  const actionDisabled = Boolean(runningAction) || overviewLoading
    || (!target.supported && !target.loading);
  const connectionVariant = !target.supported && !target.loading
    ? 'warning'
    : overviewLoading ? 'processing' : overview.state === 'ready' ? 'success' : 'warning';
  const connectionText = !target.supported && !target.loading
    ? '不支持'
    : overviewLoading ? '快照中' : overview.state === 'ready' ? '可操作' : '待重试';
  const metricItems = overview.summary ? [
    { key: 'blocks', label: '文档块', value: overview.summary.blockCount },
    { key: 'equations', label: '公式', value: overview.summary.equationCount },
    { key: 'images', label: '图片', value: overview.summary.imageCount },
    { key: 'whiteboards', label: '画板', value: overview.summary.whiteboardCount },
  ] : [];

  return (
    <main className="popup">
      <header className="popup__header">
        <div className="brand">
          <h1>飞书文档助手</h1>
          <StatusTag variant={connectionVariant}>{connectionText}</StatusTag>
        </div>
      </header>

      <section className="doc-card" aria-label="当前文档概览">
        <div className="doc-card__head">
          <span className="doc-card__label">
            <svg className="doc-card__label-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
            当前文档
          </span>
          <span className="doc-card__title" title={target.title}>
            {target.loading ? '读取中…' : target.title}
          </span>
        </div>
        <div className="doc-card__stats" role="group" aria-label="最近一次提取概览">
          {overviewLoading ? (
            <div className="doc-card__stats-state doc-card__stats-state--loading" role="status">
              <span className="doc-card__stats-spinner" aria-hidden="true" />
              快照提取中…
            </div>
          ) : overview.state === 'error' ? (
            <div className="doc-card__stats-state" role="status" title={overview.error}>
              快照提取失败，请稍后重试
            </div>
          ) : metricItems.map(function (item) {
            return (
              <div className="statistic" key={item.key}>
                <span className="statistic__value">{item.value}</span>
                <span className="statistic__label">{item.label}</span>
              </div>
            );
          })}
        </div>
      </section>

      {!target.supported && !target.loading ? (
        <AlertBox
          type="warning"
          title="当前不是飞书文档"
          text="请打开 feishu.cn、larksuite.com 或 larkoffice.com 文档页后再运行。"
        />
      ) : null}

      <section className="actions" aria-label="可用操作">
        <div className="action-grid">
          {ACTIONS.map(function (item) {
            const isRunning = runningAction === item.key;
            return (
              <button
                className="ant-btn ant-btn--default"
                key={item.key}
                type="button"
                disabled={actionDisabled}
                onClick={function () {
                  if (item.key === 'snapshot') refreshSnapshot();
                  else run(item.key);
                }}
                title={item.description}
              >
                <span className="ant-btn__icon">{item.icon}</span>
                <span className="ant-btn__label">{isRunning ? '处理中…' : item.title}</span>
              </button>
            );
          })}
        </div>
      </section>

      {runningAction && progress ? (
        <ProgressBar
          percent={progress.percent}
          label={progress.label || getActionTitle(runningAction)}
          done={progress.done}
          total={progress.total}
        />
      ) : null}

      {status.type !== 'info' || lastResult ? (
        <AlertBox
          type={status.type}
          title={lastResult ? getActionTitle(lastResult.action) : '进行中'}
          text={status.text}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Panel />);
