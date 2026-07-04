import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './popup.css';

const FEISHU_EXTENSION_UI = 'FEISHU_EXTENSION_UI';
const FEISHU_EXTENSION_PROGRESS = 'FEISHU_EXTENSION_PROGRESS';
const FEISHU_EXTENSION_PROGRESS_QUERY = 'FEISHU_EXTENSION_PROGRESS_QUERY';

const ACTIONS = [
  {
    key: 'extract',
    title: '提取文档',
    description: '读取源文档结构，写入扩展共享缓存',
    primary: true,
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
    primary: false,
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
    primary: false,
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
    primary: false,
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
  return /^https:\/\/[^/]+\.(feishu\.cn|larksuite\.com|larkoffice\.com)\//i.test(String(url || ''));
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
    if (!tab || !tab.id) throw new Error('没有找到当前标签页。');
    if (tab.url && !isFeishuUrl(tab.url)) throw new Error('当前标签页不是飞书/Lark 文档。');
    return chrome.tabs.sendMessage(tab.id, {
      source: FEISHU_EXTENSION_UI,
      action: action,
    }).catch(function (error) {
      const message = String(error && error.message ? error.message : error);
      if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
        throw new Error('扩展刚安装或更新，当前页面还未加载脚本。请刷新此飞书文档页面后重试。');
      }
      throw error;
    });
  });
}

function normalizeSummary(summary) {
  return {
    blockCount: Number((summary && summary.blockCount) || 0),
    equationCount: Number((summary && summary.equationCount) || 0),
    imageCount: Number((summary && summary.imageCount) || 0),
  };
}

function summarizeResult(action, result) {
  if (!result || result.status === 'error') {
    return (result && result.error) || '页面脚本没有返回结果。';
  }
  const summary = normalizeSummary(result.summary);
  if (action === 'extract') {
    return '已提取 ' + summary.blockCount + ' 文档块 · '
      + summary.equationCount + ' 公式 · '
      + summary.imageCount + ' 图片';
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
    loading: true,
    title: '正在读取当前标签页',
    host: '读取中',
    url: '',
    supported: false,
    error: '',
  });
  const [metrics, setMetrics] = useState(normalizeSummary());
  const [lastResult, setLastResult] = useState(null);
  const [progress, setProgress] = useState(null);

  function scanMetrics() {
    sendFeishuAction('scan').then(function (result) {
      if (result && result.status !== 'error' && result.summary) {
        setMetrics(normalizeSummary(result.summary));
      }
    }).catch(function () {
      // 静默：页面未就绪或连接暂不可用时不打扰用户
    });
  }

  function refreshTarget() {
    setTarget(function (previous) {
      return Object.assign({}, previous, { loading: true, error: '' });
    });
    getActiveTab().then(function (tab) {
      if (!tab) throw new Error('没有找到当前标签页。');
      const parsed = parseTab(tab);
      setTarget(parsed);
      if (parsed.supported) scanMetrics();
    }).catch(function (error) {
      setTarget({
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
    setRunningAction(action);
    setProgress(null);
    setStatus({ type: 'info', text: '正在执行：' + getActionTitle(action) });
    sendFeishuAction(action).then(function (result) {
      const isError = result && result.status === 'error';
      const notice = result && result.notice ? String(result.notice).replace(/^[⏳✅⚠️📋📷❌]+\s*/, '').trim() : '';
      const text = isError ? (notice || summarizeResult(action, result)) : summarizeResult(action, result);
      const summary = normalizeSummary(result && result.summary);

      if (!isError && result && result.summary) setMetrics(summary);
      setStatus({ type: isError ? 'error' : 'success', text: text });
      setLastResult({
        action: action,
        type: isError ? 'error' : 'success',
        text: text,
        summary: summary,
      });
    }).catch(function (error) {
      const text = String(error && error.message ? error.message : error);
      setStatus({ type: 'error', text: text });
      setLastResult({
        action: action,
        type: 'error',
        text: text,
        summary: normalizeSummary(),
      });
    }).finally(function () {
      setRunningAction('');
      setProgress(null);
      refreshTarget();
    });
  }

  useEffect(function () {
    refreshTarget();
  }, []);

  useEffect(function () {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
      return undefined;
    }
    function onMessage(message) {
      if (!message || message.source !== FEISHU_EXTENSION_PROGRESS) return;

      // 动作完成：清理进度与运行态。若该动作是在别处（关闭 popup 期间）跑完的，
      // 这里补一条完成提示。
      if (message.state === 'done') {
        setProgress(null);
        setRunningAction(function (current) {
          if (current && current === message.action) {
            const ok = String(message.status || 'success') !== 'error';
            setStatus({
              type: ok ? 'success' : 'error',
              text: ok ? getActionTitle(message.action) + '已完成。' : getActionTitle(message.action) + '执行失败。',
            });
            refreshTarget();
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
  }, []);

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
        setStatus({ type: 'info', text: '正在执行：' + getActionTitle(record.action) });
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

  const actionDisabled = Boolean(runningAction) || (!target.supported && !target.loading);
  const connectionVariant = target.supported ? 'success' : target.loading ? 'processing' : 'warning';
  const connectionText = target.supported ? '可操作' : target.loading ? '检测中' : '不支持';
  const metricItems = [
    { key: 'blocks', label: '文档块', value: metrics.blockCount },
    { key: 'equations', label: '公式', value: metrics.equationCount },
    { key: 'images', label: '图片', value: metrics.imageCount },
  ];

  return (
    <main className="popup">
      <header className="popup__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2h6.6a2 2 0 0 1 1.42.59l3.9 3.9A2 2 0 0 1 20 7.9V19.5A2.5 2.5 0 0 1 17.5 22h-10A2.5 2.5 0 0 1 5 19.5z" fill="currentColor" opacity="0.14" />
              <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2h6.6a2 2 0 0 1 1.42.59l3.9 3.9A2 2 0 0 1 20 7.9V19.5A2.5 2.5 0 0 1 17.5 22h-10A2.5 2.5 0 0 1 5 19.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M14 2.5V6a2 2 0 0 0 2 2h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="m12.4 11-1.2 3h2.6l-1.8 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
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
          {metricItems.map(function (item) {
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
                disabled={actionDisabled && !isRunning}
                onClick={function () { run(item.key); }}
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
