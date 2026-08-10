importScripts('../shared/protocol.js');

var protocol = globalThis.FeishuExtensionProtocol;
if (!protocol) throw new Error('Feishu extension protocol failed to load');

var SOURCE = protocol.MESSAGES.UI;
var PROGRESS_MESSAGE = protocol.MESSAGES.PROGRESS;
var PROGRESS_QUERY = protocol.MESSAGES.PROGRESS_QUERY;
var IMAGE_FETCH = protocol.MESSAGES.IMAGE_FETCH;
var CLIPBOARD_WRITE = protocol.MESSAGES.CLIPBOARD_WRITE;
var PENDING_PASTE = protocol.MESSAGES.PENDING_PASTE;
var STORAGE_PREFIX = 'feishu-progress:';
var PENDING_PASTE_KEY = 'feishu-pending-paste';
var PENDING_PASTE_CLEANUP_ALARM = 'feishu-pending-paste-cleanup';
var pendingWriteQueue = Promise.resolve();

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

function describeNativeMessagingError(error) {
  var message = String(error && error.message || error || '未知错误');
  if (/native messaging host not found|specified native messaging host not found/i.test(message)) {
    return '未找到画板迁移 Host。请先运行 npm run install:native-host，'
      + '然后完全退出并重新打开 Chrome / Chrome Canary 后重试。';
  }
  return '无法连接画板迁移 Host：' + message;
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
  return !protocol.isPendingFresh(value, Date.now());
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

function createTrustedPendingId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'pending_' + globalThis.crypto.randomUUID().replace(/-/g, '');
  }
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    var bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return 'pending_' + Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }
  return '';
}

function normalizePendingForStorage(value, senderInfo) {
  var normalized;
  try { normalized = JSON.parse(JSON.stringify(value)); }
  catch (error) { return null; }
  var pendingId = createTrustedPendingId();
  if (!pendingId) return null;
  var senderUrl;
  try { senderUrl = new URL(senderInfo.url); }
  catch (error) { return null; }
  normalized.schemaVersion = 2;
  normalized.pendingId = pendingId;
  normalized.ts = Date.now();
  normalized.savedFromHost = senderUrl.host;
  normalized.savedFromHref = senderUrl.href;
  return normalized;
}

function queuePendingPasteWrite(area, value) {
  var operation = pendingWriteQueue.catch(function () {}).then(function () {
    return new Promise(function (resolve, reject) {
      var data = {};
      data[PENDING_PASTE_KEY] = value;
      area.set(data, function () {
        var error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  });
  pendingWriteQueue = operation;
  return operation;
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
  if (!protocol.isAllowedImageMime(mime) && mime !== 'application/octet-stream') {
    throw new Error('response is not an approved image MIME');
  }

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
  return validated.response.arrayBuffer().then(function (buffer) {
    if (!buffer || buffer.byteLength > protocol.LIMITS.MAX_IMAGE_BYTES) {
      throw new Error('image response exceeds size limit');
    }
    var detectedMime = protocol.detectImageMime(new Uint8Array(buffer));
    if (!detectedMime || !protocol.isAllowedImageMime(detectedMime)) {
      throw new Error('response bytes are not an approved image format');
    }
    return readBlobAsDataUrl(new Blob([buffer], { type: detectedMime }));
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

function writeImageClipboardFocusedContext(imageDataUrl) {
  return chrome.runtime.sendMessage({
    source: protocol.MESSAGES.CLIPBOARD_WRITE_TARGET,
    imageDataUrl: imageDataUrl,
  }).then(function (response) {
    if (!response || !response.ok || !response.written) {
      throw new Error(String(response && response.error || '扩展弹窗未接管图片剪贴板'));
    }
    return response;
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false;

  if (message.source === protocol.NATIVE_MESSAGING.REQUEST_TYPE) {
    var nativeSender = getTrustedDocumentSender(sender);
    var nativeInput = message.request || {};
    if (!nativeSender) { sendError(sendResponse, 'untrusted document sender'); return false; }
    if (!protocol.validateRequestId(message.actionRequestId)) {
      sendError(sendResponse, 'invalid action request');
      return false;
    }
    var nativeRequest = {
      type: protocol.NATIVE_MESSAGING.REQUEST_TYPE,
      host: protocol.NATIVE_MESSAGING.HOST_NAME,
      op: String(nativeInput.op || ''),
      action: String(nativeInput.action || ''),
    };
    if (nativeRequest.op === protocol.NATIVE_MESSAGING.OPS.INSPECT
      || nativeRequest.op === protocol.NATIVE_MESSAGING.OPS.EXPORT) {
      nativeRequest.sourceUrl = nativeSender.url;
    }
    if (nativeRequest.op === protocol.NATIVE_MESSAGING.OPS.PREFLIGHT
      || nativeRequest.op === protocol.NATIVE_MESSAGING.OPS.APPLY) {
      nativeRequest.bundleId = String(nativeInput.bundleId || '');
      nativeRequest.targetUrl = nativeSender.url;
    }
    if (nativeRequest.op === protocol.NATIVE_MESSAGING.OPS.RECONCILE_IMAGES) {
      nativeRequest.targetUrl = nativeSender.url;
      nativeRequest.images = Array.isArray(nativeInput.images) ? nativeInput.images : [];
    }
    if (nativeRequest.op === protocol.NATIVE_MESSAGING.OPS.DISCARD) {
      nativeRequest.bundleId = String(nativeInput.bundleId || '');
    }
    var nativeValidation = protocol.validateNativeMessagingRequest(nativeRequest);
    if (!nativeValidation.ok) { sendError(sendResponse, nativeValidation.error); return false; }
    try {
      chrome.runtime.sendNativeMessage(protocol.NATIVE_MESSAGING.HOST_NAME, nativeRequest, function (response) {
        var nativeError = chrome.runtime.lastError;
        if (nativeError) {
          sendError(sendResponse, describeNativeMessagingError(nativeError));
          return;
        }
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
          sendError(sendResponse, '画板迁移 Host 返回了无效响应');
          return;
        }
        sendResponse(response);
      });
    } catch (error) {
      sendError(sendResponse, String(error && error.message || error));
      return false;
    }
    return true;
  }

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
      var normalizedPending = normalizePendingForStorage(message.value, pendingSender);
      if (!normalizedPending) { sendError(sendResponse, 'failed to create trusted pending envelope'); return false; }
      var normalizedValidation = protocol.validatePendingPayload(normalizedPending);
      if (!normalizedValidation.ok) { sendError(sendResponse, normalizedValidation.error); return false; }
      queuePendingPasteWrite(localArea, normalizedPending).then(function () {
        schedulePendingPasteCleanup(normalizedPending);
        sendResponse({ ok: true, value: normalizedPending });
      }).catch(function (error) {
        sendError(sendResponse, error.message);
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

  if (message.source === CLIPBOARD_WRITE) {
    var clipboardSender = getTrustedDocumentSender(sender);
    if (!clipboardSender) { sendError(sendResponse, 'untrusted document sender'); return false; }
    if (!protocol.validateRequestId(message.actionRequestId)) {
      sendError(sendResponse, 'invalid action request');
      return false;
    }
    var clipboardValidation = protocol.validateClipboardBridgePayload({
      imageDataUrl: String(message.imageDataUrl || ''),
      pasteAfterWrite: false,
    });
    if (!clipboardValidation.ok) { sendError(sendResponse, clipboardValidation.error); return false; }
    writeImageClipboardFocusedContext(String(message.imageDataUrl || ''))
      .then(function () { sendResponse({ ok: true, written: true }); })
      .catch(function (error) { sendError(sendResponse, error && error.message || error); });
    return true;
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

// 标签页关闭、刷新或导航离开时清理残留进度。
chrome.tabs.onRemoved.addListener(function (tabId) { clearProgress(tabId); });
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo && (changeInfo.status === 'loading' || changeInfo.url)) clearProgress(tabId);
});

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
