(function () {
  'use strict';

  var SOURCE = 'FEISHU_EXTENSION_UI';
  var UI_RESULT_EVENT = 'feishu-helper:ui-result';
  var UI_PROGRESS_EVENT = 'feishu-helper:ui-progress';
  var PROGRESS_MESSAGE = 'FEISHU_EXTENSION_PROGRESS';

  // 当前进行中的动作 requestId / 名称，用于把页面进度事件关联到本次操作。
  var activeRequestId = '';
  var activeAction = '';

  function broadcastProgress(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ source: PROGRESS_MESSAGE }, payload));
    } catch (err) {}
  }

  // 转发页面运行时的实时进度到 popup / service worker（供关闭后重开恢复进度）。
  document.addEventListener(UI_PROGRESS_EVENT, function (event) {
    if (!activeRequestId) return;
    var detail = (event && event.detail) || {};
    broadcastProgress({
      state: 'progress',
      requestId: activeRequestId,
      action: activeAction,
      phase: String(detail.phase || ''),
      done: Number(detail.done || 0),
      total: Number(detail.total || 0),
      label: String(detail.label || ''),
    });
  }, true);

  // 图片跨域抓取桥接：MAIN world 运行时无法直接用 chrome API，通过 DOM 事件
  // 委托内容脚本调用后台 service worker 抓取图片字节（绕开页面 CORS），
  // 再把 data URL 回传给运行时写入剪贴板。
  var IMAGE_FETCH_EVENT = 'feishu-helper:image-fetch';
  var IMAGE_FETCH_RESULT_EVENT = 'feishu-helper:image-fetch-result';
  var IMAGE_FETCH_MESSAGE = 'FEISHU_EXTENSION_IMAGE_FETCH';

  document.addEventListener(IMAGE_FETCH_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var requestId = String(detail.requestId || '');
    var url = String(detail.url || '');
    if (!requestId) return;
    function reply(result) {
      document.dispatchEvent(new CustomEvent(IMAGE_FETCH_RESULT_EVENT, {
        detail: Object.assign({ requestId: requestId }, result),
      }));
    }
    try {
      chrome.runtime.sendMessage({ source: IMAGE_FETCH_MESSAGE, url: url }, function (response) {
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

  function requestPageAction(message) {
    return new Promise(function (resolve) {
      var requestId = SOURCE + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var action = String((message && message.action) || '');
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
      document.dispatchEvent(new CustomEvent('feishu-helper:ui-action', {
        detail: {
          requestId: requestId,
          action: action,
          payload: (message && message.payload) || null,
        },
      }));
    });
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.source !== SOURCE) return false;
    requestPageAction(message).then(function (result) { sendResponse(result); });
    return true;
  });
})();
