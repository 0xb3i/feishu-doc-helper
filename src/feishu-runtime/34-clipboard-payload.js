  // ── Clipboard payload assembly ─────────────────────────────────────────────

  function buildClipboardPayload(content) {
    var text = (content && content.text) || '';
    var preparedHtml = (content && content.clipboardHtml) || '';
    var html = (content && content.html) || '';
    var docxRecordRaw = docxRecord.sanitizeDocxRecord((content && content.docxRecord) || '');

    if (preparedHtml) {
      return Promise.resolve({
        text: text,
        html: sanitizer.sanitizeClipboardHtml(preparedHtml),
        docxRecord: docxRecordRaw,
      });
    }
    if (!html) {
      return Promise.resolve({ text: text, html: '', docxRecord: docxRecordRaw });
    }

    var docxRecordObj = null;
    try { docxRecordObj = docxRecordRaw ? JSON.parse(docxRecordRaw) : null; }
    catch (e) {}
    var imageEntries = docxRecordObj ? listImageRecordsFromDocxRecord(docxRecordObj) : [];

    return convertImagesToBase64(
      html,
      imageEntries,
      content && content.preloadedImageDataUrls
    ).then(function (result) {
      var htmlWithImages = result.html;
      var tokenToBase64 = result.tokenToBase64 || {};

      // Build the ordered image list by walking the recordMap directly so
      // images nested inside table cells / grid columns are picked up.
      var orderedImageBase64List = [];
      if (imageEntries.length) {
        imageEntries.forEach(function (entry) {
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

      var missingImages = orderedImageBase64List.filter(function (img) { return !img.base64; });
      if (missingImages.length) {
        throw new Error('图片预处理不完整：' + missingImages.length + ' 张图片未能读取，请重试提取');
      }
      var hasImages = orderedImageBase64List.length > 0;
      return {
        text: text,
        html: sanitizer.buildClipboardHtml(htmlWithImages, false),
        docxRecord: docxRecordObj ? JSON.stringify(docxRecordObj) : '',
        hasDowngradedImages: false,
        hasImagesToInject: hasImages,
        hasImagesToUpload: hasImages,
        orderedImageBase64List: orderedImageBase64List,
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
      html: (content && content.clipboardHtml)
        ? sanitizer.sanitizeClipboardHtml(content.clipboardHtml)
        : '',
      docxRecord: docxRecord.sanitizeDocxRecord((content && content.docxRecord) || ''),
    };
    if (prepared.html || !(content && content.html)) return Promise.resolve(prepared);
    return buildClipboardPayload(content);
  }

  // ── Clipboard write ────────────────────────────────────────────────────────

  function createClipboardBridgeRequestId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return 'feishu-helper-clipboard-' + globalThis.crypto.randomUUID();
    }
    return 'feishu-helper-clipboard-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function writeClipboardPayloadWithExtension(payload, pasteAfterWrite) {
    return new Promise(function (resolve, reject) {
      var requestId = createClipboardBridgeRequestId();
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, new Error('extension clipboard bridge timed out'));
      }, 5000);
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener('feishu-helper:clipboard-transfer-result', onResult, true);
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
        if (!detail.ok || !detail.written) {
          finish(reject, new Error(String(detail.error || 'extension clipboard write failed')));
          return;
        }
        finish(resolve, { written: true, pasted: detail.pasted === true, mode: 'extensionClipboard' });
      }
      document.addEventListener('feishu-helper:clipboard-transfer-result', onResult, true);
      document.dispatchEvent(new CustomEvent('feishu-helper:clipboard-transfer', {
        detail: {
          requestId: requestId,
          payload: {
            text: String(payload.text || ''),
            html: String(payload.html || ''),
            docxRecord: String(payload.docxRecord || ''),
            imageDataUrl: String(payload.imageDataUrl || ''),
            pasteAfterWrite: pasteAfterWrite === true,
          },
        },
      }));
    });
  }

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

  function writeClipboardPayload(payload, options) {
    var data = {};
    if (payload.text) data['text/plain'] = new Blob([payload.text], { type: 'text/plain' });
    if (payload.html) data['text/html'] = new Blob([payload.html], { type: 'text/html' });
    if (payload.docxRecord) data['docx/record'] = new Blob([payload.docxRecord], { type: 'text/plain' });
    if (!Object.keys(data).length) return Promise.reject(new Error('clipboard payload empty'));

    return writeClipboardPayloadWithExtension(payload, options && options.pasteAfterWrite).catch(function () {
      if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
        return navigator.clipboard.write([new ClipboardItem(data)]).then(function () {
          return { written: true, pasted: false, mode: 'navigatorClipboard' };
        }).catch(function () {
          return writeClipboardPayloadWithExecCommand(payload).then(function () {
            return { written: true, pasted: false, mode: 'execCommandCopy' };
          });
        });
      }
      return writeClipboardPayloadWithExecCommand(payload).then(function () {
        return { written: true, pasted: false, mode: 'execCommandCopy' };
      });
    });
  }
