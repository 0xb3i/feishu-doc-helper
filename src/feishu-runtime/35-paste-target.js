  // ── Editor target discovery & paste dispatch ───────────────────────────────

  function isEditableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!el.matches(EDITABLE_SELECTOR)) return false;
    var root = getContentRootElement();
    return !!(root && (el === root || root.contains(el)));
  }
  function isHiddenPasteTextarea(el) {
    return !!(el && el.nodeType === 1 && el.matches(HIDDEN_PASTE_TEXTAREA_SELECTOR));
  }

  function closestEditableElement(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el) {
      if (isEditableElement(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function getEditableCandidateScore(el, options) {
    if (!el) return -Infinity;
    var purpose = (options && options.purpose) || 'insert';
    var score = 0;
    var selection = window.getSelection && window.getSelection();
    var className = String(el.className || '');

    if (isHiddenPasteTextarea(el)) {
      return purpose === 'paste' && el === document.activeElement ? 1300 : -Infinity;
    }

    if (el.getAttribute('data-content-editable-root') === 'true') score += purpose === 'paste' ? 420 : 100;
    else score += purpose === 'paste' ? 160 : 300;

    if (/zone-container|editor-kit-container|text-editor/.test(className)) score += 80;
    if (el === document.activeElement) score += 240;
    if (selection) {
      var anchorNode = selection.anchorNode;
      var focusNode = selection.focusNode;
      if ((anchorNode && el.contains(anchorNode)) || (focusNode && el.contains(focusNode))) score += 160;
    }
    var rect = el.getBoundingClientRect();
    score += Math.min(Math.round(rect.height), 120);
    if (rect.top >= 0) score += 40;
    return score;
  }

  function getEditableCandidates(options) {
    var config = options || {};
    var includeHiddenTextarea = !!config.includeHiddenTextarea;
    var seen = new Set();
    var result = [];

    function push(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      result.push(el);
    }

    if (includeHiddenTextarea && isHiddenPasteTextarea(document.activeElement)) push(document.activeElement);
    push(closestEditableElement(document.activeElement));
    var selection = window.getSelection && window.getSelection();
    if (selection) {
      push(closestEditableElement(selection.anchorNode));
      push(closestEditableElement(selection.focusNode));
    }
    if (includeHiddenTextarea && isHiddenPasteTextarea(document.activeElement)) {
      document.querySelectorAll(HIDDEN_PASTE_TEXTAREA_SELECTOR).forEach(push);
    }
    document.querySelectorAll(EDITABLE_SELECTOR).forEach(push);

    return result.filter(function (el) {
      if (isHiddenPasteTextarea(el)) return includeHiddenTextarea;
      return isVisibleElement(el);
    }).sort(function (left, right) {
      return getEditableCandidateScore(right, config) - getEditableCandidateScore(left, config);
    });
  }

  function getActivePasteDispatchTarget() {
    var candidates = getEditableCandidates({ purpose: 'paste', includeHiddenTextarea: true });
    return candidates.length ? candidates[0] : null;
  }

  function getDocumentBodyPasteTarget() {
    var root = getContentRootElement();
    if (root && isVisibleElement(root)) return root;
    var candidates = getEditableCandidates({ purpose: 'paste', includeHiddenTextarea: false });
    return candidates.length ? candidates[0] : null;
  }

  function ensureEditorSelection(editor) {
    var selection = window.getSelection && window.getSelection();
    if (!selection) return;
    if (selection.rangeCount > 0) {
      var range = selection.getRangeAt(0);
      var anchorNode = range.commonAncestorContainer;
      if (editor.contains(anchorNode) || anchorNode === editor) return;
    }
    var newRange = document.createRange();
    newRange.selectNodeContents(editor);
    newRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }

  function preparePasteTarget(target) {
    if (!target) return false;
    try {
      if (!isHiddenPasteTextarea(target) && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (err) {}
    try { target.focus(); } catch (err) {}
    if (isHiddenPasteTextarea(target)) {
      try {
        var currentValue = typeof target.value === 'string' ? target.value : '';
        target.setSelectionRange(currentValue.length, currentValue.length);
      } catch (err) {}
      return true;
    }
    try { target.click(); } catch (err) {}
    ensureEditorSelection(target);
    return true;
  }

  function focusDocumentBodyForPaste() {
    var target = getDocumentBodyPasteTarget();
    if (!target) return false;
    return preparePasteTarget(target);
  }

  function extractInsertionHtml(html) {
    if (!html) return '';
    var fragmentMatch = html.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i);
    if (fragmentMatch) return fragmentMatch[1];
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      return doc && doc.body ? doc.body.innerHTML : html;
    } catch (err) {
      return html;
    }
  }

  function insertHtmlFragmentIntoEditor(editor, htmlFragment, textFallback) {
    if (!editor || !htmlFragment) return false;
    editor.focus();
    ensureEditorSelection(editor);
    var selection = window.getSelection && window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    var range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== editor) {
      ensureEditorSelection(editor);
      if (!selection.rangeCount) return false;
      range = selection.getRangeAt(0);
    }
    try {
      var fragment = range.createContextualFragment(htmlFragment);
      var lastNode = fragment.lastChild;
      range.deleteContents();
      range.insertNode(fragment);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      try {
        editor.dispatchEvent(new InputEvent('input', {
          inputType: 'insertFromPaste',
          bubbles: true,
          cancelable: false,
          data: textFallback || '',
        }));
      } catch (err) {}
      return true;
    } catch (err) {
      return false;
    }
  }

  function tryInsertPayloadIntoEditor(payload) {
    if (payloadRequiresPasteParsing(payload)) return null;
    var htmlFragment = extractInsertionHtml((payload && payload.html) || '');
    var text = (payload && payload.text) || '';
    var candidates = getEditableCandidates({ purpose: 'insert', includeHiddenTextarea: false });

    for (var i = 0; i < candidates.length; i++) {
      var editor = candidates[i];
      if (!editor) continue;
      preparePasteTarget(editor);

      if (htmlFragment) {
        try {
          if (document.execCommand('insertHTML', false, htmlFragment)) {
            return { mode: 'insertHTML', editor: editor };
          }
        } catch (err) {}
        if (insertHtmlFragmentIntoEditor(editor, htmlFragment, text)) {
          return { mode: 'domInsert', editor: editor };
        }
      }
      if (text) {
        try {
          if (document.execCommand('insertText', false, text)) {
            return { mode: 'insertText', editor: editor };
          }
        } catch (err) {}
      }
    }
    return null;
  }

  function dispatchPastePayload(payload) {
    var target = getActivePasteDispatchTarget();
    if (!target) return false;
    preparePasteTarget(target);
    var dt = new DataTransfer();
    if (payload && payload.text) dt.setData('text/plain', payload.text);
    if (payload && payload.html) dt.setData('text/html', payload.html);
    if (payload && payload.docxRecord) dt.setData('docx/record', payload.docxRecord);
    try {
      var beforeInputEvent = new InputEvent('beforeinput', {
        inputType: 'insertFromPaste',
        bubbles: true,
        cancelable: true,
        data: (payload && payload.text) || '',
      });
      Object.defineProperty(beforeInputEvent, 'dataTransfer', { value: dt });
      target.dispatchEvent(beforeInputEvent);
    } catch (err) {}
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }

  function describePasteMode(mode) {
    if (mode === 'insertHTML') return '直接插入 HTML';
    if (mode === 'domInsert') return '直接写入 DOM';
    if (mode === 'insertText') return '直接插入纯文本';
    if (mode === 'pasteEvent') return '派发 paste 事件';
    return '仅写入剪贴板';
  }

  function runPasteAttempt(payload, options) {
    var insertResult = options.allowInsert ? tryInsertPayloadIntoEditor(payload) : null;
    var autoInserted = !!insertResult;
    var autoPasted = autoInserted ? false : (!!options.allowDispatch && dispatchPastePayload(payload));
    return {
      autoInserted: autoInserted,
      autoPasted: autoPasted,
      pathLabel: describePasteMode(insertResult ? insertResult.mode : (autoPasted ? 'pasteEvent' : 'clipboardOnly')),
    };
  }

  function showPasteResultToast(status, needsParser, clipboardWritten) {
    if (clipboardWritten) {
      if (needsParser) {
        showToast('📋 v' + SCRIPT_VERSION + ' 已写入剪贴板；检测到公式，请直接按 Cmd+V 走飞书原生粘贴解析', 4300);
      } else if (status.autoInserted) {
        showToast('✅ v' + SCRIPT_VERSION + ' 已通过"' + status.pathLabel + '"插入内容，并已写入剪贴板', 3600);
      } else if (status.autoPasted) {
        showToast('✅ v' + SCRIPT_VERSION + ' 已通过"' + status.pathLabel + '"尝试粘贴，并已写入剪贴板；若没生效再按 Cmd+V', 4200);
      } else {
        showToast('📋 v' + SCRIPT_VERSION + ' 当前走的是"' + status.pathLabel + '"，请按 Cmd+V 粘贴', 3800);
      }
      return;
    }
    if (status.autoInserted) {
      showToast('✅ v' + SCRIPT_VERSION + ' 已通过"' + status.pathLabel + '"插入内容', 3200);
    } else if (status.autoPasted) {
      showToast('✅ v' + SCRIPT_VERSION + ' 已通过"' + status.pathLabel + '"尝试粘贴' + (needsParser ? '；检测到公式，若仍未渲染请再按 Cmd+V' : '；若没生效再按 Cmd+V'), 4200);
    } else {
      showToast('⚠️ v' + SCRIPT_VERSION + ' 未找到可直接粘贴的编辑器，只能走"' + status.pathLabel + '"但写剪贴板也失败了' + (needsParser ? '；当前内容含公式' : ''), 4300);
    }
  }
