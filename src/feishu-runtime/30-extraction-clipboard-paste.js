  // ── Document extraction (struct-service driven, DOM fallback) ──────────────

  function countDocumentImagesInRoot(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    return root.querySelectorAll('img[src*="/space/api/box/stream/download/"]').length;
  }

  function countDocumentImagesInHtml(html) {
    return (String(html || '').match(/<img\b[^>]+src=["'][^"']*\/space\/api\/box\/stream\/download\//gi) || []).length;
  }

  function countFallbackEquationNodes(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    return Math.max(
      root.querySelectorAll('.editor-kit-equation-block').length,
      root.querySelectorAll('.docx-equation-block.equation-leaf').length,
      root.querySelectorAll('.katex').length,
      root.querySelectorAll('[data-latex]').length,
      0
    );
  }

  function countExtractedImages(content) {
    var c = content || {};
    var markdownCount = (String(c.text || '').match(/!\[/g) || []).length;
    return markdownCount > 0 ? markdownCount : countDocumentImagesInHtml(c.html);
  }

  function buildSemanticSnapshotForRoot(rootBlock, surface) {
    var primary = snapshotCollector.collectFromStructService(rootBlock, {
      calloutStyleResolver: extractCalloutStyleFromDOM,
      getDocument: function () { return document; },
    });
    var fallback = snapshotCollector.collectFromDom(surface);
    return snapshotCollector.mergeSemanticSnapshots(primary, fallback);
  }

  function extractVisibleDomFallback() {
    var root = getValidationSurfaceElement() || getContentRootElement() || document.querySelector(EDITABLE_SELECTOR) || document.body;
    if (!root) return null;
    var text = attribs.normalizePlainText(root.innerText || root.textContent || '');
    var html = sanitizer.finalizeHtmlFragment(root.innerHTML || '');
    if (!text && !html) return null;
    var blockCount = text ? text.split('\n').filter(function (line) { return line.trim(); }).length : 0;
    var fallbackEquationCount = countFallbackEquationNodes(root) || (text.match(/\$/g) || []).length;
    return {
      html: html || '<p>' + attribs.escapeHtml(text).replace(/\n/g, '<br>') + '</p>',
      text: text,
      blockCount: Math.max(1, blockCount),
      equationCount: fallbackEquationCount,
    };
  }

  function extractFullDoc() {
    var ss = getStructService();
    if (!ss || !ss.rootBlock) return extractVisibleDomFallback();

    var rendered = renderer.renderRootBlock(ss.rootBlock, {
      calloutStyleResolver: extractCalloutStyleFromDOM,
      locationOrigin: location.origin,
      maxDepth: MAX_BLOCK_DEPTH,
    });
    var finalHtml = sanitizer.finalizeHtmlFragment(rendered.htmlParts.join('\n'));
    var finalText = attribs.normalizePlainText(rendered.mdParts.join('\n'));
    if (!rendered.blockCount && !finalText && !finalHtml) {
      return extractVisibleDomFallback();
    }
    var docxRecordPayload = renderer.buildDocxRecordPayload(ss.rootBlock, { maxDepth: MAX_BLOCK_DEPTH });
    return {
      html: finalHtml,
      text: finalText,
      blockCount: rendered.blockCount,
      equationCount: rendered.equationCount,
      docxRecord: docxRecordPayload ? JSON.stringify(docxRecordPayload) : '',
    };
  }

  function captureValidationSnapshot() {
    var content = extractFullDoc();
    if (!content) return null;
    var ss = getStructService();
    var surface = getValidationSurfaceElement() || getContentRootElement() || document.querySelector(EDITABLE_SELECTOR) || document.body;
    var snapshot = {
      title: getDocumentTitle(),
      text: String(content.text || ''),
      textLength: String(content.text || '').length,
      htmlLength: String(content.html || '').length,
      blockCount: Number(content.blockCount || 0),
      equationCount: Number(content.equationCount || 0),
      semanticSnapshot: ss && ss.rootBlock
        ? buildSemanticSnapshotForRoot(ss.rootBlock, surface)
        : snapshotCollector.collectFromDom(surface),
    };
    setDocJsonAttr('data-feishu-validation-snapshot', {
      title: snapshot.title,
      blockCount: snapshot.blockCount,
      equationCount: snapshot.equationCount,
      textLength: snapshot.textLength,
      htmlLength: snapshot.htmlLength,
      semanticSnapshot: snapshot.semanticSnapshot,
    });
    return snapshot;
  }

  // ── Clipboard payload assembly ─────────────────────────────────────────────

  function buildClipboardPayload(content) {
    var text = (content && content.text) || '';
    var preparedHtml = (content && content.clipboardHtml) || '';
    var html = (content && content.html) || '';
    var docxRecordRaw = (content && content.docxRecord) || '';

    if (preparedHtml) {
      return Promise.resolve({ text: text, html: preparedHtml, docxRecord: docxRecordRaw });
    }
    if (!html) {
      return Promise.resolve({ text: text, html: '', docxRecord: docxRecordRaw });
    }

    var docxRecordObj = null;
    try { docxRecordObj = docxRecordRaw ? JSON.parse(docxRecordRaw) : null; }
    catch (e) {}

    return convertImagesToBase64(html).then(function (result) {
      var htmlWithImages = result.html;
      var tokenToBase64 = result.tokenToBase64 || {};

      // Build the ordered image list by walking the recordMap directly so
      // images nested inside table cells / grid columns are picked up.
      var orderedImageBase64List = [];
      if (docxRecordObj) {
        docxRecord.listImageRecords(docxRecordObj).forEach(function (entry) {
          var token = entry.image.token || '';
          var base64 = tokenToBase64[token] || '';
          orderedImageBase64List.push({
            token: token,
            base64: base64,
            width: entry.image.width || 0,
            height: entry.image.height || 0,
          });
        });
      }

      // Fallback: when we have base64 but couldn't tie them to a record
      // (e.g. DOM-only fallback), still surface the tokens for injection.
      if (!orderedImageBase64List.length && Object.keys(tokenToBase64).length) {
        Object.keys(tokenToBase64).forEach(function (token) {
          orderedImageBase64List.push({
            token: token,
            base64: tokenToBase64[token],
            width: 0,
            height: 0,
          });
        });
      }

      // Image blocks in docxRecord without matching base64 (e.g. nested in
      // table cells whose <img> isn't part of the rendered fragment) need a
      // direct fetch using the raw token so the upload-and-replace flow has
      // image data to send to the server.
      var fetchMissingChain = Promise.resolve();
      orderedImageBase64List.forEach(function (img) {
        if (!img.token || img.base64) return;
        fetchMissingChain = fetchMissingChain.then(function () {
          var urls = [
            '/space/api/box/stream/download/all/?token=' + encodeURIComponent(img.token),
            '/space/api/box/stream/download/preview/' + encodeURIComponent(img.token) + '/?preview_type=16',
          ];
          function tryFetch(index) {
            if (index >= urls.length) return Promise.resolve(null);
            return fetchImageAsBase64(urls[index]).then(function (b64) {
              return b64 || tryFetch(index + 1);
            });
          }
          return tryFetch(0).then(function (base64) {
            if (base64) img.base64 = base64;
          });
        });
      });

      return fetchMissingChain.then(function () {
        var hasImages = orderedImageBase64List.length > 0;
        return {
          text: text,
          html: sanitizer.buildClipboardHtml(htmlWithImages, false),
          docxRecord: docxRecordObj ? JSON.stringify(docxRecordObj) : '',
          hasDowngradedImages: false,
          hasImagesToInject: hasImages,
          hasImagesToUpload: hasImages,
          orderedImageBase64List: orderedImageBase64List,
          originalDocxRecordObj: docxRecordObj,
        };
      });
    }).catch(function () {
      return {
        text: text,
        html: sanitizer.buildClipboardHtml(html, false),
        docxRecord: docxRecordRaw,
      };
    });
  }

  function payloadHasFeishuStructuredHtml(payload) {
    var html = (payload && payload.html) || '';
    var hasDocxRecord = !!(payload && payload.docxRecord);
    if (!html && !hasDocxRecord) return false;
    return /data-docx-has-block-data="true"/i.test(html) && hasDocxRecord;
  }

  function payloadHasDowngradedImages(payload) {
    return /data-feishu-downgraded-images="true"/i.test((payload && payload.html) || '');
  }

  function getPastePayloadHandlingMode(payload) {
    var text = (payload && payload.text) || '';
    var html = (payload && payload.html) || '';
    var source = text + '\n' + html;
    var hasFeishuStructuredHtml = payloadHasFeishuStructuredHtml(payload);
    var requiresNativeParsing = !hasFeishuStructuredHtml && (
      /^\s*>\s*\[!(NOTE|WARNING|TIP|CAUTION|IMPORTANT|SUCCESS|INFO)\]/mi.test(source)
      || /(^|[^\\])\$\$?[\s\S]+?\$\$?/.test(source)
      || /\\\([\s\S]+?\\\)/.test(source)
      || /\\\[[\s\S]+?\\\]/.test(source)
    );

    if (hasFeishuStructuredHtml && payloadHasDowngradedImages(payload)) {
      return { mode: 'nativePaste', requiresNativeParsing: true };
    }
    if (hasFeishuStructuredHtml) {
      return { mode: 'dispatchPasteEvent', requiresNativeParsing: false };
    }
    return {
      mode: requiresNativeParsing ? 'nativePaste' : 'autoDispatch',
      requiresNativeParsing: requiresNativeParsing,
    };
  }

  function payloadRequiresPasteParsing(payload) {
    return getPastePayloadHandlingMode(payload).requiresNativeParsing;
  }

  function shouldAutoDispatchPastePayload(payload) {
    return getPastePayloadHandlingMode(payload).mode !== 'nativePaste';
  }

  function resolvePastePayload(content) {
    var prepared = {
      text: (content && content.text) || '',
      html: (content && content.clipboardHtml) || '',
      docxRecord: (content && content.docxRecord) || '',
    };
    if (prepared.html || !(content && content.html)) return Promise.resolve(prepared);
    return buildClipboardPayload(content);
  }

  // ── Clipboard write ────────────────────────────────────────────────────────

  function writeClipboardPayloadWithExecCommand(payload) {
    return new Promise(function (resolve, reject) {
      var handled = false;
      function onCopy(e) {
        handled = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.clipboardData) {
          if (payload.text) e.clipboardData.setData('text/plain', payload.text);
          if (payload.html) e.clipboardData.setData('text/html', payload.html);
          if (payload.docxRecord) e.clipboardData.setData('docx/record', payload.docxRecord);
        }
      }
      document.addEventListener('copy', onCopy, true);
      try {
        var ok = document.execCommand('copy');
        document.removeEventListener('copy', onCopy, true);
        if (handled || ok) { resolve(); return; }
      } catch (err) {
        document.removeEventListener('copy', onCopy, true);
      }
      reject(new Error('execCommand copy failed'));
    });
  }

  function writeClipboardPayload(payload) {
    var data = {};
    if (payload.text) data['text/plain'] = new Blob([payload.text], { type: 'text/plain' });
    if (payload.html) data['text/html'] = new Blob([payload.html], { type: 'text/html' });
    if (payload.docxRecord) data['docx/record'] = new Blob([payload.docxRecord], { type: 'text/plain' });
    if (!Object.keys(data).length) return Promise.reject(new Error('clipboard payload empty'));

    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      return navigator.clipboard.write([new ClipboardItem(data)]).catch(function () {
        return writeClipboardPayloadWithExecCommand(payload);
      });
    }
    return writeClipboardPayloadWithExecCommand(payload);
  }

  // ── Editor target discovery & paste dispatch ───────────────────────────────

  function isEditableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.matches(EDITABLE_SELECTOR);
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

  function isVisibleElement(el) {
    if (!el || el.nodeType !== 1) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getEditableCandidateScore(el, options) {
    if (!el) return -Infinity;
    var purpose = (options && options.purpose) || 'insert';
    var score = 0;
    var selection = window.getSelection && window.getSelection();
    var className = String(el.className || '');

    if (isHiddenPasteTextarea(el)) {
      score += purpose === 'paste' ? 1000 : -1000;
      if (el === document.activeElement) score += 300;
      return score;
    }

    if (el.getAttribute('data-content-editable-root') === 'true') score += 100;
    else score += 300;

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
    if (includeHiddenTextarea) {
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

  // ── Unified paste pipeline ─────────────────────────────────────────────────

  // commitPaste handles every "we have a pendingPaste, write the clipboard,
  // optionally upload images, replace tokens, dispatch the paste".  Both the
  // user-driven Cmd+Shift+P shortcut and the runner-driven
  // `feishu-prepare-native-paste` event funnel through here.
  function commitPaste(content, options) {
    var opts = options || {};
    var hasImagesToUpload = !!(content.orderedImageBase64List && content.orderedImageBase64List.length)
      && Object.keys(uploadedTokenMap).length === 0;

    var pipeline = Promise.resolve(content);

    if (hasImagesToUpload) {
      if (!opts.silent) showToast('⏳ 上传图片中...', 0);
      pipeline = pipeline.then(function (current) {
        return uploadAllImages(current.orderedImageBase64List).then(function (summary) {
          var tokenMap = (summary && summary.tokenMap) || {};
          var uploaded = Number((summary && summary.uploadedCount) || 0);
          var failed = Number((summary && summary.failedCount) || 0);
          setDocJsonAttr('data-feishu-upload-result', {
            tokenMap: tokenMap,
            uploadedCount: uploaded,
            failedCount: failed,
            attemptedCount: Number((summary && summary.attemptedCount) || 0),
          });
          if (uploaded > 0) {
            mergeUploadedTokenMap(tokenMap);
            var origRecord = current.originalDocxRecordObj;
            if (origRecord) {
              current.docxRecord = JSON.stringify(docxRecord.replaceTokensInDocxRecord(origRecord, tokenMap));
              current.hasImagesToInject = false;
              current.hasImagesToUpload = false;
              return setPendingPaste(current).then(function () {
                if (!opts.silent) {
                  showToast('✅ ' + uploaded + ' 张图片已上传' + (failed ? '，失败 ' + failed + ' 张' : ''), 1500);
                }
                return current;
              });
            }
          }
          if (!opts.silent) {
            showToast('✅ ' + uploaded + ' 张图片已上传' + (failed ? '，失败 ' + failed + ' 张' : ''), 1500);
          }
          return current;
        }).catch(function () {
          if (!opts.silent) showToast('⚠️ 图片上传失败，将粘贴不含图片的内容', 3000);
          return current;
        });
      });
    }

    return pipeline.then(function (current) {
      return resolvePastePayload(current).then(function (payload) {
        var needsParser = payloadRequiresPasteParsing(payload);
        var canAutoDispatch = shouldAutoDispatchPastePayload(payload);
        var preferPasteEventOnly = payloadHasFeishuStructuredHtml(payload);
        var hasDowngradedImages = payloadHasDowngradedImages(payload);
        var needsManualPaste = needsParser && !canAutoDispatch;

        return writeClipboardPayload(payload).then(function () {
          if (opts.dispatch === false) {
            return { written: true, payload: payload };
          }
          var status = needsManualPaste
            ? { autoInserted: false, autoPasted: false, pathLabel: describePasteMode('clipboardOnly') }
            : runPasteAttempt(payload, {
                allowInsert: !preferPasteEventOnly,
                allowDispatch: canAutoDispatch,
              });

          if (current.orderedImageBase64List && current.orderedImageBase64List.length) {
            startImageInjectionObserver();
          }

          if (!opts.silent) {
            if (hasDowngradedImages && needsManualPaste) {
              showToast('📋 检测到图片块已降级到 base64；已写入剪贴板，请直接按 Cmd+V 走飞书原生粘贴以插入图片', 4600);
            } else {
              showPasteResultToast(status, needsManualPaste, true);
            }
          }
          return { written: true, payload: payload, status: status };
        }).catch(function () {
          var status = runPasteAttempt(payload, {
            allowInsert: !needsParser && !preferPasteEventOnly,
            allowDispatch: canAutoDispatch,
          });
          if (!opts.silent) showPasteResultToast(status, needsManualPaste, false);
          return { written: false, payload: payload, status: status };
        });
      });
    });
  }

  function pasteIntoDoc() {
    return getPendingPaste().then(function (pending) {
      if (!pending) {
        showToast('⚠️ 请先在源文档按 Cmd+Shift+D 提取');
        throw new Error('请先在源文档按 Cmd+Shift+D 提取');
      }
      if (!pending.clipboardHtml && pending.html) {
        showToast('⏳ 准备粘贴内容中...', 0);
      }
      return commitPaste(pending, {});
    });
  }

  // ── Extraction entry point ─────────────────────────────────────────────────

  function duplicateDocumentForAutomation() {
    var token = getDocToken();
    if (!token) {
      showToast('⚠️ 无法识别当前文档');
      return Promise.reject(new Error('无法识别当前文档'));
    }

    showToast('⏳ 提取文档中...', 0);
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var content = extractFullDoc();
        if (!content) {
          showToast('⚠️ 提取失败，请确保文档已加载');
          reject(new Error('提取失败，请确保文档已加载'));
          return;
        }

        var docTitle = getDocumentTitle();
        buildClipboardPayload(content).then(function (payload) {
          var validationSnapshot = captureValidationSnapshot();
          var semanticSnapshot = (validationSnapshot && validationSnapshot.semanticSnapshot) || null;
          var hasDowngradedImages = !!(payload && payload.hasDowngradedImages)
            || /data-feishu-downgraded-images="true"/i.test(String((payload && payload.html) || ''));
          var hasImagesToInject = !!(payload && payload.hasImagesToInject);
          var orderedImageBase64List = (payload && payload.orderedImageBase64List) || [];
          var withBase64 = orderedImageBase64List.filter(function (img) { return !!img.base64; }).length;
          var effectiveDocxRecord = (payload && payload.docxRecord) || '';

          return setPendingPaste({
            html: content.html,
            text: content.text,
            clipboardHtml: payload.html,
            docxRecord: effectiveDocxRecord,
            title: docTitle,
            hasDowngradedImages: hasDowngradedImages,
            hasImagesToInject: hasImagesToInject,
            hasImagesToUpload: !!(payload && payload.hasImagesToUpload),
            orderedImageBase64List: orderedImageBase64List,
            semanticSnapshot: semanticSnapshot,
            originalDocxRecordObj: (payload && payload.originalDocxRecordObj) || null,
          }).then(function () {
            var imgCount = countExtractedImages(content);
            var inlinedImgCount = (payload.html.match(/data:image/g) || []).length;
            var injectCount = orderedImageBase64List.length;
            var toastMsg = '✅ 已提取 ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片';
            if (injectCount > 0) toastMsg += ' · ' + injectCount + ' 张待注入';
            showToast(toastMsg, 3200);

            var result = {
              title: docTitle,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: inlinedImgCount,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: String(payload.html || '').length,
              hasDowngradedImages: hasDowngradedImages,
              hasImagesToInject: hasImagesToInject,
              imageInjectCount: orderedImageBase64List.length,
              imageInjectWithBase64: withBase64,
              semanticSnapshot: semanticSnapshot,
            };
            setDocJsonAttr('data-feishu-extraction-result', Object.assign({}, result, { ts: Date.now() }));
            resolve(result);
          });
        }).catch(function () {
          var fallbackSnapshot = captureValidationSnapshot();
          var fallbackSemantic = (fallbackSnapshot && fallbackSnapshot.semanticSnapshot) || null;
          setPendingPaste({
            html: content.html,
            text: content.text,
            title: docTitle,
            semanticSnapshot: fallbackSemantic,
          }).then(function () {
            var imgCount = countExtractedImages(content);
            showToast('⚠️ 内容已提取，但图片预处理失败，粘贴时可能退回纯文本 · ' + imgCount + ' 图片', 3500);
            var result = {
              title: docTitle,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: 0,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: 0,
              payloadError: true,
              semanticSnapshot: fallbackSemantic,
            };
            setDocJsonAttr('data-feishu-extraction-result', Object.assign({}, result, { ts: Date.now() }));
            resolve(result);
          });
        });
      }, 50);
    });
  }

  function buildValidateDuplicateDocumentSummary() {
    return duplicateDocumentForAutomation().then(function (extraction) {
      var validationSnapshot = captureValidationSnapshot();
      return getPendingPaste().then(function (pending) {
        var summary = Object.assign({}, extraction);
        if (validationSnapshot) {
          summary.validationSnapshot = validationSnapshot;
          summary.semanticSnapshot = validationSnapshot.semanticSnapshot || null;
        }
        if (pending) {
          summary.pendingPaste = {
            title: String(pending.title || ''),
            textLen: String(pending.text || '').length,
            htmlLen: String(pending.html || '').length,
            clipboardHtmlLen: String(pending.clipboardHtml || '').length,
            hasDowngradedImages: Boolean(pending.hasDowngradedImages),
            semanticSnapshot: pending.semanticSnapshot || null,
            ts: Number(pending.ts || 0),
          };
        } else {
          summary.pendingError = 'Pending paste cache was not updated.';
        }
        return summary;
      });
    });
  }

  // ── Native paste preparation (runner uses this) ────────────────────────────

  // The runner dispatches `feishu-prepare-native-paste` and then issues
  // Cmd+Shift+P / Cmd+V from outside the page.  This rewrites the clipboard
  // (and the pendingPaste cache) so that whatever the runner presses next
  // sees a payload with valid image tokens — uploading first if necessary.
  function preparePendingPasteForNativePaste() {
    return getPendingPaste().then(function (pending) {
      if (!pending) {
        throw new Error('请先在源文档按 Cmd+Shift+D 提取');
      }
      return commitPaste(pending, { dispatch: false, silent: true }).then(function () {
        return getPendingPaste().then(function (latest) {
          var resolved = latest || pending;
          return resolvePastePayload(resolved).then(function (payload) {
            return {
              title: String(resolved.title || ''),
              textLength: String((payload && payload.text) || '').length,
              htmlLength: String((payload && payload.html) || '').length,
              requiresNativePaste: payloadRequiresPasteParsing(payload),
              canAutoDispatch: shouldAutoDispatchPastePayload(payload),
            };
          });
        });
      });
    });
  }
