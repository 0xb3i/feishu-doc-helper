  // ── Runner-facing automation bridge ────────────────────────────────────────

  function dispatchAutomationResult(detail) {
    try {
      window.dispatchEvent(new CustomEvent(AUTOMATION_RESULT_EVENT, { detail: detail }));
    } catch (err) {}
  }

  function runAutomationAction(action) {
    var handlers = {
      duplicateDocument: duplicateDocumentForAutomation,
      validateDuplicateDocument: buildValidateDuplicateDocumentSummary,
    };
    var handler = handlers[String(action || '')];
    if (!handler) return Promise.reject(new Error('Unsupported automation action: ' + String(action || '')));
    return handler();
  }

  registerEventListener(window, AUTOMATION_REQUEST_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    if (!detail.requestId) return;
    runAutomationAction(detail.action).then(function (summary) {
      dispatchAutomationResult({ requestId: detail.requestId, status: 'success', summary: summary });
    }).catch(function (error) {
      dispatchAutomationResult({ requestId: detail.requestId, status: 'error', error: stringifyError(error) });
    });
  }, true);

  function dispatchUiActionResult(detail) {
    try {
      document.dispatchEvent(new CustomEvent('feishu-helper:ui-result', { detail: detail }));
    } catch (err) {}
  }

  function runUiAction(action) {
    var name = String(action || '');
    if (name === 'extract') return duplicateDocumentForAutomation();
    if (name === 'paste') return pasteIntoDoc();
    if (name === 'snapshot') return Promise.resolve(captureValidationSnapshot());
    if (name === 'scan') {
      var snapshot = captureValidationSnapshot() || {};
      return Promise.resolve({
        blockCount: Number(snapshot.blockCount || 0),
        equationCount: Number(snapshot.equationCount || 0),
        imageCount: Number(snapshot.imageCount || 0),
      });
    }
    if (name === 'images') {
      var images = extractImages();
      if (!images.length) showToast('当前页面未找到图片');
      else createImagePanel(images);
      return Promise.resolve({ imageCount: images.length });
    }
    if (name === 'prepareNativePaste') return preparePendingPasteForNativePaste();
    return Promise.reject(new Error('Unsupported UI action: ' + name));
  }

  registerEventListener(document, 'feishu-helper:ui-action', function (event) {
    var detail = (event && event.detail) || {};
    if (!detail.requestId) return;
    // popup 触发的操作：截流页面 toast，把文案随结果回传给面板显示
    beginToastCapture();
    runUiAction(detail.action).then(function (summary) {
      var notice = endToastCapture();
      dispatchUiActionResult({ requestId: detail.requestId, status: 'success', summary: summary || null, notice: notice || '' });
    }).catch(function (error) {
      var notice = endToastCapture();
      dispatchUiActionResult({ requestId: detail.requestId, status: 'error', error: stringifyError(error), notice: notice || '' });
    });
  }, true);

  registerEventListener(document, 'feishu-capture-snapshot', function () {
    try { captureValidationSnapshot(); }
    catch (e) {}
  }, true);

  registerEventListener(document, 'feishu-prepare-native-paste', function () {
    setDocJsonAttr('data-feishu-native-paste-prepare', { status: 'running' });
    preparePendingPasteForNativePaste().then(function (summary) {
      setDocJsonAttr('data-feishu-native-paste-prepare', { status: 'success', summary: summary || null });
    }).catch(function (error) {
      setDocJsonAttr('data-feishu-native-paste-prepare', { status: 'error', error: stringifyError(error) });
    });
  }, true);

  // ── Whiteboard hook tracer (runner uses for whiteboard clone diagnostics) ──

  // The tracer wraps editor service methods on demand and records a structured
  // call log into `data-feishu-whiteboard-hook-log`.  It's only installed when
  // the runner asks for it via `feishu-install-whiteboard-hook-debug`.

  var whiteboardHookLog = [];
  var whiteboardHookState = {
    installed: false,
    installedAt: '',
    href: '',
    wrappedPaths: [],
    logCount: 0,
    errors: [],
  };
  var whiteboardHookCallSeq = 0;

  function syncWhiteboardHookDebugState() {
    whiteboardHookState.logCount = whiteboardHookLog.length;
    whiteboardHookState.href = location.href;
    setDocJsonAttr('data-feishu-whiteboard-hook-state', whiteboardHookState);
    setDocJsonAttr('data-feishu-whiteboard-hook-log', whiteboardHookLog.slice(-FEISHU_CAPTURED_REQUEST_LIMIT));
  }

  function summarizeHookValue(value, depth) {
    depth = depth || 0;
    if (value == null) return value;
    var t = typeof value;
    if (t === 'string') return { type: 'string', length: value.length, preview: value.slice(0, 200) };
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'function') {
      return {
        type: 'function',
        name: String(value.name || ''),
        wrapped: value.__feishuWhiteboardHookTracer === true,
      };
    }
    if (depth >= 2) {
      return { type: Array.isArray(value) ? 'array' : 'object' };
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length,
        sample: value.slice(0, 4).map(function (item) { return summarizeHookValue(item, depth + 1); }),
      };
    }
    var keys;
    try { keys = Object.keys(value).slice(0, 16); }
    catch (err) { keys = []; }
    var out = { type: (value.constructor && value.constructor.name) || 'object', keys: keys };
    ['type', 'blockType', 'token', 'blockToken', 'whiteboardToken', 'baseToken'].forEach(function (key) {
      if (value[key] !== undefined) {
        try { out[key] = summarizeHookValue(value[key], depth + 1); }
        catch (err) {}
      }
    });
    return out;
  }

  function recordWhiteboardHookLogEntry(meta, phase, extra) {
    var entry = Object.assign({
      callId: 'whiteboard-hook-' + (++whiteboardHookCallSeq),
      phase: String(phase || ''),
      timestamp: Date.now(),
      href: location.href,
      path: meta.path || '',
      method: meta.method || '',
    }, extra || {});
    whiteboardHookLog.push(entry);
    syncWhiteboardHookDebugState();
  }

  function wrapWhiteboardHookFunction(target, methodName, meta) {
    if (!target || typeof target[methodName] !== 'function') return false;
    var current = target[methodName];
    if (current.__feishuWhiteboardHookTracer === true) return true;
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments).map(function (arg) { return summarizeHookValue(arg, 0); });
      recordWhiteboardHookLogEntry(meta, 'call', { args: args });
      try {
        var result = current.apply(this, arguments);
        if (result && typeof result.then === 'function') {
          recordWhiteboardHookLogEntry(meta, 'return', { result: { type: 'promise' } });
          return result.then(function (resolved) {
            recordWhiteboardHookLogEntry(meta, 'resolve', { result: summarizeHookValue(resolved, 0) });
            return resolved;
          }).catch(function (error) {
            recordWhiteboardHookLogEntry(meta, 'reject', { error: stringifyError(error) });
            throw error;
          });
        }
        recordWhiteboardHookLogEntry(meta, 'return', { result: summarizeHookValue(result, 0) });
        return result;
      } catch (error) {
        recordWhiteboardHookLogEntry(meta, 'throw', { error: stringifyError(error) });
        throw error;
      }
    };
    wrapped.__feishuWhiteboardHookTracer = true;
    target[methodName] = wrapped;
    return true;
  }

  function installWhiteboardHookTracer(options) {
    var opts = options || {};
    if (opts.reset !== false) {
      whiteboardHookLog = [];
      whiteboardHookState.errors = [];
    }

    var wrappedPaths = [];
    var errors = [];
    var editorAPI = getEditorAPI();
    var contentMap = editorAPI
      && editorAPI.featureService
      && editorAPI.featureService._contentMap;

    if (contentMap) {
      Object.keys(contentMap).forEach(function (featureName) {
        if (!/clipboard|copy|paste/i.test(featureName)) return;
        var entries = contentMap[featureName];
        if (!entries) return;
        Object.keys(entries).forEach(function (entryKey) {
          var entry = entries[entryKey];
          var blockSetting = entry && entry.blockSetting;
          if (!(blockSetting && String(blockSetting.blockType || '') === 'whiteboard')) return;
          Object.keys(blockSetting).forEach(function (methodName) {
            if (typeof blockSetting[methodName] !== 'function') return;
            if (!/^on[A-Z]/.test(methodName)) return;
            var path = 'editorAPI.featureService._contentMap.' + featureName + '.' + entryKey + '.blockSetting.' + methodName;
            try {
              if (wrapWhiteboardHookFunction(blockSetting, methodName, { path: path, method: methodName })) {
                wrappedPaths.push({ path: path });
              }
            } catch (error) {
              errors.push({ path: path, error: stringifyError(error) });
            }
          });
        });
      });
    }

    var whiteboardConfig = editorAPI
      && editorAPI.dataService
      && editorAPI.dataService.dataProvider
      && editorAPI.dataService.dataProvider.configs
      && editorAPI.dataService.dataProvider.configs.whiteboard;

    if (whiteboardConfig && typeof whiteboardConfig.createSnapshot === 'function') {
      var path = 'editorAPI.dataService.dataProvider.configs.whiteboard.createSnapshot';
      try {
        if (wrapWhiteboardHookFunction(whiteboardConfig, 'createSnapshot', { path: path, method: 'createSnapshot' })) {
          wrappedPaths.push({ path: path });
        }
      } catch (error) {
        errors.push({ path: path, error: stringifyError(error) });
      }
    }

    whiteboardHookState = {
      installed: true,
      installedAt: new Date().toISOString(),
      href: location.href,
      wrappedPaths: wrappedPaths,
      logCount: whiteboardHookLog.length,
      errors: errors,
    };
    syncWhiteboardHookDebugState();
    return whiteboardHookState;
  }

  registerEventListener(document, 'feishu-install-whiteboard-hook-debug', function (event) {
    try { installWhiteboardHookTracer((event && event.detail) || {}); }
    catch (error) {
      whiteboardHookState = {
        installed: false,
        installedAt: '',
        href: location.href,
        wrappedPaths: [],
        logCount: whiteboardHookLog.length,
        errors: [{ error: stringifyError(error) }],
      };
      syncWhiteboardHookDebugState();
    }
  }, true);

  registerEventListener(document, 'feishu-read-whiteboard-hook-debug', function () {
    try { syncWhiteboardHookDebugState(); }
    catch (e) {}
  }, true);

  // Expose a tiny module surface mostly so tests can assert userscript shape.
  window.__feishuHelperRuntime.modules = {
    extraction: {
      extractFullDoc: extractFullDoc,
      duplicateDocumentForAutomation: duplicateDocumentForAutomation,
      preparePendingPasteForNativePaste: preparePendingPasteForNativePaste,
      captureValidationSnapshot: captureValidationSnapshot,
      getEditorReadyState: getEditorReadyState,
    },
    clipboard: {
      buildClipboardPayload: buildClipboardPayload,
      writeClipboardPayload: writeClipboardPayload,
      pasteIntoDoc: pasteIntoDoc,
    },
    automation: {
      runAutomationAction: runAutomationAction,
      requestEvent: AUTOMATION_REQUEST_EVENT,
      resultEvent: AUTOMATION_RESULT_EVENT,
    },
  };
