  // ── Pending paste storage ──────────────────────────────────────────────────

  function clonePendingPasteData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    try { return JSON.parse(JSON.stringify(data)); }
    catch (error) { return null; }
  }

  function createPendingPasteId() {
    var cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') return '';
    var bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return 'pending_' + Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }

  function createPendingPasteStorageError(op, reason) {
    var message = String(reason && reason.message ? reason.message : (reason || '未知错误'));
    return new Error('扩展待粘贴缓存 ' + op + ' 失败：' + message);
  }

  function requestExtensionPendingPaste(op, value) {
    return new Promise(function (resolve, reject) {
      var requestId = 'pending-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, createPendingPasteStorageError(op, '请求超时'));
      }, 30000);

      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener(EXTENSION_PENDING_PASTE_RESULT_EVENT, onResult, true);
      }

      function finish(callback, result) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(result);
      }

      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        if (!detail.ok) {
          finish(reject, createPendingPasteStorageError(op, detail.error || '扩展未返回成功状态'));
          return;
        }
        var result = Object.prototype.hasOwnProperty.call(detail, 'value') ? detail.value : null;
        finish(resolve, result);
      }

      document.addEventListener(EXTENSION_PENDING_PASTE_RESULT_EVENT, onResult, true);
      try {
        document.dispatchEvent(new CustomEvent(EXTENSION_PENDING_PASTE_EVENT, {
          detail: { requestId: requestId, op: op, value: value || null },
        }));
      } catch (error) {
        finish(reject, createPendingPasteStorageError(op, error));
      }
    });
  }

  function validatePendingPasteResponse(data, op) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw createPendingPasteStorageError(op, '缓存数据格式无效');
    }
    // The extension message/storage boundary already returns an independent
    // object. Copying the full image payload again here only multiplies memory.
    return data;
  }

  function getPendingPaste() {
    return requestExtensionPendingPaste('get').then(function (data) {
      return data == null ? null : validatePendingPasteResponse(data, 'get');
    });
  }

  function setPendingPaste(data) {
    var pendingPaste = clonePendingPasteData(data);
    if (!pendingPaste) {
      return Promise.reject(createPendingPasteStorageError('set', '待保存数据无效'));
    }
    pendingPaste.schemaVersion = 2;
    pendingPaste.pendingId = createPendingPasteId();
    if (!pendingPaste.pendingId) {
      return Promise.reject(createPendingPasteStorageError('set', '浏览器无法生成安全的缓存标识'));
    }
    pendingPaste.ts = Date.now();
    pendingPaste.savedFromHost = location.host;
    pendingPaste.savedFromHref = location.href;
    return requestExtensionPendingPaste('set', pendingPaste).then(function (stored) {
      var storedPending = validatePendingPasteResponse(stored, 'set');
      setDocAttr('data-feishu-pending-paste-ts', String(storedPending.ts || pendingPaste.ts));
      return storedPending;
    });
  }
