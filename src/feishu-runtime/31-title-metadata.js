  // ── Document title DOM adapter ─────────────────────────────────────────────

  function getEditableText(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  function setEditableText(el, text) {
    if (!el) return false;
    try {
      try {
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (err) {}
      try { el.click(); } catch (err) {}
      el.focus();
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
      } else {
        var selection = window.getSelection && window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(el);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        var inserted = false;
        if (document.execCommand) {
          try { document.execCommand('delete', false, null); } catch (err) {}
          try { inserted = document.execCommand('insertText', false, text); } catch (err) {}
        }
        if (!inserted) {
          el.textContent = text;
        }
      }
      ['beforeinput', 'input'].forEach(function (type) {
        el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      });
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return normalizePasteTitle(getEditableText(el)) === normalizePasteTitle(text);
    } catch (error) {
      return false;
    }
  }

  function isTemplateSearchInput(node) {
    if (!node || node.tagName !== 'INPUT') return false;
    var haystack = [
      node.className,
      node.getAttribute && node.getAttribute('placeholder'),
      node.getAttribute && node.getAttribute('aria-label'),
    ].join(' ');
    return /模板|template/i.test(haystack);
  }

  function clearTemplateSearchTitleEcho(title) {
    var cleanTitle = normalizePasteTitle(title);
    if (!cleanTitle) return;
    Array.prototype.slice.call(document.querySelectorAll('input'), 0, 80).forEach(function (input) {
      if (!isTemplateSearchInput(input)) return;
      if (normalizePasteTitle(input.value) !== cleanTitle) return;
      try {
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
      } catch (err) {
        input.value = '';
      }
      try { input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null })); } catch (err) {}
      try { input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch (err) {}
      try { input.blur(); } catch (err) {}
    });
  }

  function isVisibleHeaderTitleNode(node) {
    if (!node) return false;
    var contentRoot = getContentRootElement();
    if (contentRoot && contentRoot.contains(node)) return false;
    var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0, top: 9999 };
    return rect.width >= 40 && rect.height >= 12 && rect.top >= 0 && rect.top < 120;
  }

  function isHeaderTitleRenameInput(node) {
    if (!node || (node.tagName !== 'INPUT' && node.tagName !== 'TEXTAREA')) return false;
    if (isTemplateSearchInput(node)) return false;
    var contentRoot = getContentRootElement();
    if (contentRoot && contentRoot.contains(node)) return false;
    var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0, top: 9999 };
    if (rect.width < 120 || rect.height < 16 || rect.top < 0 || rect.top > 140) return false;
    var haystack = [
      node.className,
      node.getAttribute && node.getAttribute('placeholder'),
      node.getAttribute && node.getAttribute('aria-label'),
      node.getAttribute && node.getAttribute('data-placeholder'),
    ].join(' ');
    return /标题|title|document-name|doc-name/i.test(haystack);
  }

  function findHeaderTitleRenameInput() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea'), 0, 120);
    return inputs.find(isHeaderTitleRenameInput) || null;
  }

  function findHeaderTitleDisplay() {
    var selectors = [
      '.wiki-suite-title .breadcrumb-editable-title',
      '.breadcrumb-editable-title',
      '.note-title__input.disabled',
      '.header-ssr-layout-component-Title',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]), 0, 20);
      for (var j = 0; j < nodes.length; j++) {
        if (isVisibleHeaderTitleNode(nodes[j])) return nodes[j];
      }
    }
    return null;
  }

  function openHeaderTitleRenameInput() {
    var existing = findHeaderTitleRenameInput();
    if (existing) return Promise.resolve(existing);
    var display = findHeaderTitleDisplay();
    if (!display) return Promise.resolve(null);
    try { display.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) {}
    try { display.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window })); } catch (err) {}
    try { display.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, detail: 1 })); } catch (err) {}
    try { display.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, detail: 1 })); } catch (err) {}
    try { display.click(); } catch (err) {}
    try { display.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 })); } catch (err) {}
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(findHeaderTitleRenameInput()); }, 180);
    });
  }

  function commitHeaderTitleRenameInput(editor) {
    if (!editor) return;
    try {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    } catch (err) {}
    try { editor.blur(); } catch (err) {}
  }

  function closeHeaderTitleRenameInput() {
    var editor = findHeaderTitleRenameInput();
    if (!editor) return false;
    commitHeaderTitleRenameInput(editor);
    try {
      var selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
    } catch (err) {}
    try {
      var bodyTarget = getContentRootElement();
      if (bodyTarget && typeof bodyTarget.focus === 'function') bodyTarget.focus();
    } catch (err) {}
    return true;
  }

  function applyDocumentTitleToCurrentDoc(title) {
    var cleanTitle = normalizePasteTitle(title);
    if (!cleanTitle) return Promise.resolve(false);
    return openHeaderTitleRenameInput().then(function (editor) {
      if (!editor || !setEditableText(editor, cleanTitle)) return false;
      commitHeaderTitleRenameInput(editor);
      clearTemplateSearchTitleEcho(cleanTitle);
      return waitForDocumentTitleApplied(cleanTitle, 1200).then(function (applied) {
        clearTemplateSearchTitleEcho(cleanTitle);
        closeHeaderTitleRenameInput();
        return applied;
      });
    });
  }

  function getCurrentDocumentTitleForPaste() {
    var title = String(document.title || '')
      .replace(/ - 飞书云文档$/, '')
      .replace(/ - Lark$/, '');
    return normalizePasteTitle(title);
  }

  function waitForDocumentTitleApplied(title, timeoutMs) {
    var cleanTitle = normalizePasteTitle(title);
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      function tick() {
        if (getCurrentDocumentTitleForPaste() === cleanTitle) {
          setTimeout(function () { resolve(true); }, 60);
          return;
        }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          resolve(false);
          return;
        }
        setTimeout(tick, 80);
      }
      tick();
    });
  }

  function saveCurrentSelection() {
    var selection = window.getSelection && window.getSelection();
    var ranges = [];
    if (selection) {
      for (var i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    }
    return { activeElement: document.activeElement, ranges: ranges };
  }

  function restoreCurrentSelection(saved) {
    if (!saved) return;
    try {
      if (saved.activeElement && typeof saved.activeElement.focus === 'function') saved.activeElement.focus();
      var selection = window.getSelection && window.getSelection();
      if (selection && saved.ranges && saved.ranges.length) {
        selection.removeAllRanges();
        saved.ranges.forEach(function (range) { selection.addRange(range); });
      }
    } catch (error) {}
  }
