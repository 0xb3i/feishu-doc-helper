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
  var activeWhiteboardBundleId = '';
  var nativeRequestInFlight = false;
  var lastImageContextGesture = null;
  var clipboardTransferInFlight = false;

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

  function getImageElementAtPoint(event) {
    var target = event && event.target;
    var image = target && target.nodeType === 1 && typeof target.closest === 'function'
      ? target.closest('img')
      : null;
    if (image) return image;
    if (!event || typeof document.elementsFromPoint !== 'function') return null;
    var stack = document.elementsFromPoint(event.clientX, event.clientY) || [];
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (!node || node.nodeType !== 1) continue;
      image = node.closest && node.closest('img');
      if (image) return image;
      var block = node.closest && node.closest('[data-block-type="image"], [data-page-block-type="image"]');
      if (block && block.querySelector('img')) return block.querySelector('img');
    }
    return null;
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
    var isContextMenuGesture = event && event.type === 'contextmenu';
    if (!event || event.isTrusted !== true
      || (!isRightButton(event) && !isContextMenuGesture)
      || !isImageLikePoint(event)) return;
    var candidates = getApprovedImageCandidatesAtPoint(event);
    // 飞书会把已鉴权加载的图片换成 blob: URL。它不属于后台可请求的
    // HTTPS allowlist，但仍是真实右击命中的可见图片，允许后续仅写入已渲染像素。
    lastImageContextGesture = {
      createdAt: Date.now(),
      candidates: candidates,
      imageElement: getImageElementAtPoint(event),
    };
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

  var IMAGE_CONTEXT_COPY_EVENT = protocol.DOM_EVENTS.IMAGE_CONTEXT_COPY;
  var IMAGE_CONTEXT_COPY_RESULT_EVENT = protocol.DOM_EVENTS.IMAGE_CONTEXT_COPY_RESULT;
  var IMAGE_CONTEXT_DOWNLOAD_EVENT = protocol.DOM_EVENTS.IMAGE_CONTEXT_DOWNLOAD;
  var IMAGE_CONTEXT_DOWNLOAD_RESULT_EVENT = protocol.DOM_EVENTS.IMAGE_CONTEXT_DOWNLOAD_RESULT;

  function replyImageContextAction(eventName, requestId, result) {
    document.dispatchEvent(new CustomEvent(eventName, {
      detail: Object.assign({ requestId: requestId }, result),
    }));
  }

  function renderedImagePngBlob(image) {
    return new Promise(function (resolve, reject) {
      try {
        if (!image || !(image.naturalWidth || image.width)) {
          reject(new Error('rendered image is unavailable'));
          return;
        }
        var canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('rendered image conversion returned no data'));
        }, 'image/png');
      } catch (error) {
        reject(error);
      }
    });
  }

  function fetchTrustedImageBlob(url) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ source: protocol.MESSAGES.IMAGE_FETCH, url: url }, function (response) {
        if (chrome.runtime.lastError || !response || !response.ok || !response.dataUrl) {
          reject(new Error(chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : String(response && response.error || 'image fetch failed')));
          return;
        }
        try {
          resolve(globalThis.FeishuExtensionImageClipboard.dataUrlToBlob(response.dataUrl));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function writeTrustedContextImage(blobPromise) {
    var clipboard = globalThis.FeishuExtensionImageClipboard;
    if (!document.hasFocus() || !clipboard) {
      return Promise.reject(new Error('document clipboard context is unavailable'));
    }
    return clipboard.writeImageBlobPromise(blobPromise);
  }

  function consumeTrustedContextImage(sourceUrl) {
    var gesture = lastImageContextGesture;
    var gestureIsFresh = Boolean(gesture)
      && Date.now() - gesture.createdAt <= protocol.LIMITS.IMAGE_GESTURE_TTL_MS;
    if (!gestureIsFresh) {
      throw new Error('image action requires a recent trusted context-menu gesture');
    }

    var urlValidation = sourceUrl ? protocol.validateImageUrl(sourceUrl, location.href) : null;
    var hasRenderedImage = Boolean(gesture.imageElement && gesture.imageElement.isConnected);
    var hasApprovedUrl = Boolean(urlValidation && urlValidation.ok
      && gesture.candidates.indexOf(urlValidation.url) !== -1);
    if (!hasRenderedImage && !hasApprovedUrl) {
      throw new Error('image action payload does not match the trusted gesture');
    }

    lastImageContextGesture = null;
    var imageBlob = hasRenderedImage
      ? renderedImagePngBlob(gesture.imageElement).catch(function (error) {
        if (hasApprovedUrl) return fetchTrustedImageBlob(urlValidation.url);
        throw error;
      })
      : fetchTrustedImageBlob(urlValidation.url);
    return {
      blobPromise: imageBlob,
      mode: hasRenderedImage ? 'rendered-pixels' : 'background-fetch',
    };
  }

  function downloadTrustedContextImage(blobPromise) {
    var clipboard = globalThis.FeishuExtensionImageClipboard;
    if (!clipboard) return Promise.reject(new Error('image conversion context is unavailable'));
    return Promise.resolve(blobPromise).then(clipboard.toPngBlob).then(function (pngBlob) {
      var objectUrl = URL.createObjectURL(pngBlob);
      var anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'feishu_image.png';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
    });
  }

  // MAIN world 只提供已渲染像素或右击命中的受控 URL；孤立世界要求
  // 最近的真实图片右击手势，并且一次性消耗它，防止页面脚本任意导出图片。
  document.addEventListener(IMAGE_CONTEXT_COPY_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    if (!protocol.validateRequestId(requestId)) return;
    var trustedImage;
    try {
      trustedImage = consumeTrustedContextImage(String(detail.url || ''));
    } catch (error) {
      replyImageContextAction(IMAGE_CONTEXT_COPY_RESULT_EVENT, requestId, {
        ok: false,
        error: String(error && error.message || error),
      });
      return;
    }

    // 这一行必须在菜单 click 事件的同步调用栈中执行。blobPromise 可异步完成。
    writeTrustedContextImage(trustedImage.blobPromise).then(function () {
      replyImageContextAction(IMAGE_CONTEXT_COPY_RESULT_EVENT, requestId, {
        ok: true,
        written: true,
        mode: trustedImage.mode,
      });
    }).catch(function (error) {
      replyImageContextAction(IMAGE_CONTEXT_COPY_RESULT_EVENT, requestId, {
        ok: false,
        error: String(error && error.message || error),
      });
    });
  }, true);

  document.addEventListener(IMAGE_CONTEXT_DOWNLOAD_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    if (!protocol.validateRequestId(requestId)) return;
    var trustedImage;
    try {
      trustedImage = consumeTrustedContextImage(String(detail.url || ''));
    } catch (error) {
      replyImageContextAction(IMAGE_CONTEXT_DOWNLOAD_RESULT_EVENT, requestId, {
        ok: false,
        error: String(error && error.message || error),
      });
      return;
    }
    downloadTrustedContextImage(trustedImage.blobPromise).then(function () {
      replyImageContextAction(IMAGE_CONTEXT_DOWNLOAD_RESULT_EVENT, requestId, {
        ok: true,
        downloaded: true,
        mode: trustedImage.mode,
      });
    }).catch(function (error) {
      replyImageContextAction(IMAGE_CONTEXT_DOWNLOAD_RESULT_EVENT, requestId, {
        ok: false,
        error: String(error && error.message || error),
      });
    });
  }, true);

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

    var actionAllowsBatchFetch = Boolean(activeRequestId)
      && activeAction === protocol.ACTIONS.EXTRACT;
    var gesture = lastImageContextGesture;
    var gestureAllowsFetch = Boolean(gesture)
      && Date.now() - gesture.createdAt <= protocol.LIMITS.IMAGE_GESTURE_TTL_MS
      && gesture.candidates.indexOf(validation.url) !== -1;
    if (!actionAllowsBatchFetch && !gestureAllowsFetch) {
      reply({ ok: false, error: 'image fetch requires a recent trusted context-menu gesture' });
      return;
    }
    if (gestureAllowsFetch) lastImageContextGesture = null;
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
        if (response && response.ok && op === protocol.PENDING_OPS.GET) {
          var transfer = response.value && response.value.whiteboardTransfer;
          if (transfer && protocol.validateWhiteboardTransfer(transfer).ok) {
            activeWhiteboardBundleId = String(transfer.bundleId);
          }
        }
        reply(response || { ok: false, error: 'no response' });
      });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
  }, true);

  var CLIPBOARD_TRANSFER_EVENT = protocol.DOM_EVENTS.CLIPBOARD_TRANSFER;
  var CLIPBOARD_TRANSFER_RESULT_EVENT = protocol.DOM_EVENTS.CLIPBOARD_TRANSFER_RESULT;

  function writeImageClipboardFocusedContext(imageDataUrl) {
    var pageClipboard = globalThis.FeishuExtensionImageClipboard;
    if (document.hasFocus() && pageClipboard) {
      return pageClipboard.writeImageDataUrl(imageDataUrl).then(function () {
        return { ok: true, written: true };
      });
    }
    return chrome.runtime.sendMessage({
      source: protocol.MESSAGES.CLIPBOARD_WRITE,
      actionRequestId: activeRequestId,
      imageDataUrl: imageDataUrl,
    }).then(function (response) {
      if (!response || !response.ok || !response.written) {
        throw new Error(String(response && response.error || '没有可用的聚焦剪贴板上下文'));
      }
      return response;
    });
  }

  document.addEventListener(CLIPBOARD_TRANSFER_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    var payload = detail.payload;
    function reply(result) {
      document.dispatchEvent(new CustomEvent(CLIPBOARD_TRANSFER_RESULT_EVENT, {
        detail: Object.assign({ requestId: requestId }, result),
      }));
    }
    if (!protocol.validateRequestId(requestId)) return;
    if (!activeRequestId || (activeAction !== protocol.ACTIONS.PASTE
      && activeAction !== protocol.ACTIONS.PREPARE_NATIVE_PASTE)) {
      reply({ ok: false, error: 'clipboard transfer is outside an active paste action' });
      return;
    }
    var validation = protocol.validateClipboardBridgePayload(payload);
    if (!validation.ok) { reply({ ok: false, error: validation.error }); return; }
    if (clipboardTransferInFlight) {
      reply({ ok: false, error: 'another clipboard transfer is still running' });
      return;
    }

    clipboardTransferInFlight = true;
    if (payload.imageDataUrl) {
      writeImageClipboardFocusedContext(payload.imageDataUrl).then(function () {
        var pasted = payload.pasteAfterWrite && document.execCommand('paste') === true;
        clipboardTransferInFlight = false;
        reply({ ok: true, written: true, pasted: pasted });
      }).catch(function (error) {
        clipboardTransferInFlight = false;
        reply({ ok: false, error: String(error && error.message || error) });
      });
      return;
    }
    var handled = false;
    function onCopy(copyEvent) {
      handled = true;
      copyEvent.preventDefault();
      copyEvent.stopImmediatePropagation();
      if (!copyEvent.clipboardData) return;
      if (payload.text) copyEvent.clipboardData.setData('text/plain', payload.text);
      if (payload.html) copyEvent.clipboardData.setData('text/html', payload.html);
      if (payload.docxRecord) copyEvent.clipboardData.setData('docx/record', payload.docxRecord);
    }
    document.addEventListener('copy', onCopy, true);
    try {
      var copied = document.execCommand('copy');
      document.removeEventListener('copy', onCopy, true);
      if (!handled && !copied) throw new Error('extension copy command was rejected');
      var pasted = false;
      if (payload.pasteAfterWrite) pasted = document.execCommand('paste') === true;
      clipboardTransferInFlight = false;
      reply({ ok: true, written: true, pasted: pasted });
    } catch (error) {
      document.removeEventListener('copy', onCopy, true);
      clipboardTransferInFlight = false;
      reply({ ok: false, error: String(error && error.message || error) });
    }
  }, true);

  var WHITEBOARD_NATIVE_EVENT = protocol.DOM_EVENTS.WHITEBOARD_NATIVE;
  var WHITEBOARD_NATIVE_RESULT_EVENT = protocol.DOM_EVENTS.WHITEBOARD_NATIVE_RESULT;

  document.addEventListener(WHITEBOARD_NATIVE_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    var op = String(detail.op || '');
    function reply(result) {
      document.dispatchEvent(new CustomEvent(WHITEBOARD_NATIVE_RESULT_EVENT, {
        detail: Object.assign({ requestId: requestId }, result),
      }));
    }
    if (!protocol.validateRequestId(requestId)) return;
    if (!activeRequestId) {
      reply({ ok: false, error: 'whiteboard native operation is outside an active extension action' });
      return;
    }
    if (nativeRequestInFlight) {
      reply({ ok: false, error: 'another whiteboard native operation is still running' });
      return;
    }

    var request = {
      type: protocol.NATIVE_MESSAGING.REQUEST_TYPE,
      host: protocol.NATIVE_MESSAGING.HOST_NAME,
      op: op,
      action: activeAction,
    };
    if (op === protocol.NATIVE_MESSAGING.OPS.INSPECT
      || op === protocol.NATIVE_MESSAGING.OPS.EXPORT) request.sourceUrl = location.href;
    if (op === protocol.NATIVE_MESSAGING.OPS.PREFLIGHT || op === protocol.NATIVE_MESSAGING.OPS.APPLY) {
      request.bundleId = String(detail.bundleId || '');
      request.targetUrl = location.href;
    }
    if (op === protocol.NATIVE_MESSAGING.OPS.RECONCILE_IMAGES) {
      request.targetUrl = location.href;
      request.images = Array.isArray(detail.images) ? detail.images : [];
    }
    if (op === protocol.NATIVE_MESSAGING.OPS.DISCARD) {
      request.bundleId = String(detail.bundleId || '');
    }
    var validation = protocol.validateNativeMessagingRequest(request);
    if (!validation.ok) {
      var diagnostic = op === protocol.NATIVE_MESSAGING.OPS.RECONCILE_IMAGES
        ? ' [action=' + String(request.action) + ', target=' + Boolean(request.targetUrl)
          + ', bundle=' + Object.prototype.hasOwnProperty.call(request, 'bundleId')
          + ', source=' + Object.prototype.hasOwnProperty.call(request, 'sourceUrl')
          + ', images=' + (Array.isArray(request.images) ? request.images.length : -1) + ']'
        : '';
      reply({ ok: false, error: validation.error + diagnostic });
      return;
    }
    if ((op === protocol.NATIVE_MESSAGING.OPS.PREFLIGHT || op === protocol.NATIVE_MESSAGING.OPS.APPLY)
      && (!activeWhiteboardBundleId || request.bundleId !== activeWhiteboardBundleId)) {
      reply({ ok: false, error: 'whiteboard bundle does not match the active pending paste' });
      return;
    }
    if (op === protocol.NATIVE_MESSAGING.OPS.DISCARD
      && (!activeWhiteboardBundleId || request.bundleId !== activeWhiteboardBundleId)) {
      reply({ ok: false, error: 'whiteboard discard does not match the active extract' });
      return;
    }

    try {
      nativeRequestInFlight = true;
      chrome.runtime.sendMessage({
        source: protocol.NATIVE_MESSAGING.REQUEST_TYPE,
        actionRequestId: activeRequestId,
        request: request,
      }, function (response) {
        nativeRequestInFlight = false;
        if (chrome.runtime.lastError) {
          reply({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (response && response.ok && op === protocol.NATIVE_MESSAGING.OPS.EXPORT) {
          var exportedTransfer = response.data && response.data.whiteboardTransfer;
          if (exportedTransfer && protocol.validateWhiteboardTransfer(exportedTransfer).ok) {
            activeWhiteboardBundleId = String(exportedTransfer.bundleId);
          }
        }
        reply(response || { ok: false, error: 'Native Host 未返回响应' });
      });
    } catch (error) {
      nativeRequestInFlight = false;
      reply({ ok: false, error: String(error && error.message || error) });
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
      activeWhiteboardBundleId = '';
      nativeRequestInFlight = false;

      // 通知后台：新动作开始（scan 是静默轮询，不广播生命周期）。
      if (action && action !== 'scan') {
        broadcastProgress({ state: 'start', requestId: requestId, action: action });
      }

      function finish(result) {
        if (activeRequestId === requestId) {
          activeRequestId = '';
          activeAction = '';
          activeWhiteboardBundleId = '';
          nativeRequestInFlight = false;
        }
        if (action && action !== 'scan') {
          broadcastProgress({
            state: 'done',
            requestId: requestId,
            action: action,
            status: String((result && result.status) || 'success'),
            error: protocol.normalizeProgressLabel(result && result.error),
            notice: protocol.normalizeProgressLabel(result && result.notice),
          });
        }
        resolve(result);
      }

      var actionTimeoutMs = action === protocol.ACTIONS.EXTRACT || action === protocol.ACTIONS.PASTE
        || action === protocol.ACTIONS.PREPARE_NATIVE_PASTE ? 10 * 60 * 1000 : 45000;
      var timer = setTimeout(function () {
        document.removeEventListener(UI_RESULT_EVENT, onResult, true);
        finish({ status: 'error', error: '页面脚本响应超时，请确认当前标签页是飞书文档。' });
      }, actionTimeoutMs);

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
