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
