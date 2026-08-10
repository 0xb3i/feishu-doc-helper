  // ── Native copy fast path ─────────────────────────────────────────────────

  var nativeClipboardTransform = FeishuHelperLibs.nativeClipboardTransform;
  var NATIVE_COPY_EVENT = 'feishu-helper:native-copy';
  var NATIVE_COPY_RESULT_EVENT = 'feishu-helper:native-copy-result';
  var NATIVE_CLIPBOARD_MAX_BYTES = 8 * 1024 * 1024;

  function requestNativeCopyPermission() {
    return requestWhiteboardNative('copyPermission', { sourceUrl: location.href }, 30000)
      .then(function (data) { return !!(data && data.copyAllowed === true); })
      .catch(function () { return false; });
  }

  function nativeClipboardByteLength(payload) {
    try {
      return new TextEncoder().encode(String(payload.text || '')
        + String(payload.html || '') + String(payload.docxRecord || '')).byteLength;
    } catch (error) {
      return Infinity;
    }
  }

  function parseCompleteNativeRecord(raw) {
    var clean = docxRecord.sanitizeDocxRecord(raw);
    if (!clean) throw new Error('飞书原生复制未返回可用的 docx/record');
    var parsed = JSON.parse(clean);
    if (!parsed.recordMap || typeof parsed.recordMap !== 'object'
      || !Array.isArray(parsed.recordIds) || !parsed.recordIds.length
      || !Array.isArray(parsed.blockIds) || !Array.isArray(parsed.selection)
      || parsed.blockIds.length !== parsed.recordIds.length
      || !parsed.selection.length) {
      throw new Error('飞书原生 docx/record 结构不完整');
    }
    var seen = {};
    parsed.recordIds.forEach(function (recordId) {
      var id = String(recordId || '');
      if (!id || seen[id] || !parsed.recordMap[id]) {
        throw new Error('飞书原生 docx/record 的 recordIds 不自洽');
      }
      seen[id] = true;
    });
    parsed.selection.forEach(function (entry) {
      if (!entry || !parsed.recordMap[String(entry.recordId || '')]) {
        throw new Error('飞书原生 docx/record 的 selection 不自洽');
      }
    });
    return { raw: clean, parsed: parsed };
  }

  function validateNativeClipboardCompleteness(payload, expectedContent) {
    if (!payload || !String(payload.text || '') || !String(payload.html || '')) {
      throw new Error('飞书原生复制只返回了部分剪贴板格式');
    }
    if (nativeClipboardByteLength(payload) > NATIVE_CLIPBOARD_MAX_BYTES) {
      throw new Error('飞书原生剪贴板超过安全写入上限');
    }
    var nativeRecord = parseCompleteNativeRecord(payload.docxRecord);
    var expected = parseCompleteNativeRecord(expectedContent && expectedContent.docxRecord);
    var missing = expected.parsed.recordIds.filter(function (recordId) {
      return !nativeRecord.parsed.recordMap[recordId];
    });
    if (missing.length) {
      throw new Error('飞书原生复制未覆盖完整文档结构（缺少 ' + missing.length + ' 块）');
    }
    return {
      text: String(payload.text),
      html: String(payload.html),
      docxRecord: nativeRecord.raw,
    };
  }

  function captureDomSelectionState() {
    var selection = window.getSelection && window.getSelection();
    var ranges = [];
    if (selection) {
      for (var i = 0; i < selection.rangeCount; i++) {
        try { ranges.push(selection.getRangeAt(i).cloneRange()); } catch (error) {}
      }
    }
    return {
      ranges: ranges,
      anchorNode: selection && selection.anchorNode,
      anchorOffset: selection ? selection.anchorOffset : 0,
      focusNode: selection && selection.focusNode,
      focusOffset: selection ? selection.focusOffset : 0,
    };
  }

  function getNativeSelectionService(editorAPI) {
    var direct = editorAPI && editorAPI.selectionService;
    if (direct && typeof direct.selectAll === 'function'
      && typeof direct.getSelection === 'function') return direct;
    var caches = editorAPI && editorAPI.modular && editorAPI.modular.caches;
    if (!caches || typeof caches.forEach !== 'function') return null;
    var match = null;
    caches.forEach(function (candidate) {
      if (match || !candidate) return;
      // Resolve by the stable behavioral contract of the editor selection API,
      // not by minified class names, provider IDs or container positions.
      if (typeof candidate.selectAll === 'function'
        && typeof candidate.getSelection === 'function'
        && typeof candidate.setSelection === 'function'
        && typeof candidate.removeAllSelection === 'function'
        && typeof candidate.copySelectedBlocks === 'function') match = candidate;
    });
    return match;
  }

  function captureNativeCopyPageState(editorAPI) {
    var selectionService = getNativeSelectionService(editorAPI);
    var editorSelection = null;
    if (selectionService && typeof selectionService.getSelection === 'function') {
      try { editorSelection = selectionService.getSelection(); } catch (error) {}
    }
    var scroller = editorAPI && editorAPI.viewService && editorAPI.viewService.layoutManager
      && editorAPI.viewService.layoutManager.getScroller();
    return {
      activeElement: document.activeElement,
      domSelection: captureDomSelectionState(),
      selectionService: selectionService,
      editorSelection: editorSelection,
      scroller: scroller,
      scrollTop: scroller ? scroller.scrollTop : 0,
      scrollLeft: scroller ? scroller.scrollLeft : 0,
      windowX: window.scrollX,
      windowY: window.scrollY,
    };
  }

  function restoreNativeCopyPageState(saved) {
    if (!saved) return;
    try {
      if (saved.selectionService && saved.editorSelection != null
        && typeof saved.selectionService.setSelection === 'function') {
        saved.selectionService.setSelection(saved.editorSelection);
      }
    } catch (error) {}
    try {
      var dom = saved.domSelection;
      var selection = window.getSelection && window.getSelection();
      if (selection && dom) {
        selection.removeAllRanges();
        if (dom.anchorNode && dom.focusNode && typeof selection.setBaseAndExtent === 'function') {
          selection.setBaseAndExtent(
            dom.anchorNode, dom.anchorOffset, dom.focusNode, dom.focusOffset
          );
        } else {
          dom.ranges.forEach(function (range) { selection.addRange(range); });
        }
      }
    } catch (error) {}
    try {
      if (saved.activeElement && saved.activeElement.isConnected
        && typeof saved.activeElement.focus === 'function') {
        saved.activeElement.focus({ preventScroll: true });
      }
    } catch (error) {}
    function restoreScroll() {
      try {
        if (saved.scroller) {
          saved.scroller.scrollTop = saved.scrollTop;
          saved.scroller.scrollLeft = saved.scrollLeft;
        }
        window.scrollTo(saved.windowX, saved.windowY);
      } catch (error) {}
    }
    restoreScroll();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreScroll);
  }

  function selectWholeDocumentForNativeCopy(editorAPI) {
    var service = getNativeSelectionService(editorAPI);
    if (service && typeof service.selectAll === 'function') {
      service.selectAll();
      return 'selectionService.selectAll';
    }
    var manager = editorAPI && editorAPI.commandManager;
    if (manager && typeof manager.execute === 'function') {
      var commands = ['SelectAll', 'selectAll'];
      for (var i = 0; i < commands.length; i++) {
        try {
          manager.execute(commands[i], null);
          return 'commandManager.' + commands[i];
        } catch (error) {}
      }
    }
    var root = getContentRootElement();
    var target = root && root.querySelector(EDITABLE_SELECTOR);
    try {
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      else if (root && typeof root.focus === 'function') root.focus({ preventScroll: true });
    } catch (error) {}
    if (document.execCommand('selectAll') !== true) {
      throw new Error('当前飞书编辑器不支持完整原生全选');
    }
    return 'execCommand.selectAll';
  }

  function requestNativeCopyCommand() {
    return new Promise(function (resolve, reject) {
      var requestId = 'native-copy-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, new Error('飞书原生复制命令超时'));
      }, 5000);
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener(NATIVE_COPY_RESULT_EVENT, onResult, true);
      }
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        if (!detail.ok || !detail.copied) {
          finish(reject, new Error(String(detail.error || '飞书原生复制失败')));
          return;
        }
        finish(resolve, true);
      }
      document.addEventListener(NATIVE_COPY_RESULT_EVENT, onResult, true);
      document.dispatchEvent(new CustomEvent(NATIVE_COPY_EVENT, {
        detail: { requestId: requestId },
      }));
    });
  }

  function captureFeishuNativeClipboard(expectedContent) {
    var editorAPI = getEditorAPI();
    if (!editorAPI) return Promise.reject(new Error('飞书编辑器尚未就绪'));
    var saved = captureNativeCopyPageState(editorAPI);
    var best = { text: '', html: '', docxRecord: '' };
    var wrappedTransfers = [];
    function captureSetData(format, value) {
      var type = String(format || '').toLowerCase();
      if (type === 'text/plain') best.text = String(value || '');
      else if (type === 'text/html') best.html = String(value || '');
      else if (type === 'docx/record') best.docxRecord = String(value || '');
    }
    function observeCopy(event) {
      var data = event && event.clipboardData;
      if (!data) return;
      captureSetData('text/plain', data.getData('text/plain') || best.text);
      captureSetData('text/html', data.getData('text/html') || best.html);
      captureSetData('docx/record', data.getData('docx/record') || best.docxRecord);
      // Feishu stops copy propagation after its serializer writes the custom
      // MIME fields, so a later bubble observer cannot see the final payload.
      // Wrap only this ephemeral DataTransfer instance in window capture and
      // delegate unchanged; every value written by Feishu is observed without
      // preventing or rewriting the event.
      if (data.__feishuHelperNativeCopyObserved) return;
      var originalSetData = data.setData;
      if (typeof originalSetData !== 'function') return;
      try {
        Object.defineProperty(data, '__feishuHelperNativeCopyObserved', {
          value: true, configurable: true,
        });
        Object.defineProperty(data, 'setData', {
          configurable: true,
          value: function (format, value) {
            captureSetData(format, value);
            return originalSetData.call(this, format, value);
          },
        });
        wrappedTransfers.push({ data: data, originalSetData: originalSetData });
      } catch (error) {}
    }
    window.addEventListener('copy', observeCopy, true);
    try {
      selectWholeDocumentForNativeCopy(editorAPI);
    } catch (error) {
      window.removeEventListener('copy', observeCopy, true);
      restoreNativeCopyPageState(saved);
      return Promise.reject(error);
    }
    return requestNativeCopyCommand().then(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }).then(function () {
      return validateNativeClipboardCompleteness(best, expectedContent);
    }).finally(function () {
      window.removeEventListener('copy', observeCopy, true);
      wrappedTransfers.forEach(function (entry) {
        try {
          Object.defineProperty(entry.data, 'setData', {
            configurable: true,
            value: entry.originalSetData,
          });
          delete entry.data.__feishuHelperNativeCopyObserved;
        } catch (error) {}
      });
      restoreNativeCopyPageState(saved);
    });
  }

  function prepareNativeHybridPayload(content, transfer) {
    return captureFeishuNativeClipboard(content).then(function (nativeClipboard) {
      if (!transfer) {
        return {
          payload: nativeClipboard,
          report: { mode: 'nativeHybrid', slotCount: 0 },
        };
      }
      return nativeClipboardTransform.transformNativeClipboardForWhiteboards(
        nativeClipboard,
        transfer,
        content.text,
        sanitizer.buildClipboardHtml(content.html, false)
      );
    }).then(function (prepared) {
      if (nativeClipboardByteLength(prepared.payload) > NATIVE_CLIPBOARD_MAX_BYTES) {
        throw new Error('转换后的原生剪贴板超过安全写入上限');
      }
      return prepared;
    });
  }

  function captureDocumentRootChildren() {
    var editorAPI = getEditorAPI();
    var root = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    var rootRecord = root && root.record;
    if (!editorAPI || !rootRecord || !rootRecord.id) return null;
    return {
      editorAPI: editorAPI,
      rootRecordId: String(rootRecord.id),
      childRecordIds: (root.children || []).map(function (child) {
        return String(child && child.record && child.record.id || '');
      }).filter(Boolean),
    };
  }

  function rollbackDocumentRootChildren(captured) {
    var editorAPI = captured && captured.editorAPI;
    if (!editorAPI || !editorAPI.dataService
      || typeof editorAPI.dataService.applyTransaction !== 'function') return false;
    editorAPI.dataService.applyTransaction('feishu-helper-native-paste-rollback', function (tx) {
      tx.replaceChildren(captured.rootRecordId, captured.childRecordIds.slice());
    });
    return true;
  }

  function collectStructuredPasteStats() {
    var editorAPI = getEditorAPI();
    var root = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    var stats = { blockCount: 0, imageCount: 0, markerCounts: {} };
    function visit(block, depth) {
      if (!block || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return;
      var snapshot = block.record && block.record.snapshot;
      if (snapshot) {
        stats.blockCount += 1;
        if (snapshot.type === 'image' && snapshot.image && snapshot.image.token) stats.imageCount += 1;
        var text = attribs.decodeBlockText(snapshot);
        if (text && text.indexOf(WHITEBOARD_MARKER_PREFIX) !== -1) {
          (text.match(/\[\[FEISHU_HELPER_WHITEBOARD:[^\]]+\]\]/g) || []).forEach(function (marker) {
            stats.markerCounts[marker] = (stats.markerCounts[marker] || 0) + 1;
          });
        }
      }
      (block.children || []).forEach(function (child) { visit(child, depth + 1); });
    }
    visit(root, 0);
    return stats;
  }

  function waitForNativeHybridPasteVerified(payload, transfer, timeoutMs) {
    var source = parseCompleteNativeRecord(payload && payload.docxRecord).parsed;
    var expectedImages = docxRecord.listImageRecords(source).length;
    var expectedBlocks = source.recordIds.length;
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      function check() {
        var stats = collectStructuredPasteStats();
        var markersReady = !transfer || transfer.slots.every(function (slot) {
          return stats.markerCounts[slot.marker] === 1;
        });
        if (stats.blockCount >= expectedBlocks && stats.imageCount >= expectedImages && markersReady) {
          resolve({ imageCount: expectedImages, nativeHybrid: true });
          return;
        }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          resolve(null);
          return;
        }
        setTimeout(check, 160);
      }
      check();
    });
  }
