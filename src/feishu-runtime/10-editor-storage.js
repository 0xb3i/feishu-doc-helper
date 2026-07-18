  // ── Editor element discovery ───────────────────────────────────────────────

  function isSupportedDocumentPage() {
    return location.protocol === 'https:' && /^\/(?:docx|wiki|doc)\/[A-Za-z0-9]+(?:[/?#]|$)/.test(location.pathname + location.search + location.hash);
  }

  function isVisibleElement(el) {
    if (!el || el.nodeType !== 1 || typeof el.getBoundingClientRect !== 'function') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

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

  function pickDocumentBodyEditor() {
    var shell = document.querySelector('[data-content-editable-root="true"].page-block, [data-content-editable-root="true"].root-block, .page-block.root-block');
    if (!shell || typeof shell.getBoundingClientRect !== 'function') return null;
    var shellRect = shell.getBoundingClientRect();
    var candidates = Array.prototype.slice.call(shell.querySelectorAll('.zone-container.text-editor[contenteditable="true"]'), 0, 24)
      .filter(function (node) {
        if (!isVisibleElement(node) || typeof node.getBoundingClientRect !== 'function') return false;
        var rect = node.getBoundingClientRect();
        return rect.top > shellRect.top + 120;
      });
    return candidates.length ? pickBestNode(candidates) : null;
  }

  function getContentRootElement() {
    if (!isSupportedDocumentPage()) return null;
    var bodyEditor = pickDocumentBodyEditor();
    if (bodyEditor) return bodyEditor;
    var nodes = Array.prototype.slice.call(document.querySelectorAll(CONTENT_ROOT_SELECTOR), 0, 24)
      .filter(function (node) {
        if (!isVisibleElement(node)) return false;
        if (node.matches('.page-block, .root-block, .editor-kit-container')) return true;
        return !!node.querySelector('[data-block-type], .zone-container.text-editor[contenteditable="true"]');
      });
    return pickBestNode(nodes);
  }

  function normalizeVisibleEditorText(text) {
    return String(text || '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisibleDocumentBodyEmpty() {
    var shell = document.querySelector('[data-content-editable-root="true"].page-block, [data-content-editable-root="true"].root-block, .page-block.root-block');
    var root = shell || getContentRootElement();
    if (!root) return false;
    var bodyEditors = shell
      ? Array.prototype.slice.call(shell.querySelectorAll('.zone-container.text-editor[contenteditable="true"]'), 0, 120)
      : (root.matches && root.matches('.zone-container.text-editor') ? [root] : []);
    if (!bodyEditors.length) return false;
    for (var i = 0; i < bodyEditors.length; i++) {
      var editor = bodyEditors[i];
      if (!isVisibleElement(editor)) continue;
      if (normalizeVisibleEditorText(editor.innerText || editor.textContent || '')) return false;
    }
    var meaningfulNodes = root.querySelectorAll([
      'img',
      'table',
      'blockquote',
      'pre',
      'hr',
      '[data-block-type="image"]',
      '[data-block-type="table"]',
      '[data-block-type="callout"]',
      '.docx-callout-block',
      '.callout-container',
      '.callout-block',
      '[class*="code-block"]',
      '[class*="whiteboard"]',
    ].join(','));
    return meaningfulNodes.length === 0;
  }

  function getValidationSurfaceElement() {
    var contentRoot = getContentRootElement();
    if (contentRoot) return contentRoot;
    return document.querySelector('.page-block.root-block, [data-content-editable-root="true"].page-block') || null;
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
    var contentRoot = getContentRootElement();
    function push(node) {
      if (!node || node.nodeType !== 1 || candidates.indexOf(node) !== -1) return;
      if (contentRoot && node !== contentRoot && !contentRoot.contains(node)) return;
      candidates.push(node);
    }
    push(contentRoot);
    push(document.activeElement);
    var selection = null;
    try { selection = window.getSelection ? window.getSelection() : null; } catch (e) {}
    if (selection && selection.anchorNode) {
      push(selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
    }
    if (contentRoot) Array.prototype.slice.call(contentRoot.querySelectorAll(EDITABLE_SELECTOR), 0, 12).forEach(push);

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
    var match = location.pathname.match(/\/(docx|wiki|doc)\/([A-Za-z0-9]+)/);
    return match ? match[2] : null;
  }

  function normalizeDocumentTitleText(text) {
    return String(text || '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*(最近修改:.*|已经保存到云端.*|分享\s*编辑.*|分享.*)$/i, '')
      .trim();
  }

  function isPlaceholderDocumentTitle(text) {
    var value = normalizeDocumentTitleText(text);
    return !value || /^(飞书云文档|Lark|未命名文档|Untitled)$/i.test(value);
  }

  function getDocumentTitleFromDom() {
    var selectors = [
      '.note-title__input.disabled',
      '.header-ssr-layout-component-Title',
      '.wiki-suite-title .breadcrumb-editable-title',
      '.breadcrumb-editable-title',
      'h1.page-block-content:not(.page-block-title-empty)',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var title = normalizeDocumentTitleText(nodes[j].innerText || nodes[j].textContent || '');
        if (!isPlaceholderDocumentTitle(title)) return title;
      }
    }
    return '';
  }

  function getDocumentTitle() {
    var domTitle = getDocumentTitleFromDom();
    if (domTitle) return domTitle;
    var title = document.querySelector('title');
    var text = title ? normalizeDocumentTitleText(title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '')) : '';
    return isPlaceholderDocumentTitle(text) ? '副本' : text;
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
