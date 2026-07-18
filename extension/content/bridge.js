(function () {
  'use strict';

  var protocol = globalThis.FeishuExtensionProtocol;
  if (!protocol) {
    console.error('[Feishu Helper] shared extension protocol is unavailable');
    return;
  }

  var SOURCE = protocol.MESSAGES.UI;
  var UI_RESULT_EVENT = protocol.DOM_EVENTS.UI_RESULT;
  var UI_PROGRESS_EVENT = protocol.DOM_EVENTS.UI_PROGRESS;
  var PROGRESS_MESSAGE = protocol.MESSAGES.PROGRESS;
  var PENDING_PASTE_MESSAGE = protocol.MESSAGES.PENDING_PASTE;

  // 当前进行中的动作 requestId / 名称，用于把页面进度事件关联到本次操作。
  var activeRequestId = '';
  var activeAction = '';
  var lastImageContextGesture = null;

  function broadcastProgress(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ source: PROGRESS_MESSAGE }, payload));
    } catch (err) {}
  }

  function extractUrlFromBackgroundImage(backgroundImage) {
    var value = String(backgroundImage || '');
    var match = value.match(/url\((['"]?)(.*?)\1\)/i);
    return match ? String(match[2] || '').trim() : '';
  }

  function pushApprovedImageCandidate(result, value) {
    var validation = protocol.validateImageUrl(value, location.href);
    if (!validation.ok || result.indexOf(validation.url) !== -1) return;
    result.push(validation.url);
  }

  function getApprovedImageCandidates(target) {
    var result = [];
    if (!target || target.nodeType !== 1 || typeof target.closest !== 'function') return result;

    var img = target.closest('img');
    if (!img) {
      var block = target.closest(
        '[data-block-type="image"], [data-page-block-type="image"], '
        + '.block-image, .image-block, [class*="ImageBlock"], [class*="image-block"], '
        + '[class*="image-content"], [class*="ImgContainer"], [class*="img-container"], '
        + '[class*="image-wrap"], [class*="imageWrap"]'
      );
      if (block) img = block.querySelector('img');
    }
    if (img) {
      pushApprovedImageCandidate(result, img.currentSrc);
      pushApprovedImageCandidate(result, img.src);
      pushApprovedImageCandidate(result, img.getAttribute('data-src'));
      pushApprovedImageCandidate(result, img.getAttribute('data-original'));
    }

    var el = target;
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1) {
        pushApprovedImageCandidate(
          result,
          extractUrlFromBackgroundImage(getComputedStyle(el).backgroundImage || '')
        );
      }
      el = el.parentElement;
    }
    return result;
  }

  function getApprovedImageCandidatesAtPoint(event) {
    var result = getApprovedImageCandidates(event && event.target);
    if (!event || typeof document.elementsFromPoint !== 'function') return result;
    var stack = document.elementsFromPoint(event.clientX, event.clientY) || [];
    for (var i = 0; i < stack.length; i++) {
      getApprovedImageCandidates(stack[i]).forEach(function (url) {
        if (result.indexOf(url) === -1) result.push(url);
      });
    }
    return result;
  }

  function isImageLikeTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.closest('img')) return true;
    var block = target.closest(
      '[data-block-type="image"], [data-page-block-type="image"], '
      + '.block-image, .image-block, [class*="ImageBlock"], [class*="image-block"], '
      + '[class*="image-content"], [class*="ImgContainer"], [class*="img-container"], '
      + '[class*="image-wrap"], [class*="imageWrap"]'
    );
    if (block && block.querySelector('img')) return true;
    var el = target;
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1 && extractUrlFromBackgroundImage(getComputedStyle(el).backgroundImage || '')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isImageLikePoint(event) {
    if (isImageLikeTarget(event.target)) return true;
    if (typeof document.elementsFromPoint !== 'function') return false;
    var stack = document.elementsFromPoint(event.clientX, event.clientY) || [];
    for (var i = 0; i < stack.length; i++) {
      if (isImageLikeTarget(stack[i])) return true;
    }
    return false;
  }

  function isRightButton(event) {
    return event.button === 2 || (event.buttons != null && event.buttons === 2);
  }

  function rememberTrustedImageContextGesture(event) {
    if (!event || event.isTrusted !== true || !isRightButton(event) || !isImageLikePoint(event)) return;
    var candidates = getApprovedImageCandidatesAtPoint(event);
    lastImageContextGesture = candidates.length
      ? { createdAt: Date.now(), candidates: candidates }
      : null;
  }

  function suppressFeishuImageRightButton(event) {
    if (!isRightButton(event) || !isImageLikePoint(event)) return;
    rememberTrustedImageContextGesture(event);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'].forEach(function (type) {
    window.addEventListener(type, suppressFeishuImageRightButton, true);
  });
  window.addEventListener('contextmenu', rememberTrustedImageContextGesture, true);

  // 转发页面运行时的实时进度到 popup / service worker（供关闭后重开恢复进度）。
  document.addEventListener(UI_PROGRESS_EVENT, function (event) {
    if (!activeRequestId) return;
    var detail = (event && event.detail) || {};
    broadcastProgress({
      state: 'progress',
      requestId: activeRequestId,
      action: activeAction,
      phase: protocol.normalizeProgressLabel(detail.phase),
      done: protocol.normalizeProgressNumber(detail.done),
      total: protocol.normalizeProgressNumber(detail.total),
      label: protocol.normalizeProgressLabel(detail.label),
    });
  }, true);

  // 图片跨域抓取桥接：MAIN world 运行时无法直接用 chrome API，通过 DOM 事件
  // 委托内容脚本调用后台 service worker 抓取图片字节（绕开页面 CORS），
  // 再把 data URL 回传给运行时写入剪贴板。
  var IMAGE_FETCH_EVENT = protocol.DOM_EVENTS.IMAGE_FETCH;
  var IMAGE_FETCH_RESULT_EVENT = protocol.DOM_EVENTS.IMAGE_FETCH_RESULT;
  var IMAGE_FETCH_MESSAGE = protocol.MESSAGES.IMAGE_FETCH;

  document.addEventListener(IMAGE_FETCH_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    var validation = protocol.validateImageUrl(detail.url, location.href);
    function reply(result) {
      document.dispatchEvent(new CustomEvent(IMAGE_FETCH_RESULT_EVENT, {
        detail: Object.assign({ requestId: requestId }, result),
      }));
    }
    if (!protocol.validateRequestId(requestId)) return;
    if (!validation.ok) { reply({ ok: false, error: validation.error }); return; }

    var gesture = lastImageContextGesture;
    lastImageContextGesture = null;
    if (!gesture || Date.now() - gesture.createdAt > protocol.LIMITS.IMAGE_GESTURE_TTL_MS
      || gesture.candidates.indexOf(validation.url) === -1) {
      reply({ ok: false, error: 'image fetch requires a recent trusted context-menu gesture' });
      return;
    }
    try {
      chrome.runtime.sendMessage({ source: IMAGE_FETCH_MESSAGE, url: validation.url }, function (response) {
        if (chrome.runtime.lastError) {
          reply({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        reply(response || { ok: false, error: 'no response' });
      });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
  }, true);

  var PENDING_PASTE_EVENT = protocol.DOM_EVENTS.PENDING_PASTE;
  var PENDING_PASTE_RESULT_EVENT = protocol.DOM_EVENTS.PENDING_PASTE_RESULT;

  document.addEventListener(PENDING_PASTE_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    var op = String(detail.op || '');
    function reply(result) {
      document.dispatchEvent(new CustomEvent(PENDING_PASTE_RESULT_EVENT, {
        detail: Object.assign({ requestId: requestId }, result),
      }));
    }
    if (!protocol.validateRequestId(requestId)) return;
    if (!activeRequestId || !protocol.isPendingOpAllowed(activeAction, op)) {
      reply({ ok: false, error: 'pending operation is outside an allowed extension action' });
      return;
    }
    if (op === protocol.PENDING_OPS.SET) {
      var pendingValidation = protocol.validatePendingPayload(detail.value);
      if (!pendingValidation.ok) { reply({ ok: false, error: pendingValidation.error }); return; }
    }
    try {
      chrome.runtime.sendMessage({
        source: PENDING_PASTE_MESSAGE,
        action: activeAction,
        actionRequestId: activeRequestId,
        op: op,
        value: op === protocol.PENDING_OPS.SET ? detail.value : null,
      }, function (response) {
        if (chrome.runtime.lastError) {
          reply({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        reply(response || { ok: false, error: 'no response' });
      });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
  }, true);

  function createRequestId() {
    var cryptoApi = globalThis.crypto;
    if (!cryptoApi) return '';
    if (typeof cryptoApi.randomUUID === 'function') {
      return 'feishu-helper-' + cryptoApi.randomUUID();
    }
    if (typeof cryptoApi.getRandomValues !== 'function') return '';
    var bytes = new Uint32Array(4);
    cryptoApi.getRandomValues(bytes);
    return 'feishu-helper-' + Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(8, '0');
    }).join('');
  }

  function requestPageAction(message) {
    return new Promise(function (resolve) {
      var action = String((message && message.action) || '');
      var payloadValidation = protocol.validateActionPayload(message && message.payload);
      if (!protocol.isSupportedDocumentUrl(location.href)) {
        resolve({ status: 'error', error: '当前页面不是受支持的飞书/Lark 文档。' });
        return;
      }
      if (!protocol.isUiAction(action) || !payloadValidation.ok) {
        resolve({ status: 'error', error: payloadValidation.error || '不支持的扩展操作。' });
        return;
      }
      if (activeRequestId) {
        resolve({ status: 'error', error: '另一个文档操作仍在执行，请稍后重试。' });
        return;
      }

      var requestId = createRequestId();
      if (!protocol.validateRequestId(requestId)) {
        resolve({ status: 'error', error: '当前浏览器无法生成安全的操作标识。' });
        return;
      }
      activeRequestId = requestId;
      activeAction = action;

      // 通知后台：新动作开始（scan 是静默轮询，不广播生命周期）。
      if (action && action !== 'scan') {
        broadcastProgress({ state: 'start', requestId: requestId, action: action });
      }

      function finish(result) {
        if (activeRequestId === requestId) {
          activeRequestId = '';
          activeAction = '';
        }
        if (action && action !== 'scan') {
          broadcastProgress({
            state: 'done',
            requestId: requestId,
            action: action,
            status: String((result && result.status) || 'success'),
          });
        }
        resolve(result);
      }

      var timer = setTimeout(function () {
        document.removeEventListener(UI_RESULT_EVENT, onResult, true);
        finish({ status: 'error', error: '页面脚本响应超时，请确认当前标签页是飞书文档。' });
      }, 45000);

      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener(UI_RESULT_EVENT, onResult, true);
        finish(detail);
      }

      document.addEventListener(UI_RESULT_EVENT, onResult, true);
      document.dispatchEvent(new CustomEvent(protocol.DOM_EVENTS.UI_ACTION, {
        detail: {
          requestId: requestId,
          action: action,
          payload: (message && message.payload) || null,
        },
      }));
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.source !== SOURCE || !sender || sender.id !== chrome.runtime.id) return false;
    requestPageAction(message).then(function (result) { sendResponse(result); });
    return true;
  });
})();
