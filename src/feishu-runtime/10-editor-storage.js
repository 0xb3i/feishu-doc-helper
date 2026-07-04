  // ── Editor element discovery ───────────────────────────────────────────────

  function scoreEditableRootCandidate(node) {
    if (!node || node.nodeType !== 1) return -Infinity;
    var rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : { width: 0, height: 0 };
    var textLength = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().length;
    var richNodeCount = node.querySelectorAll('img, table, blockquote, pre, hr, [data-block-type], .callout-container, .callout-block, [class*="code-block"], [class*="whiteboard"]').length;
    var imageCount = node.querySelectorAll('img, [data-block-type="image"]').length;
    var tableCount = node.querySelectorAll('table, [data-block-type="table"]').length;
    var blockCount = node.querySelectorAll('[data-block-type], p, li, pre, table, blockquote').length;
    var area = Math.max(rect.width || 0, 0) * Math.max(rect.height || 0, 0);
    var score = 0;
    if (node.getAttribute('data-content-editable-root') === 'true') score += 8;
    score += Math.min(textLength, 4000) / 50;
    score += Math.min(richNodeCount, 30) * 3;
    score += Math.min(imageCount, 10) * 4;
    score += Math.min(tableCount, 10) * 4;
    score += Math.min(blockCount, 40) * 1.5;
    score += Math.min(area, 1600000) / 20000;
    return score;
  }

  function pickBestNode(nodes) {
    if (!nodes || !nodes.length) return null;
    var bestNode = nodes[0];
    var bestScore = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var score = scoreEditableRootCandidate(nodes[i]);
      if (score > bestScore) {
        bestScore = score;
        bestNode = nodes[i];
      }
    }
    return bestNode;
  }

  function getContentRootElement() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(EDITABLE_SELECTOR), 0, 24);
    return pickBestNode(nodes);
  }

  function getValidationSurfaceElement() {
    var seen = [];
    function push(node) {
      if (node && node.nodeType === 1 && seen.indexOf(node) === -1) seen.push(node);
    }
    push(getContentRootElement());
    push(document.querySelector('main'));
    push(document.querySelector('[role="main"]'));
    Array.prototype.slice.call(document.querySelectorAll('[class*="wiki"], [class*="doc"], [class*="editor"], [data-page-id], [data-block-type]'), 0, 24).forEach(push);
    push(document.body);
    if (!seen.length) return null;
    var bestNode = seen[0];
    var bestScore = -Infinity;
    var contentRoot = getContentRootElement();
    seen.forEach(function (node) {
      var score = scoreEditableRootCandidate(node);
      if (node === document.body) score -= 8;
      if (node === contentRoot) score += 4;
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    });
    return bestNode || document.body || null;
  }

  function getReactFiberNode(el) {
    if (!el) return null;
    var fiberKey = Object.getOwnPropertyNames(el).find(function (k) {
      return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
    });
    return fiberKey ? el[fiberKey] : null;
  }

  function findEditorApiValue(extractor) {
    var candidates = [];
    function push(node) {
      if (node && node.nodeType === 1 && candidates.indexOf(node) === -1) candidates.push(node);
    }
    push(getContentRootElement());
    push(document.activeElement);
    var selection = null;
    try { selection = window.getSelection ? window.getSelection() : null; } catch (e) {}
    if (selection && selection.anchorNode) {
      push(selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
    }
    Array.prototype.slice.call(document.querySelectorAll(EDITABLE_SELECTOR), 0, 12).forEach(push);

    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      var domDepth = 0;
      while (node && domDepth < 6) {
        var fiber = getReactFiberNode(node);
        var fiberDepth = 0;
        while (fiber && fiberDepth < 40) {
          var props = fiber.memoizedProps || {};
          var value = extractor(props);
          if (value) return value;
          fiber = fiber.return;
          fiberDepth++;
        }
        node = node.parentElement;
        domDepth++;
      }
    }
    return null;
  }

  function getStructService() {
    return findEditorApiValue(function (props) {
      return props.editorAPI && props.editorAPI.structService;
    });
  }

  function getEditorAPI() {
    return findEditorApiValue(function (props) { return props.editorAPI; });
  }

  function getDocToken() {
    var match = location.pathname.match(/\/(docx|wiki|doc|sheet|slides|base)\/([A-Za-z0-9]+)/);
    return match ? match[2] : null;
  }

  function getDocumentTitle() {
    var title = document.querySelector('title');
    return title ? title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '') : '副本';
  }

  function getEditorReadyState() {
    var root = getContentRootElement() || document.querySelector(EDITABLE_SELECTOR);
    var editorAPI = getEditorAPI();
    var structService = (editorAPI && editorAPI.structService) || getStructService();
    var hasStructAPI = !!(structService && structService.rootBlock);
    // Newer Feishu builds may have rendered content even before our React fiber
    // probes succeed, so treat a meaningful innerHTML as a usable fallback.
    var hasContentLoaded = !!(root && root.innerHTML && root.innerHTML.length > 100);
    return {
      href: location.href,
      readyState: document.readyState,
      hasContentRoot: !!root,
      contentRootTag: root ? String(root.tagName || '') : '',
      hasEditorAPI: !!editorAPI,
      hasStructService: !!structService,
      hasRootBlock: hasStructAPI,
      rootChildCount: structService && structService.rootBlock
        ? (structService.rootBlock.children ? structService.rootBlock.children.length : 0)
        : 0,
      hasContentLoaded: hasContentLoaded,
    };
  }

  // Sync the editor ready state into a DOM attribute every 500ms so the runner
  // can wait for it before issuing automation commands.
  var editorStateTimer = setInterval(function () {
    try { setDocJsonAttr('data-feishu-editor-ready-state', getEditorReadyState()); }
    catch (e) {}
  }, 500);
  registerDisposer(function () { clearInterval(editorStateTimer); });

  // ── DOM-derived callout style ──────────────────────────────────────────────

  function extractCalloutStyleFromDOM(blockId) {
    var result = { background_color: '', border_color: '' };
    try {
      var escapedId = blockId ? blockId.replace(/"/g, '\\"') : '';
      var selector = escapedId
        ? '[data-block-id="' + escapedId + '"]'
        : '[data-block-type="callout"]';
      var el = document.querySelector(selector);
      if (!el) {
        var callouts = document.querySelectorAll('.docx-callout-block, .callout-container');
        for (var i = 0; i < callouts.length; i++) {
          if (callouts[i].getAttribute('data-block-id') === blockId || !blockId) {
            el = callouts[i];
            break;
          }
        }
      }
      if (!el) return result;
      var computed = window.getComputedStyle(el);
      var bg = computed.backgroundColor;
      var brd = computed.borderColor || computed.borderLeftColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        result.background_color = styleCodec.normalizeCssRgb(bg);
      }
      if (brd && brd !== 'rgba(0, 0, 0, 0)' && brd !== 'transparent') {
        result.border_color = styleCodec.normalizeCssRgb(brd);
      }
    } catch (e) {}
    return result;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  function getTopAccessibleDocument() {
    try { if (window.top && window.top.document) return window.top.document; }
    catch (err) {}
    return document;
  }

  var __toastCapture = null;

  function beginToastCapture() {
    __toastCapture = { message: '' };
  }

  function endToastCapture() {
    var captured = __toastCapture ? __toastCapture.message : '';
    __toastCapture = null;
    return captured;
  }

  // 实时进度：把 done/total 通过 DOM 事件推给 bridge，再转发到 popup 面板。
  // phase: 'convert'（提取时转换图片）| 'upload'（粘贴时上传图片）。
  function emitUiProgress(detail) {
    try {
      document.dispatchEvent(new CustomEvent('feishu-helper:ui-progress', {
        detail: {
          phase: String((detail && detail.phase) || ''),
          done: Number((detail && detail.done) || 0),
          total: Number((detail && detail.total) || 0),
          label: String((detail && detail.label) || ''),
        },
      }));
    } catch (err) {}
  }


  function showToast(msg, duration) {
    // 已全面迁移到扩展：所有反馈集成到 popup 面板，不再在页面上渲染浮层 toast。
    // 捕获窗口开启时把文案回传给面板；其余情况仅写 console，供调试。
    var text = String(msg == null ? '' : msg);
    if (__toastCapture) {
      __toastCapture.message = text;
    }
    console.info('[Feishu Helper]', text);
  }

  // ── Pending paste storage (IndexedDB + GM_* shared) ────────────────────────

  function clonePendingPasteData(data) {
    if (!data || typeof data !== 'object') return null;
    try { return JSON.parse(JSON.stringify(data)); }
    catch (e) { return null; }
  }

  function isPendingPasteFresh(data) {
    return !!(data && data.ts && Date.now() - data.ts < 3600000);
  }

  function canUseSharedPendingPasteStorage() {
    return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  }

  function getSharedPendingPaste() {
    if (!canUseSharedPendingPasteStorage()) return null;
    try { return clonePendingPasteData(GM_getValue(SHARED_PENDING_PASTE_KEY, null)); }
    catch (e) { return null; }
  }

  function setSharedPendingPaste(data) {
    if (!canUseSharedPendingPasteStorage()) return;
    try { GM_setValue(SHARED_PENDING_PASTE_KEY, clonePendingPasteData(data)); }
    catch (e) {}
  }

  function deleteSharedPendingPaste() {
    if (typeof GM_deleteValue !== 'function') return;
    try { GM_deleteValue(SHARED_PENDING_PASTE_KEY); }
    catch (e) {}
  }

  function requestExtensionPendingPaste(op, value) {
    return new Promise(function (resolve) {
      var requestId = 'pending-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var timer = setTimeout(function () {
        document.removeEventListener(EXTENSION_PENDING_PASTE_RESULT_EVENT, onResult, true);
        resolve(null);
      }, 2000);
      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener(EXTENSION_PENDING_PASTE_RESULT_EVENT, onResult, true);
        resolve(detail && detail.ok ? detail.value || null : null);
      }
      document.addEventListener(EXTENSION_PENDING_PASTE_RESULT_EVENT, onResult, true);
      try {
        document.dispatchEvent(new CustomEvent(EXTENSION_PENDING_PASTE_EVENT, {
          detail: { requestId: requestId, op: op, value: value || null },
        }));
      } catch (error) {
        clearTimeout(timer);
        document.removeEventListener(EXTENSION_PENDING_PASTE_RESULT_EVENT, onResult, true);
        resolve(null);
      }
    });
  }

  function getExtensionPendingPaste() {
    return requestExtensionPendingPaste('get').then(clonePendingPasteData);
  }

  function setExtensionPendingPaste(data) {
    return requestExtensionPendingPaste('set', clonePendingPasteData(data));
  }

  function deleteExtensionPendingPaste() {
    return requestExtensionPendingPaste('delete');
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getLocalPendingPaste() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(DB_KEY);
        req.onsuccess = function () {
          var data = req.result;
          if (isPendingPasteFresh(data)) {
            resolve(data);
          } else {
            if (data) {
              var dtx = db.transaction(DB_STORE, 'readwrite');
              dtx.objectStore(DB_STORE).delete(DB_KEY);
            }
            resolve(null);
          }
        };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function setLocalPendingPaste(data) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(data, DB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // The page IndexedDB, legacy GM cache and extension cache may all contain
  // stale entries; pick the freshest one, then mirror it back so both sides agree.
  function getPendingPaste() {
    return getLocalPendingPaste().then(function (localData) {
      return getExtensionPendingPaste().then(function (extensionData) {
        var sharedData = getSharedPendingPaste();
        if (!isPendingPasteFresh(sharedData)) {
          if (sharedData) deleteSharedPendingPaste();
          sharedData = null;
        }
        if (!isPendingPasteFresh(extensionData)) {
          if (extensionData) deleteExtensionPendingPaste();
          extensionData = null;
        }
        var chosen = localData;
        if (sharedData && (!chosen || Number(sharedData.ts || 0) > Number(chosen.ts || 0))) {
          chosen = sharedData;
        }
        if (extensionData && (!chosen || Number(extensionData.ts || 0) > Number(chosen.ts || 0))) {
          chosen = extensionData;
        }
        if (!chosen) return ensureUploadedTokenMapMatchesPending(null);
        setSharedPendingPaste(chosen);
        return Promise.all([
          chosen === localData ? Promise.resolve() : setLocalPendingPaste(chosen).catch(function () {}),
          chosen === extensionData ? Promise.resolve() : setExtensionPendingPaste(chosen).catch(function () {}),
        ]).then(function () {
          return ensureUploadedTokenMapMatchesPending(chosen);
        });
      });
    }).catch(function () { return null; });
  }

  function setPendingPaste(data) {
    data.ts = Date.now();
    data.savedFromHost = location.host;
    data.savedFromHref = location.href;
    setDocAttr('data-feishu-pending-paste-ts', String(data.ts));
    setSharedPendingPaste(data);
    return Promise.all([
      setLocalPendingPaste(data).catch(function () {}),
      setExtensionPendingPaste(data).catch(function () {}),
    ]).then(function () {});
  }
