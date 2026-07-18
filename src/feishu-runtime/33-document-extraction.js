  // ── Document extraction (struct-service driven, DOM fallback) ──────────────

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
  function buildSemanticSnapshotForRoot(rootBlock, surface) {
    var primary = snapshotCollector.collectFromStructService(rootBlock, {
      calloutStyleResolver: extractCalloutStyleFromDOM,
      getDocument: function () { return document; },
    });
    var fallback = snapshotCollector.collectFromDom(surface);
    return snapshotCollector.mergeSemanticSnapshots(primary, fallback);
  }

  function extractVisibleDomFallback() {
    var root = getValidationSurfaceElement() || getContentRootElement();
    if (!root) return null;
    var text = attribs.normalizePlainText(root.innerText || root.textContent || '');
    var html = sanitizer.finalizeHtmlFragment(root.innerHTML || '');
    var htmlText = sanitizer.extractPlainTextFromHtmlFragment(html);
    if (!text && !attribs.normalizePlainText(htmlText)) html = '';
    if (!text && !html) return null;
    var blockCount = text ? text.split('\n').filter(function (line) { return line.trim(); }).length : 0;
    var fallbackEquationCount = countFallbackEquationNodes(root) || (text.match(/\$/g) || []).length;
    return {
      html: html || '<p>' + attribs.escapeHtml(text).replace(/\n/g, '<br>') + '</p>',
      text: text,
      blockCount: blockCount,
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
    if (isVisibleDocumentBodyEmpty()) {
      return {
        html: '',
        text: '',
        blockCount: 0,
        equationCount: 0,
        imageCount: 0,
        docxRecord: '',
      };
    }
    var docxRecordPayload = renderer.buildDocxRecordPayload(ss.rootBlock, { maxDepth: MAX_BLOCK_DEPTH });
    var docxRecordRaw = docxRecordPayload ? JSON.stringify(docxRecordPayload) : '';
    return {
      html: finalHtml,
      text: finalText,
      blockCount: rendered.blockCount,
      equationCount: rendered.equationCount,
      imageCount: listImageRecordsFromDocxRecord(docxRecordRaw).length,
      docxRecord: docxRecordRaw,
    };
  }

  function captureValidationSnapshot() {
    var content = extractFullDoc();
    if (!content) return null;
    var ss = getStructService();
    var surface = getValidationSurfaceElement() || getContentRootElement();
    var semanticSnapshot = ss && ss.rootBlock
      ? buildSemanticSnapshotForRoot(ss.rootBlock, surface)
      : snapshotCollector.collectFromDom(surface);
    var snapshot = {
      title: getDocumentTitle(),
      text: String(content.text || ''),
      textLength: String(content.text || '').length,
      htmlLength: String(content.html || '').length,
      blockCount: Number(content.blockCount || 0),
      equationCount: Number(content.equationCount || 0),
      imageCount: countExtractedImages(content),
      semanticSnapshot: semanticSnapshot,
    };
    setDocJsonAttr('data-feishu-validation-snapshot', {
      title: snapshot.title,
      blockCount: snapshot.blockCount,
      equationCount: snapshot.equationCount,
      imageCount: snapshot.imageCount,
      textLength: snapshot.textLength,
      htmlLength: snapshot.htmlLength,
      semanticSnapshot: snapshot.semanticSnapshot,
    });
    return snapshot;
  }
