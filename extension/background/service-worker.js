var SOURCE = 'FEISHU_EXTENSION_UI';
var PROGRESS_MESSAGE = 'FEISHU_EXTENSION_PROGRESS';
var PROGRESS_QUERY = 'FEISHU_EXTENSION_PROGRESS_QUERY';
var IMAGE_FETCH = 'FEISHU_EXTENSION_IMAGE_FETCH';
var PENDING_PASTE = 'FEISHU_EXTENSION_PENDING_PASTE';
var STORAGE_PREFIX = 'feishu-progress:';
var PENDING_PASTE_KEY = 'feishu-pending-paste';

var MENU_ITEMS = [
  { id: 'extract', title: '提取当前文档' },
  { id: 'paste', title: '粘贴文档副本' },
  { id: 'snapshot', title: '刷新页面快照' },
  { id: 'images', title: '打开图片面板' },
];

function sendActionToTab(tabId, action) {
  if (!tabId) return;
  try {
    var result = chrome.tabs.sendMessage(tabId, { source: SOURCE, action: action });
    if (result && typeof result.catch === 'function') result.catch(function () {});
  } catch (error) {}
}

function sendActionToActiveTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    sendActionToTab(tab && tab.id, action);
  });
}

// ── Progress persistence ─────────────────────────────────────────────────────
// popup 关闭后其 React 状态与监听器都会销毁；后台任务仍在页面里跑。这里把每个
// 标签页最近一次动作的进度存进 chrome.storage.session，popup 重开时可回查恢复。

function storageKey(tabId) {
  return STORAGE_PREFIX + String(tabId);
}

function getSessionArea() {
  if (chrome.storage && chrome.storage.session) return chrome.storage.session;
  return chrome.storage && chrome.storage.local ? chrome.storage.local : null;
}

function saveProgress(tabId, record) {
  var area = getSessionArea();
  if (!area || !tabId) return;
  var data = {};
  data[storageKey(tabId)] = record;
  try { area.set(data); } catch (error) {}
}

function clearProgress(tabId) {
  var area = getSessionArea();
  if (!area || !tabId) return;
  try { area.remove(storageKey(tabId)); } catch (error) {}
}

function readProgress(tabId, callback) {
  var area = getSessionArea();
  if (!area || !tabId) { callback(null); return; }
  try {
    area.get(storageKey(tabId), function (items) {
      callback((items && items[storageKey(tabId)]) || null);
    });
  } catch (error) {
    callback(null);
  }
}

function getLocalArea() {
  return chrome.storage && chrome.storage.local ? chrome.storage.local : null;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false;

  if (message.source === PENDING_PASTE) {
    var localArea = getLocalArea();
    if (!localArea) { sendResponse({ ok: false, error: 'storage unavailable' }); return false; }
    if (message.op === 'get') {
      localArea.get(PENDING_PASTE_KEY, function (items) {
        var err = chrome.runtime.lastError;
        if (err) { sendResponse({ ok: false, error: err.message }); return; }
        sendResponse({ ok: true, value: (items && items[PENDING_PASTE_KEY]) || null });
      });
      return true;
    }
    if (message.op === 'set') {
      var data = {};
      data[PENDING_PASTE_KEY] = message.value || null;
      localArea.set(data, function () {
        var err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      });
      return true;
    }
    if (message.op === 'delete') {
      localArea.remove(PENDING_PASTE_KEY, function () {
        var err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      });
      return true;
    }
    sendResponse({ ok: false, error: 'unsupported op' });
    return false;
  }

  // 后台跨域抓取图片字节（拥有 host_permissions，不受页面 CORS 限制），
  // 模拟浏览器原生"复制图片"，把结果以 data URL 回传给内容脚本写剪贴板。
  if (message.source === IMAGE_FETCH) {
    var imageUrl = String(message.url || '');
    if (!imageUrl) { sendResponse({ ok: false, error: 'empty url' }); return true; }
    fetch(imageUrl, { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onloadend = function () { resolve(reader.result); };
          reader.onerror = function () { reject(new Error('read failed')); };
          reader.readAsDataURL(blob);
        });
      })
      .then(function (dataUrl) { sendResponse({ ok: true, dataUrl: dataUrl }); })
      .catch(function (error) { sendResponse({ ok: false, error: String(error && error.message || error) }); });
    return true;
  }

  // popup 重开时查询该标签页当前进度。
  if (message.source === PROGRESS_QUERY) {
    var queryTabId = message.tabId || (sender && sender.tab && sender.tab.id);
    readProgress(queryTabId, function (record) {
      sendResponse({ progress: record || null });
    });
    return true;
  }

  // 来自 bridge 的进度生命周期广播：落盘以便重开恢复。
  if (message.source === PROGRESS_MESSAGE) {
    var tabId = sender && sender.tab && sender.tab.id;
    if (tabId) {
      if (message.state === 'done') {
        clearProgress(tabId);
      } else {
        saveProgress(tabId, {
          state: String(message.state || 'progress'),
          requestId: String(message.requestId || ''),
          action: String(message.action || ''),
          phase: String(message.phase || ''),
          done: Number(message.done || 0),
          total: Number(message.total || 0),
          label: String(message.label || ''),
          updatedAt: Date.now(),
        });
      }
    }
    return false;
  }

  return false;
});

// 标签页关闭 / 导航离开时清理残留进度。
chrome.tabs.onRemoved.addListener(function (tabId) { clearProgress(tabId); });

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    MENU_ITEMS.forEach(function (item) {
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: ['page', 'selection', 'image'],
        documentUrlPatterns: [
          'https://*.feishu.cn/*',
          'https://*.larksuite.com/*',
          'https://*.larkoffice.com/*',
        ],
      });
    });
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  sendActionToTab(tab && tab.id, info.menuItemId);
});

chrome.commands.onCommand.addListener(function (command, tab) {
  var map = {
    'feishu-extract': 'extract',
    'feishu-paste': 'paste',
    'feishu-snapshot': 'snapshot',
  };
  if (tab && tab.id) sendActionToTab(tab.id, map[command]);
  else sendActionToActiveTab(map[command]);
});
