  // ── Pending paste storage ──────────────────────────────────────────────────

  var PENDING_PASTE_TTL_MS = 3600000;

  // Token map for uploaded images (oldToken -> newToken). Keeping this next to
  // pending-paste state avoids making storage depend on the later image module.
  var uploadedTokenMap = {};
  var uploadedTokenMapPendingTs = 0;

  function clearUploadedTokenMap() {
    uploadedTokenMap = {};
    uploadedTokenMapPendingTs = 0;
  }

  function ensureUploadedTokenMapMatchesPending(pendingPaste) {
    if (!pendingPaste) {
      clearUploadedTokenMap();
      return null;
    }
    if (uploadedTokenMapPendingTs && pendingPaste.ts && pendingPaste.ts > uploadedTokenMapPendingTs) {
      clearUploadedTokenMap();
    }
    return pendingPaste;
  }

  function mergeUploadedTokenMap(tokenMap) {
    if (tokenMap && typeof tokenMap === 'object') {
      Object.keys(tokenMap).forEach(function (key) { uploadedTokenMap[key] = tokenMap[key]; });
    }
    uploadedTokenMapPendingTs = Date.now();
    return Object.keys(uploadedTokenMap).length;
  }

  function clonePendingPasteData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    try { return JSON.parse(JSON.stringify(data)); }
    catch (error) { return null; }
  }

  function isPendingPasteFresh(data) {
    var timestamp = Number(data && data.ts);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
    var age = Date.now() - timestamp;
    return age >= 0 && age < PENDING_PASTE_TTL_MS;
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
      }, 2000);

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

  function getExtensionPendingPaste() {
    return requestExtensionPendingPaste('get').then(function (data) {
      if (data === null || data === undefined) return null;
      var cloned = clonePendingPasteData(data);
      if (!cloned) throw createPendingPasteStorageError('get', '缓存数据格式无效');
      return cloned;
    });
  }

  function setExtensionPendingPaste(data) {
    var cloned = clonePendingPasteData(data);
    if (!cloned) return Promise.reject(createPendingPasteStorageError('set', '缓存数据无法序列化'));
    return requestExtensionPendingPaste('set', cloned).then(function () { return cloned; });
  }

  function deleteExtensionPendingPaste() {
    return requestExtensionPendingPaste('delete').then(function () {
      setDocAttr('data-feishu-pending-paste-ts', null);
    });
  }

  function getPendingPaste() {
    return getExtensionPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) return ensureUploadedTokenMapMatchesPending(null);
      if (isPendingPasteFresh(pendingPaste)) {
        return ensureUploadedTokenMapMatchesPending(pendingPaste);
      }
      return deleteExtensionPendingPaste().then(function () {
        return ensureUploadedTokenMapMatchesPending(null);
      });
    });
  }

  function setPendingPaste(data) {
    var pendingPaste = clonePendingPasteData(data);
    if (!pendingPaste) {
      return Promise.reject(createPendingPasteStorageError('set', '待保存数据无效'));
    }
    pendingPaste.schemaVersion = 1;
    pendingPaste.ts = Date.now();
    pendingPaste.savedFromHost = location.host;
    pendingPaste.savedFromHref = location.href;
    return setExtensionPendingPaste(pendingPaste).then(function () {
      setDocAttr('data-feishu-pending-paste-ts', String(pendingPaste.ts));
      return pendingPaste;
    });
  }
