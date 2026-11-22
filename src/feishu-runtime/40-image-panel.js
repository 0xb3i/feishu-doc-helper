  // Structured images for the isolated extension panel and image-only transfer.
  function extractImages() {
    var service = getStructService();
    if (!service || !service.rootBlock) return [];
    return buildImageEntriesFromDocxRecord({ recordMap: collectDocumentImageRecords(service.rootBlock) });
  }

  function extractSelectedImages(selection) {
    var service = getStructService();
    var root = service && service.rootBlock;
    if (!root || !root.record || !root.record.snapshot || root.record.snapshot.type !== 'page') {
      throw new Error('文档正文仍在加载，请重新打开图片面板');
    }
    var blocks = collectDocumentImageRecords(root, function (block) { return block; })
      .filter(function (block) { return block.record.snapshot.image.token; });
    var selected = new Map(selection.map(function (entry) { return [entry.index, entry.token]; }));
    var imageBlocks = blocks.flatMap(function (block, index) {
      var record = block.record;
      if (selected.get(index) !== record.snapshot.image.token) return [];
      return [{
        record: { id: record.id, snapshot: Object.assign({}, record.snapshot, {
          parent_id: root.record.id, children: [],
        }) },
        children: [],
      }];
    });
    if (imageBlocks.length !== selection.length) {
      throw new Error('原文图片已变化，请重新打开图片面板');
    }
    var imageRoot = {
      record: {
        id: root.record.id,
        snapshot: { type: 'page', children: imageBlocks.map(function (block) { return block.record.id; }) },
      },
      children: imageBlocks,
    };
    var rendered = renderer.renderRootBlock(imageRoot, { locationOrigin: location.origin });
    var content = {
      html: sanitizer.finalizeHtmlFragment(rendered.htmlParts.join('\n')),
      text: attribs.normalizePlainText(rendered.mdParts.join('\n')),
      docxRecord: JSON.stringify(renderer.buildDocxRecordPayload(imageRoot)),
    };
    var title = getDocumentTitle();
    return buildClipboardPayload(content).then(function (payload) {
      if (payload.orderedImageBase64List.length !== selection.length) {
        throw new Error('未能完整准备所选图片，请重试');
      }
      return setPendingPaste({
        kind: 'images',
        title: title,
        html: content.html,
        text: content.text,
        docxRecord: payload.docxRecord,
        clipboardHtml: payload.html,
        orderedImageBase64List: payload.orderedImageBase64List,
      });
    }).then(function () {
      var notice = '已提取 ' + selection.length + ' 张图片到缓存';
      showToast(notice, 3000);
      return { imageCount: selection.length };
    });
  }
