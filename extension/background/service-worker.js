importScripts('../shared/protocol.js');

var protocol = globalThis.FeishuExtensionProtocol;
if (!protocol) throw new Error('Feishu extension protocol failed to load');

var SOURCE = protocol.MESSAGES.UI;
var PROGRESS_MESSAGE = protocol.MESSAGES.PROGRESS;
var PROGRESS_QUERY = protocol.MESSAGES.PROGRESS_QUERY;
var IMAGE_FETCH = protocol.MESSAGES.IMAGE_FETCH;
var PENDING_PASTE = protocol.MESSAGES.PENDING_PASTE;
var STORAGE_PREFIX = 'feishu-progress:';
var PENDING_PASTE_KEY = 'feishu-pending-paste';
var PENDING_PASTE_CLEANUP_ALARM = 'feishu-pending-paste-cleanup';

var MENU_ITEMS = [
  { id: 'extract', title: '提取当前文档' },
  { id: 'paste', title: '粘贴文档副本' },
  { id: 'snapshot', title: '刷新页面快照' },
  { id: 'images', title: '打开图片面板' },
];

function sendActionToTab(tabId, action) {
  if (!tabId || !protocol.isUiAction(action)) return;
  try {
    var result = chrome.tabs.sendMessage(tabId, { source: SOURCE, action: action });
    if (result && typeof result.catch === 'function') result.catch(function () {});
  } catch (error) {}
}

function sendActionToActiveTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (tab && protocol.isSupportedDocumentUrl(tab.url)) sendActionToTab(tab.id, action);
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

function isPendingPasteExpired(value) {
  var timestamp = Number(value && value.ts);
  return !Number.isFinite(timestamp) || timestamp <= 0
    || Date.now() - timestamp >= protocol.LIMITS.PENDING_TTL_MS;
}

function schedulePendingPasteCleanup(value) {
  if (!(chrome.alarms && chrome.alarms.create)) return;
  var timestamp = Number(value && value.ts);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  chrome.alarms.create(PENDING_PASTE_CLEANUP_ALARM, {
    when: Math.max(Date.now() + 1000, timestamp + protocol.LIMITS.PENDING_TTL_MS),
  });
}

function clearPendingPasteCleanupAlarm() {
  if (chrome.alarms && chrome.alarms.clear) chrome.alarms.clear(PENDING_PASTE_CLEANUP_ALARM);
}

function cleanupExpiredPendingPaste() {
  var area = getLocalArea();
  if (!area) return;
  area.get(PENDING_PASTE_KEY, function (items) {
    if (chrome.runtime.lastError) return;
    var value = (items && items[PENDING_PASTE_KEY]) || null;
    if (!value) { clearPendingPasteCleanupAlarm(); return; }
    if (isPendingPasteExpired(value) || !protocol.validatePendingPayload(value).ok) {
      area.remove(PENDING_PASTE_KEY);
      clearPendingPasteCleanupAlarm();
    } else {
      schedulePendingPasteCleanup(value);
    }
  });
}

function sendError(sendResponse, message) {
  sendResponse({ ok: false, error: String(message || 'request rejected') });
}

function getTrustedDocumentSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab
    || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) {
    return null;
  }
  var senderUrl = String(sender.url || '');
  var tabUrl = String(sender.tab.url || '');
  if (!protocol.isSupportedDocumentUrl(senderUrl) || !protocol.isSupportedDocumentUrl(tabUrl)) {
    return null;
  }
  return { tabId: sender.tab.id, url: senderUrl };
}

function validateProgressMessage(message) {
  var state = String(message.state || '');
  return /^(start|progress|done)$/.test(state)
    && protocol.validateRequestId(message.requestId)
    && protocol.isUiAction(message.action);
}

function readBlobAsDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onloadend = function () {
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('image conversion failed'));
    };
    reader.onerror = function () { reject(new Error('image conversion failed')); };
    reader.readAsDataURL(blob);
  });
}

function validateImageResponse(response, documentUrl) {
  if (!response || !response.ok) {
    throw new Error('image request failed with HTTP ' + Number((response && response.status) || 0));
  }
  var finalUrl = protocol.validateImageUrl(response.url, documentUrl);
  if (!finalUrl.ok) throw new Error('image redirect rejected: ' + finalUrl.error);

  var mime = protocol.normalizeImageMime(response.headers.get('content-type'));
  if (!protocol.isAllowedImageMime(mime)) throw new Error('response is not an approved image MIME');

  var contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    var contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0
      || contentLength > protocol.LIMITS.MAX_IMAGE_BYTES) {
      throw new Error('image response exceeds size limit');
    }
  }
  return { response: response, finalUrl: finalUrl, mime: mime };
}

function readValidatedImageResponse(validated) {
  return validated.response.blob().then(function (blob) {
    if (!blob || blob.size > protocol.LIMITS.MAX_IMAGE_BYTES) {
      throw new Error('image response exceeds size limit');
    }
    if (blob.type && !protocol.isAllowedImageMime(blob.type)) {
      throw new Error('decoded response is not an approved image MIME');
    }
    return readBlobAsDataUrl(blob);
  });
}

function fetchImageDataUrl(initialValidation, documentUrl) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, protocol.LIMITS.FETCH_TIMEOUT_MS);
  var options = {
    cache: 'no-store',
    credentials: initialValidation.credentials,
    redirect: 'follow',
    signal: controller.signal,
  };

  return fetch(initialValidation.url, options).then(function (response) {
    var validated = validateImageResponse(response, documentUrl);
    if (validated.finalUrl.credentials === initialValidation.credentials) {
      return readValidatedImageResponse(validated);
    }

    // A same-origin API may redirect to a CDN. Re-fetch the validated final URL
    // without credentials so CDN responses never depend on ambient cookies.
    return fetch(validated.finalUrl.url, {
      cache: 'no-store',
      credentials: validated.finalUrl.credentials,
      redirect: 'error',
      signal: controller.signal,
    }).then(function (finalResponse) {
      return readValidatedImageResponse(validateImageResponse(finalResponse, documentUrl));
    });
  }).catch(function (error) {
    if (error && error.name === 'AbortError') throw new Error('image request timed out');
    throw error;
  }).finally(function () {
    clearTimeout(timer);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false;

  if (message.source === PENDING_PASTE) {
    var pendingSender = getTrustedDocumentSender(sender);
    var pendingOp = String(message.op || '');
    var pendingAction = String(message.action || '');
    if (!pendingSender) { sendError(sendResponse, 'untrusted document sender'); return false; }
    if (!protocol.validateRequestId(message.actionRequestId)) {
      sendError(sendResponse, 'invalid action request');
      return false;
    }
    if (!protocol.isPendingOp(pendingOp) || !protocol.isPendingOpAllowed(pendingAction, pendingOp)) {
      sendError(sendResponse, 'pending operation is not allowed for this action');
      return false;
    }
    var localArea = getLocalArea();
    if (!localArea) { sendError(sendResponse, 'storage unavailable'); return false; }
    if (pendingOp === protocol.PENDING_OPS.GET) {
      localArea.get(PENDING_PASTE_KEY, function (items) {
        var err = chrome.runtime.lastError;
        if (err) { sendError(sendResponse, err.message); return; }
        var value = (items && items[PENDING_PASTE_KEY]) || null;
        if (value && isPendingPasteExpired(value)) {
          localArea.remove(PENDING_PASTE_KEY);
          clearPendingPasteCleanupAlarm();
          sendResponse({ ok: true, value: null });
          return;
        }
        if (value) {
          var storedValidation = protocol.validatePendingPayload(value);
          if (!storedValidation.ok) {
            localArea.remove(PENDING_PASTE_KEY);
            sendError(sendResponse, storedValidation.error);
            return;
          }
        }
        sendResponse({ ok: true, value: value });
      });
      return true;
    }
    if (pendingOp === protocol.PENDING_OPS.SET) {
      var pendingValidation = protocol.validatePendingPayload(message.value);
      if (!pendingValidation.ok) { sendError(sendResponse, pendingValidation.error); return false; }
      var data = {};
      data[PENDING_PASTE_KEY] = message.value;
      localArea.set(data, function () {
        var err = chrome.runtime.lastError;
        if (!err) schedulePendingPasteCleanup(message.value);
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      });
      return true;
    }
    if (pendingOp === protocol.PENDING_OPS.DELETE) {
      localArea.remove(PENDING_PASTE_KEY, function () {
        var err = chrome.runtime.lastError;
        if (!err) clearPendingPasteCleanupAlarm();
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      });
      return true;
    }
    sendError(sendResponse, 'unsupported operation');
    return false;
  }

  // 后台跨域抓取图片字节（拥有 host_permissions，不受页面 CORS 限制），
  // 模拟浏览器原生"复制图片"，把结果以 data URL 回传给内容脚本写剪贴板。
  if (message.source === IMAGE_FETCH) {
    var imageSender = getTrustedDocumentSender(sender);
    if (!imageSender) { sendError(sendResponse, 'untrusted document sender'); return false; }
    var imageValidation = protocol.validateImageUrl(message.url, imageSender.url);
    if (!imageValidation.ok) { sendError(sendResponse, imageValidation.error); return false; }
    fetchImageDataUrl(imageValidation, imageSender.url)
      .then(function (dataUrl) { sendResponse({ ok: true, dataUrl: dataUrl }); })
      .catch(function (error) { sendResponse({ ok: false, error: String(error && error.message || error) }); });
    return true;
  }

  // popup 重开时查询该标签页当前进度。
  if (message.source === PROGRESS_QUERY) {
    var queryTabId = Number(message.tabId || 0);
    if (!sender || sender.id !== chrome.runtime.id || !Number.isInteger(queryTabId) || queryTabId <= 0) {
      sendResponse({ progress: null });
      return false;
    }
    chrome.tabs.get(queryTabId, function (tab) {
      if (chrome.runtime.lastError || !tab || !protocol.isSupportedDocumentUrl(tab.url)) {
        sendResponse({ progress: null });
        return;
      }
      readProgress(queryTabId, function (record) {
        sendResponse({ progress: record || null });
      });
    });
    return true;
  }

  // 来自 bridge 的进度生命周期广播：落盘以便重开恢复。
  if (message.source === PROGRESS_MESSAGE) {
    var progressSender = getTrustedDocumentSender(sender);
    if (progressSender && validateProgressMessage(message)) {
      var tabId = progressSender.tabId;
      if (message.state === 'done') {
        readProgress(tabId, function (record) {
          if (!record || record.requestId === String(message.requestId)) clearProgress(tabId);
        });
      } else {
        saveProgress(tabId, {
          state: String(message.state || 'progress'),
          requestId: String(message.requestId || ''),
          action: String(message.action || ''),
          phase: protocol.normalizeProgressLabel(message.phase),
          done: protocol.normalizeProgressNumber(message.done),
          total: protocol.normalizeProgressNumber(message.total),
          label: protocol.normalizeProgressLabel(message.label),
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

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === PENDING_PASTE_CLEANUP_ALARM) cleanupExpiredPendingPaste();
});

chrome.runtime.onStartup.addListener(cleanupExpiredPendingPaste);

chrome.runtime.onInstalled.addListener(function () {
  cleanupExpiredPendingPaste();
  chrome.contextMenus.removeAll(function () {
    MENU_ITEMS.forEach(function (item) {
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: ['page', 'selection', 'image'],
        documentUrlPatterns: protocol.buildDocumentMatchPatterns(),
      });
    });
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (tab && protocol.isSupportedDocumentUrl(tab.url)) sendActionToTab(tab.id, info.menuItemId);
});

chrome.commands.onCommand.addListener(function (command, tab) {
  var map = {
    'feishu-extract': 'extract',
    'feishu-paste': 'paste',
    'feishu-snapshot': 'snapshot',
  };
  if (tab && tab.id && protocol.isSupportedDocumentUrl(tab.url)) sendActionToTab(tab.id, map[command]);
  else sendActionToActiveTab(map[command]);
});
