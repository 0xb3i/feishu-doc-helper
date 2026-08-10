  function dispatchUiActionResult(detail) {
    try {
      document.dispatchEvent(new CustomEvent('feishu-helper:ui-result', { detail: detail }));
    } catch (err) {}
  }

  function runUiAction(action) {
    var name = String(action || '');
    if (name === 'extract') return duplicateDocumentForAutomation();
    if (name === 'paste') return pasteIntoDoc();
    if (name === 'snapshot') return Promise.resolve(captureValidationSnapshot());
    if (name === 'scan') {
      return requestDocumentInspect();
    }
    if (name === 'images') {
      var images = extractImages();
      if (!images.length) showToast('当前页面未找到图片');
      else createImagePanel(images);
      return Promise.resolve({ imageCount: images.length });
    }
    if (name === 'prepareNativePaste') return preparePendingPasteForNativePaste();
    return Promise.reject(new Error('Unsupported UI action: ' + name));
  }

  registerEventListener(document, 'feishu-helper:ui-action', function (event) {
    var detail = (event && event.detail) || {};
    if (!detail.requestId) return;
    // popup 触发的操作：截流页面 toast，把文案随结果回传给面板显示
    beginToastCapture();
    runUiAction(detail.action).then(function (summary) {
      var notice = endToastCapture();
      dispatchUiActionResult({ requestId: detail.requestId, status: 'success', summary: summary || null, notice: notice || '' });
    }).catch(function (error) {
      var notice = endToastCapture();
      dispatchUiActionResult({ requestId: detail.requestId, status: 'error', error: stringifyError(error), notice: notice || '' });
    });
  }, true);

  registerEventListener(document, 'feishu-capture-snapshot', function () {
    try { captureValidationSnapshot(); }
    catch (e) {}
  }, true);
