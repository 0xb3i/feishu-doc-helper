'use strict';

// Block-tree renderers for Feishu's structService output.
//
// Both blockToHtml and blockToMarkdown work on raw `snap` objects so they're
// pure with respect to DOM lookups.  Anything DOM-derived (callout colors
// extracted from rendered nodes, image location origin) is supplied via
// `context` so we keep the module unit-testable.

function createBlockRenderer(deps) {
  var attribs = deps.attribs;
  var styleCodec = deps.styleCodec;
  var sanitizer = deps.sanitizer;
  var docxRecord = deps.docxRecord;

  var DEFAULT_HEADING_STYLE = 'margin:1.2em 0 0.6em;line-height:1.35;';
  var DEFAULT_PARAGRAPH_STYLE = 'margin:0.75em 0;';
  var SPECIAL_BLOCK_LABELS = {
    diagram: '流程图',
    whiteboard: '白板',
    synced_reference: '引用块',
  };

  var syntheticIdCounter = 0;
  function nextSyntheticId(prefix) {
    syntheticIdCounter += 1;
    return String(prefix || 'feishu_helper') + '_' + syntheticIdCounter.toString(36);
  }

  function getBlockChildren(block) {
    return block && Array.isArray(block.children) ? block.children : [];
  }

  function buildBlockRecordMap(block) {
    var blockMap = {};
    getBlockChildren(block).forEach(function (child) {
      if (child.record && child.record.id) blockMap[child.record.id] = child;
    });
    return blockMap;
  }

  function collectTableCellParts(cellBlock, extractor) {
    var parts = [];
    getBlockChildren(cellBlock).forEach(function (child) {
      if (!(child.record && child.record.snapshot)) return;
      var value = extractor(child.record.snapshot);
      if (value) parts.push(value);
    });
    return parts;
  }

  function buildTableMatrix(snap, block, extractor, joinParts) {
    var rows = (snap && snap.rows_id) || [];
    var cols = (snap && snap.columns_id) || [];
    var cellSet = (snap && snap.cell_set) || {};
    if (!rows.length || !cols.length) return null;

    var blockMap = buildBlockRecordMap(block);
    var tableRows = rows.map(function (rowId) {
      return cols.map(function (colId) {
        var cellInfo = cellSet[rowId + colId];
        if (!(cellInfo && cellInfo.block_id)) return '';
        var cellBlock = blockMap[cellInfo.block_id];
        if (!cellBlock) return '';
        return joinParts(collectTableCellParts(cellBlock, extractor));
      });
    });

    return { cols: cols, rows: tableRows };
  }

  function tableToHtml(snap, block) {
    var matrix = buildTableMatrix(snap, block, function (childSnap) {
      return attribs.decodeBlockHtml(childSnap, { normalizeColor: styleCodec.normalizeCssColor });
    }, function (parts) {
      return sanitizer.finalizeHtmlFragment(parts.join('<br>'));
    });
    if (!matrix) return '';

    var html = '<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;margin:0.75em 0;">';
    matrix.rows.forEach(function (row) {
      html += '<tr>';
      row.forEach(function (cellContent) {
        html += '<td style="border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;">' + cellContent + '</td>';
      });
      html += '</tr>';
    });
    html += '</table>';
    return html;
  }

  function tableToMarkdown(snap, block) {
    var matrix = buildTableMatrix(snap, block, attribs.decodeBlockText, function (parts) {
      return parts.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    });
    if (!matrix) return '';

    var md = '| ' + matrix.cols.map(function () { return ''; }).join(' | ') + ' |\n';
    md += '| ' + matrix.cols.map(function () { return '---'; }).join(' | ') + ' |\n';
    matrix.rows.forEach(function (row) {
      md += '| ' + row.join(' | ') + ' |\n';
    });
    return md.trim();
  }

  function getHeadingTagName(type) {
    var match = /^heading([1-9])$/.exec(type || '');
    if (!match) return '';
    return 'h' + Math.min(parseInt(match[1], 10), 6);
  }

  function getHeadingMarkdownPrefix(type) {
    var match = /^heading([1-9])$/.exec(type || '');
    if (!match) return '';
    return new Array(Math.min(parseInt(match[1], 10), 6) + 1).join('#');
  }

  function indentMultilineText(text, prefix) {
    return String(text || '').split('\n').map(function (line) { return prefix + line; }).join('\n');
  }

  function renderMarkdownListItem(prefix, text, childMd) {
    var line = prefix + text;
    return childMd ? line + '\n' + indentMultilineText(childMd, '  ') : line;
  }

  function renderMarkdownBlockquote(content) {
    var trimmed = String(content || '').trim();
    if (!trimmed) return '';
    return trimmed.split('\n').map(function (line) { return '> ' + line; }).join('\n');
  }

  function renderHtmlPlaceholder(label) { return '<p>[' + label + ']</p>'; }
  function renderMarkdownPlaceholder(label) { return '[' + label + ']'; }

  function styleObjectToString(styleObj) {
    return Object.keys(styleObj || {}).filter(function (key) {
      return styleObj[key] !== '' && styleObj[key] != null;
    }).map(function (key) {
      return key + ':' + styleObj[key] + ';';
    }).join('');
  }

  function mergeStyleStrings() {
    var merged = {};
    for (var i = 0; i < arguments.length; i++) {
      var styleStr = arguments[i];
      if (!styleStr) continue;
      styleStr.split(';').forEach(function (part) {
        var idx = part.indexOf(':');
        if (idx === -1) return;
        var key = part.slice(0, idx).trim();
        var value = part.slice(idx + 1).trim();
        if (!key || !value) return;
        merged[key] = value;
      });
    }
    return styleObjectToString(merged);
  }

  function buildBlockStyle(baseStyle, snap, extraStyle, normalizedStyle, options) {
    var style = mergeStyleStrings(baseStyle, extraStyle);
    var normalizedBlockStyle = normalizedStyle || styleCodec.normalizeBlockStyle(snap);
    var opts = options || {};
    var dynamicStyle = styleObjectToString({
      'text-align': opts.applyAlign === false ? '' : normalizedBlockStyle.align,
      'text-indent': opts.applyTextIndent === false ? '' : normalizedBlockStyle.textIndent,
      'background-color': opts.applyBackgroundColor === false ? '' : normalizedBlockStyle.backgroundColor,
      color: opts.applyTextColor === false ? '' : normalizedBlockStyle.textColor,
    });
    return mergeStyleStrings(style, dynamicStyle);
  }

  function wrapWithStyleTag(tagName, style, innerHtml, extraAttrs) {
    var attrs = [];
    if (style) attrs.push('style="' + attribs.escapeAttr(style) + '"');
    if (extraAttrs) attrs.push(extraAttrs);
    return '<' + tagName + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + innerHtml + '</' + tagName + '>';
  }

  function buildCalloutClipboardMetadata(snap, normalizedStyle, options) {
    var blockId = String(snap && (snap.block_id || snap.blockId) || nextSyntheticId('callout_block'));
    var recordId = String(snap && (snap.record_id || snap.recordId) || nextSyntheticId('callout_record'));
    var normalizedBlockStyle = normalizedStyle || styleCodec.normalizeBlockStyle(snap);
    var emojiId = normalizedBlockStyle.calloutEmojiId;
    var bgColorCode = styleCodec.cssColorToFeishuBgCode(normalizedBlockStyle.backgroundColor);
    var borderColorCode = styleCodec.cssColorToFeishuBorderColorCode(normalizedBlockStyle.borderColor);
    var textColorCode = styleCodec.cssColorToFeishuTextCode(normalizedBlockStyle.textColor);
    var alignCode = styleCodec.alignStringToFeishuCode(normalizedBlockStyle.align);
    var calloutType = styleCodec.getCalloutMarkdownType({ emoji_id: emojiId });
    var text = styleCodec.selectPrimaryCalloutContent(
      attribs.decodeBlockText(snap || {}),
      options && options.text
    );

    var normalizedStyleMetadata = {
      align: normalizedBlockStyle.align,
      textIndent: normalizedBlockStyle.textIndent,
      textColor: normalizedBlockStyle.textColor,
      backgroundColor: normalizedBlockStyle.backgroundColor,
      borderColor: normalizedBlockStyle.borderColor,
      imageAlign: normalizedBlockStyle.imageAlign,
      calloutEmojiId: normalizedBlockStyle.calloutEmojiId,
    };

    var snapshot = {
      type: 'callout',
      emoji_id: emojiId,
      background_color: bgColorCode,
      border_color: borderColorCode,
      text_color: textColorCode,
      align: alignCode,
      callout_type: calloutType,
      normalizedStyle: normalizedStyleMetadata,
    };
    if (text) snapshot.text = text;

    return {
      blockId: blockId,
      recordId: recordId,
      recordData: JSON.stringify({
        rootId: recordId,
        blockId: blockId,
        recordId: recordId,
        type: 'callout',
        emoji_id: emojiId,
        background_color: bgColorCode,
        border_color: borderColorCode,
        text_color: textColorCode,
        align: alignCode,
        normalizedStyle: normalizedStyleMetadata,
        snapshot: snapshot,
      }),
      metaBlockProps: JSON.stringify({
        blockId: blockId,
        recordId: recordId,
        blockType: 'CALLOUT_BLOCK',
        props: {
          data: {
            emojiId: emojiId,
            backgroundColor: bgColorCode,
            borderColor: borderColorCode,
            textColor: textColorCode,
            align: alignCode,
            calloutType: calloutType,
            text: text,
            normalizedStyle: normalizedStyleMetadata,
          },
        },
      }),
    };
  }

  function buildImageClipboardMetadata(snap, normalizedStyle) {
    var blockId = String(snap && (snap.block_id || snap.blockId) || nextSyntheticId('image_block'));
    var recordId = String(snap && (snap.record_id || snap.recordId) || nextSyntheticId('image_record'));
    var normalizedBlockStyle = normalizedStyle || styleCodec.normalizeBlockStyle(snap);
    var imageInfo = (snap && snap.image) || {};
    var imageToken = imageInfo.token || '';
    var imageWidth = imageInfo.width || 0;
    var imageHeight = imageInfo.height || 0;
    var imageAlign = normalizedBlockStyle.imageAlign || 'center';
    var alignCode = styleCodec.alignStringToFeishuCode(imageAlign);
    var normalizedStyleMetadata = {
      align: normalizedBlockStyle.align,
      imageAlign: imageAlign,
    };
    var snapshot = {
      type: 'image',
      align: alignCode,
      image: { token: imageToken, width: imageWidth, height: imageHeight },
      normalizedStyle: normalizedStyleMetadata,
    };
    return {
      blockId: blockId,
      recordId: recordId,
      recordData: JSON.stringify({
        rootId: recordId,
        blockId: blockId,
        recordId: recordId,
        type: 'image',
        align: alignCode,
        image: snapshot.image,
        normalizedStyle: normalizedStyleMetadata,
        snapshot: snapshot,
      }),
      metaBlockProps: JSON.stringify({
        blockId: blockId,
        recordId: recordId,
        blockType: 'IMAGE_BLOCK',
        props: {
          data: {
            align: alignCode,
            token: imageToken,
            width: imageWidth,
            height: imageHeight,
            normalizedStyle: normalizedStyleMetadata,
          },
        },
      }),
    };
  }

  function getImageAssetInfo(image, locationOrigin) {
    var src = image && image.token
      ? String(locationOrigin || '') + '/space/api/box/stream/download/preview/' + image.token + '/?preview_type=16'
      : '';
    return { src: src, alt: (image && image.name) || '' };
  }

  function renderListItemHtml(kind, text, childHtml, snap, normalizedStyle) {
    var liStyle = buildBlockStyle('', snap, '', normalizedStyle);
    var pStyle = buildBlockStyle('margin:0;', snap, '', normalizedStyle);
    var textHtml = text ? '<p style="' + attribs.escapeAttr(pStyle) + '">' + text + '</p>' : '';
    if (!textHtml && !childHtml) return '';
    return '<li data-feishu-list="' + kind + '"' + (liStyle ? ' style="' + attribs.escapeAttr(liStyle) + '"' : '') + '>' + textHtml + childHtml + '</li>';
  }

  function blockToHtml(snap, block, childHtmlArr, context) {
    var ctx = context || {};
    var locationOrigin = ctx.locationOrigin || '';
    var type = snap && snap.type;
    var text = attribs.decodeBlockHtml(snap, { normalizeColor: styleCodec.normalizeCssColor });
    var childHtml = childHtmlArr ? sanitizer.finalizeHtmlFragment(childHtmlArr.join('\n')) : '';
    var normalizedBlockStyle = styleCodec.normalizeBlockStyle(snap);
    var headingTag = getHeadingTagName(type);

    if (headingTag) {
      return wrapWithStyleTag(headingTag, buildBlockStyle(DEFAULT_HEADING_STYLE, snap, '', normalizedBlockStyle), text);
    }

    switch (type) {
      case 'text':
        if (childHtml && text) return '<p style="' + attribs.escapeAttr(buildBlockStyle(DEFAULT_PARAGRAPH_STYLE, snap, '', normalizedBlockStyle)) + '">' + text + '</p>' + childHtml;
        if (childHtml) return childHtml;
        return '<p style="' + attribs.escapeAttr(buildBlockStyle(DEFAULT_PARAGRAPH_STYLE, snap, '', normalizedBlockStyle)) + '">' + text + '</p>';
      case 'ordered':
        return renderListItemHtml('ordered', text, childHtml, snap, normalizedBlockStyle);
      case 'bullet':
        return renderListItemHtml('bullet', text, childHtml, snap, normalizedBlockStyle);
      case 'todo':
        return renderListItemHtml('bullet', (snap.checked ? '☑ ' : '☐ ') + text, childHtml, snap, normalizedBlockStyle);
      case 'divider':
        return '<hr style="border:none;border-top:1px solid #d0d7de;margin:24px 0;">';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '<pre style="' + attribs.escapeAttr(buildBlockStyle('margin:0.75em 0;background:#f6f8fa;padding:12px 16px;border-radius:8px;overflow:auto;white-space:pre-wrap;', snap, '', normalizedBlockStyle)) + '"><code'
          + (lang ? ' class="language-' + attribs.escapeAttr(lang) + '"' : '')
          + ' style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">'
          + attribs.escapeHtml(attribs.decodeBlockText(snap))
          + '</code></pre>';
      case 'image':
        var imageAsset = getImageAssetInfo(snap.image, locationOrigin);
        var caption = '';
        var imageAlign = styleCodec.resolveImageAlign(normalizedBlockStyle);
        var imageMargin = imageAlign === 'left' ? 'margin:0 auto 0 0;' : imageAlign === 'right' ? 'margin:0 0 0 auto;' : 'margin:0 auto;';
        if (snap.image && snap.image.caption && snap.image.caption.text) {
          var capText = attribs.decodeBlockHtml({ text: snap.image.caption.text }, { normalizeColor: styleCodec.normalizeCssColor });
          if (capText) caption = '<figcaption style="margin-top:8px;color:#57606a;font-size:13px;">' + capText + '</figcaption>';
        }
        var imageMeta = buildImageClipboardMetadata(snap, normalizedBlockStyle);
        return '<figure class="block docx-image-block" data-block-type="image"'
          + ' data-block-id="' + attribs.escapeAttr(imageMeta.blockId) + '"'
          + ' data-record-id="' + attribs.escapeAttr(imageMeta.recordId) + '"'
          + ' data-lark-record-data="' + attribs.escapeAttr(imageMeta.recordData) + '"'
          + ' data-meta-block-props="' + attribs.escapeAttr(imageMeta.metaBlockProps) + '"'
          + ' style="' + attribs.escapeAttr(buildBlockStyle('margin:1em 0;text-align:' + imageAlign + ';', snap, '', normalizedBlockStyle, { applyAlign: false })) + '">'
          + '<img src="' + attribs.escapeAttr(imageAsset.src) + '" alt="' + attribs.escapeAttr(imageAsset.alt) + '" style="max-width:100%;height:auto;display:block;' + imageMargin + '" />'
          + caption + '</figure>';
      case 'callout':
        var emoji = styleCodec.getEmoji(normalizedBlockStyle.calloutEmojiId);
        var bgColor = normalizedBlockStyle.backgroundColor;
        var borderColor = normalizedBlockStyle.borderColor;
        var calloutTextHtml = text ? '<p style="margin:0;">' + text + '</p>' : '';
        var calloutBodyHtml = styleCodec.selectPrimaryCalloutContent(calloutTextHtml, childHtml);
        var calloutRecordId = block && block.record && block.record.id ? block.record.id : nextSyntheticId('callout_record');
        return '<div class="zoneType-calloutBlock old-record-id-' + attribs.escapeAttr(calloutRecordId) + '">'
          + '<div class="callout-container" data-emoji-id="' + attribs.escapeAttr(normalizedBlockStyle.calloutEmojiId) + '">'
          + '<div class="callout-block" style="background-color:' + attribs.escapeAttr(bgColor || '') + ';border-color:' + attribs.escapeAttr(borderColor || '') + ';border-radius:8px;">'
          + calloutBodyHtml
          + '</div></div></div>';
      case 'quote_container':
        return '<blockquote style="' + attribs.escapeAttr(buildBlockStyle('margin:0.75em 0;border-left:4px solid #d0d7de;padding-left:1em;color:#57606a;', snap, '', normalizedBlockStyle)) + '">' + childHtml + '</blockquote>';
      case 'grid':
        return '<div style="display:flex;gap:12px;">' + childHtml + '</div>';
      case 'grid_column':
        var w = snap.width_ratio ? (snap.width_ratio * 100).toFixed(1) : '50';
        return '<div style="flex:' + w + '%;">' + childHtml + '</div>';
      case 'table':
        return tableToHtml(snap, block);
      case 'table_cell':
        return childHtml || '<p></p>';
      case 'diagram':
      case 'whiteboard':
      case 'synced_reference':
        return renderHtmlPlaceholder(SPECIAL_BLOCK_LABELS[type]);
      default:
        return text ? '<p style="' + DEFAULT_PARAGRAPH_STYLE + '">' + text + '</p>' : '';
    }
  }

  function blockToMarkdown(snap, block, childMdArr, context) {
    var ctx = context || {};
    var locationOrigin = ctx.locationOrigin || '';
    var type = snap && snap.type;
    var text = attribs.decodeBlockText(snap);
    var childMd = childMdArr ? childMdArr.join('\n') : '';
    var headingPrefix = getHeadingMarkdownPrefix(type);
    if (headingPrefix) return headingPrefix + ' ' + text;

    switch (type) {
      case 'text':
        if (childMd) return text + '\n' + childMd;
        return text;
      case 'ordered':
        return renderMarkdownListItem('1. ', text, childMd);
      case 'bullet':
        return renderMarkdownListItem('- ', text, childMd);
      case 'todo':
        return (snap.checked ? '[x]' : '[ ]') + ' ' + text;
      case 'divider':
        return '---';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '```' + lang + '\n' + text + '\n```';
      case 'image':
        var imageAsset = getImageAssetInfo(snap && snap.image, locationOrigin);
        return '![' + imageAsset.alt + '](' + imageAsset.src + ')';
      case 'callout':
        var calloutType = styleCodec.getCalloutMarkdownType(snap);
        var calloutLines = ['[!' + calloutType + ']'];
        var calloutContent = styleCodec.selectPrimaryCalloutContent(text, childMd);
        if (calloutContent) calloutLines.push(calloutContent);
        return renderMarkdownBlockquote(calloutLines.join('\n'));
      case 'quote_container':
        return renderMarkdownBlockquote(childMd);
      case 'grid':
      case 'grid_column':
        return childMd;
      case 'table':
        return tableToMarkdown(snap, block);
      case 'table_cell':
        return childMd;
      case 'diagram':
      case 'whiteboard':
      case 'synced_reference':
        return renderMarkdownPlaceholder(SPECIAL_BLOCK_LABELS[type]);
      default:
        return text;
    }
  }

  // Walk a structService rootBlock and produce {html, text, blockCount,
  // equationCount, blockTypeCounts, imageBlockCount} ready for clipboard
  // payload assembly.  context.calloutStyleResolver(blockId) -> {bg, border}
  // patches missing snapshot styles from the rendered DOM.
  function renderRootBlock(rootBlock, context) {
    var ctx = context || {};
    var resolveCalloutStyle = typeof ctx.calloutStyleResolver === 'function'
      ? ctx.calloutStyleResolver
      : function () { return { background_color: '', border_color: '' }; };
    var locationOrigin = ctx.locationOrigin || '';
    var maxDepth = Number(ctx.maxDepth || 12);

    var htmlParts = [];
    var mdParts = [];
    var blockCount = 0;
    var equationCount = 0;
    var blockTypeCounts = {};
    var imageBlockCount = 0;
    var equationBlockCount = 0;

    function processInner(block, depth) {
      if (!block || depth > maxDepth) return null;
      if (!block.record || !block.record.snapshot) return null;
      var snap = block.record.snapshot;
      var children = collectChildren(block, depth + 1);
      return {
        html: blockToHtml(snap, block, children.html, { locationOrigin: locationOrigin }),
        md: blockToMarkdown(snap, block, children.md, { locationOrigin: locationOrigin }),
      };
    }

    function collectChildren(block, depth) {
      var html = [];
      var md = [];
      getBlockChildren(block).forEach(function (child) {
        var rendered = processInner(child, depth);
        if (!rendered) return;
        if (rendered.html) html.push(rendered.html);
        if (rendered.md) md.push(rendered.md);
      });
      return { html: html, md: md };
    }

    function processTopBlock(block, depth) {
      if (!block || depth > maxDepth) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        var type = snap.type;
        if (type === 'page') {
          getBlockChildren(block).forEach(function (child) { processTopBlock(child, depth + 1); });
          return;
        }

        if (type === 'callout' && !snap.background_color) {
          var domStyle = resolveCalloutStyle(block.record.id);
          if (domStyle.background_color) snap.background_color = domStyle.background_color;
          if (domStyle.border_color) snap.border_color = domStyle.border_color;
        }

        blockTypeCounts[type] = (blockTypeCounts[type] || 0) + 1;
        var decoded = attribs.decodeBlockText(snap);
        if (type === 'image') imageBlockCount++;
        if (decoded.indexOf('$') !== -1) {
          equationCount++;
          equationBlockCount++;
        }

        var children = collectChildren(block, depth + 1);
        var html = blockToHtml(snap, block, children.html, { locationOrigin: locationOrigin });
        var md = blockToMarkdown(snap, block, children.md, { locationOrigin: locationOrigin });
        if (html) htmlParts.push(html);
        if (md) mdParts.push(md);
        blockCount++;
        return;
      }
      getBlockChildren(block).forEach(function (child) { processTopBlock(child, depth + 1); });
    }

    processTopBlock(rootBlock, 0);

    return {
      htmlParts: htmlParts,
      mdParts: mdParts,
      blockCount: blockCount,
      equationCount: equationCount,
      equationBlockCount: equationBlockCount,
      imageBlockCount: imageBlockCount,
      blockTypeCounts: blockTypeCounts,
    };
  }

  function buildDocxRecordPayload(rootBlock, options) {
    if (!rootBlock) return null;
    var maxDepth = Number((options && options.maxDepth) || 12);
    var recordMap = {};
    var blockIds = [];
    var recordIds = [];
    var rootId = '';
    var payloadMap = {};

    function walk(block, depth, parentBlock) {
      if (!block || depth > maxDepth) return;
      if (block.record && block.record.id && block.record.snapshot) {
        var snap = block.record.snapshot;
        var recordId = block.record.id;
        var cleanSnap = docxRecord.sanitizeSnapshotForRecord(snap);
        recordMap[recordId] = { id: recordId, snapshot: cleanSnap };

        if (cleanSnap.type === 'page') {
          if (!rootId) rootId = recordId;
        } else {
          var parentSnap = parentBlock && parentBlock.record && parentBlock.record.snapshot;
          var isDirectChildOfPage = parentSnap && parentSnap.type === 'page';
          if (isDirectChildOfPage) {
            recordIds.push(recordId);
            blockIds.push(recordIds.length + 1);
          } else if (parentSnap && parentSnap.type !== 'page') {
            payloadMap[recordId] = { level: depth };
          }
        }
      }
      getBlockChildren(block).forEach(function (child) { walk(child, depth + 1, block); });
    }

    walk(rootBlock, 0, null);
    if (!rootId || !recordIds.length) return null;

    return {
      isCut: false,
      rootId: rootId,
      parentId: rootId,
      blockIds: blockIds,
      recordIds: recordIds,
      recordMap: recordMap,
      payloadMap: payloadMap,
      extra: {
        channel: 'saas',
        pasteRandomId: docxRecord.generateRandomId(),
        mention_page_title: {},
        external_mention_url: {},
        isEqualBlockSelection: true,
      },
      isKeepQuoteContainer: false,
      selection: recordIds.map(function (rid, i) {
        return { id: i + 2, type: 'block', recordId: rid };
      }),
      pasteFlag: docxRecord.generateRandomId(),
    };
  }

  return {
    blockToHtml: blockToHtml,
    blockToMarkdown: blockToMarkdown,
    buildBlockStyle: buildBlockStyle,
    buildCalloutClipboardMetadata: buildCalloutClipboardMetadata,
    buildDocxRecordPayload: buildDocxRecordPayload,
    buildImageClipboardMetadata: buildImageClipboardMetadata,
    buildTableMatrix: buildTableMatrix,
    getBlockChildren: getBlockChildren,
    getImageAssetInfo: getImageAssetInfo,
    renderRootBlock: renderRootBlock,
    tableToHtml: tableToHtml,
    tableToMarkdown: tableToMarkdown,
  };
}

module.exports = {
  createBlockRenderer: createBlockRenderer,
};
