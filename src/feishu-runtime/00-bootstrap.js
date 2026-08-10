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

  var SCRIPT_VERSION = '__FEISHU_HELPER_VERSION__';
  // 保留页面原生 fetch 的绑定引用供同源文档 API 使用；不改写 window.fetch。
  var pageFetch = window.fetch.bind(window);
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
  // 普通内容仍沿用较小的提取深度；画板迁移必须覆盖官方 API 返回的深层槽位。
  // 64 与 Native Host 对画板节点的防御性深度上限一致，避免无界递归。
  var WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH = 64;
  var IMAGE_PLACEHOLDER_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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
    return String(error && error.message ? error.message : error);
  }

  console.info('[Feishu Helper v' + SCRIPT_VERSION + '] loaded on', location.href);
  setDocAttr('data-feishu-helper-active', SCRIPT_VERSION);
