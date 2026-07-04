  var attribs = FeishuHelperLibs.attribs;
  var styleCodec = FeishuHelperLibs.styleCodec;
  var sanitizerFactory = FeishuHelperLibs.htmlSanitizer.createHtmlSanitizer;
  var docxRecord = FeishuHelperLibs.docxRecord;
  var rendererFactory = FeishuHelperLibs.blockRender.createBlockRenderer;
  var snapshotFactory = FeishuHelperLibs.semanticSnapshot.createSemanticSnapshotCollector;

  var sanitizer = sanitizerFactory({
    normalizeLatexHtmlTextNodes: attribs.normalizeLatexHtmlTextNodes,
    normalizeLatexForHtml: attribs.normalizeLatexForHtml,
    containsLatexText: attribs.containsLatexText,
    escapeAttr: attribs.escapeAttr,
  });
  var renderer = rendererFactory({
    attribs: attribs,
    styleCodec: styleCodec,
    sanitizer: sanitizer,
    docxRecord: docxRecord,
  });
  var snapshotCollector = snapshotFactory({
    attribs: attribs,
    styleCodec: styleCodec,
    renderer: renderer,
  });

  // ── Constants ──────────────────────────────────────────────────────────────

  var SCRIPT_VERSION = '5.0.0';
  var AUTOMATION_REQUEST_EVENT = 'feishu-helper:automation-request';
  var AUTOMATION_RESULT_EVENT = 'feishu-helper:automation-result';
  var CONTENT_ROOT_SELECTOR = '[data-content-editable-root="true"]';
  var HIDDEN_PASTE_TEXTAREA_SELECTOR = 'textarea.docx-selection-hidden-textarea';
  var EDITABLE_SELECTOR = [
    CONTENT_ROOT_SELECTOR,
    '.editor-kit-container[contenteditable="true"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
  ].join(', ');
  var MAX_BLOCK_DEPTH = 12;
  var FEISHU_WHITEBOARD_CLONE_RE = /\/space\/api\/whiteboard\/block\/clone(?:[/?#]|$)/i;
  var FEISHU_CAPTURED_REQUEST_LIMIT = 10;
  var IMAGE_PLACEHOLDER_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  var DB_NAME = '__feishu_helper_db__';
  var DB_STORE = 'paste';
  var DB_KEY = 'pending';
  var SHARED_PENDING_PASTE_KEY = '__feishu_helper_pending_paste__';
  var EXTENSION_PENDING_PASTE_EVENT = 'feishu-helper:pending-paste';
  var EXTENSION_PENDING_PASTE_RESULT_EVENT = 'feishu-helper:pending-paste-result';

  // ── Runtime registry & DOM bridge ──────────────────────────────────────────

  var runtimeDisposers = [];

  function registerDisposer(fn) {
    if (typeof fn === 'function') runtimeDisposers.push(fn);
    return fn;
  }

  function disposeRuntime() {
    while (runtimeDisposers.length) {
      var fn = runtimeDisposers.pop();
      try { fn(); } catch (error) {}
    }
  }

  window.__feishuHelperRuntime = {
    version: SCRIPT_VERSION,
    dispose: disposeRuntime,
  };

  function registerEventListener(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function' || typeof listener !== 'function') {
      return listener;
    }
    target.addEventListener(type, listener, options);
    registerDisposer(function () {
      try { target.removeEventListener(type, listener, options); } catch (e) {}
    });
    return listener;
  }

  // The runner pulls progress and results out of these DOM attributes; this is
  // the single place where we serialise userscript state into the DOM.
  function setDocAttr(name, value) {
    if (!name) return;
    try {
      if (value === null || value === undefined || value === '') {
        document.documentElement.removeAttribute(name);
      } else {
        document.documentElement.setAttribute(name, String(value));
      }
    } catch (error) {}
  }

  function setDocJsonAttr(name, value) {
    try { setDocAttr(name, JSON.stringify(value)); } catch (error) {}
  }

  function stringifyError(error) {
    return String(error && error.stack ? error.stack : (error && error.message ? error.message : error));
  }

  console.info('[Feishu Helper v' + SCRIPT_VERSION + '] loaded on', location.href);
  setDocAttr('data-feishu-helper-active', SCRIPT_VERSION);

  // ── Whiteboard clone capture (runner uses this for failure diagnostics) ────

  var capturedWhiteboardClones = [];
  var originalFetch = window.fetch;

  function isWhiteboardCloneRequest(url, method) {
    return FEISHU_WHITEBOARD_CLONE_RE.test(String(url || '')) && /post/i.test(String(method || ''));
  }

  function captureRequestHeaders(headers) {
    var out = {};
    if (!headers) return out;
    try {
      if (headers instanceof Headers) {
        headers.forEach(function (value, key) { out[key] = value; });
      } else if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (key) { out[key] = headers[key]; });
      }
    } catch (error) {}
    return out;
  }

  function summarizeWhiteboardCapture(capture, patch) {
    if (!capture || !patch) return;
    Object.keys(patch).forEach(function (key) { capture[key] = patch[key]; });
    setDocJsonAttr('data-feishu-captured-whiteboard-clones',
      capturedWhiteboardClones.slice(-FEISHU_CAPTURED_REQUEST_LIMIT));
  }

  function recordWhiteboardClone(initial) {
    capturedWhiteboardClones.push(initial);
    setDocJsonAttr('data-feishu-captured-whiteboard-clones',
      capturedWhiteboardClones.slice(-FEISHU_CAPTURED_REQUEST_LIMIT));
    return initial;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input || ''));
    var method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    var capture = null;
    if (isWhiteboardCloneRequest(url, method)) {
      capture = recordWhiteboardClone({
        url: url,
        method: method,
        timestamp: Date.now(),
        headers: captureRequestHeaders(init && init.headers),
        diagnosticType: 'whiteboardClone',
      });
    }
    var result = originalFetch.apply(this, arguments);
    if (!capture || !result || typeof result.then !== 'function') return result;
    return result.then(function (response) {
      summarizeWhiteboardCapture(capture, {
        ok: !!(response && response.ok),
        status: Number((response && response.status) || 0),
        statusText: String((response && response.statusText) || ''),
        responseCapturedAt: Date.now(),
      });
      return response;
    }).catch(function (error) {
      summarizeWhiteboardCapture(capture, {
        fetchError: stringifyError(error),
        responseCapturedAt: Date.now(),
      });
      throw error;
    });
  };
  registerDisposer(function () { window.fetch = originalFetch; });
