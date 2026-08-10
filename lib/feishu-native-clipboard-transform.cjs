'use strict';

// Pure transformer for Feishu's native clipboard payload. It preserves the
// native docx/record envelope and replaces only whiteboard records with text
// markers, so the target document can paste all other blocks natively before
// whiteboards are reconstructed from PageDetail.

// Keep this aligned with the extension clipboard bridge. A payload accepted
// here must remain writable at the target page without a later size surprise.
var MAX_CLIPBOARD_FIELD_BYTES = 8 * 1024 * 1024;
var HTML_VOID_TAGS = {
  area: true, base: true, br: true, col: true, embed: true, hr: true,
  img: true, input: true, link: true, meta: true, param: true,
  source: true, track: true, wbr: true,
};

function NativeClipboardTransformError(code, message, details) {
  Error.call(this, message);
  this.name = 'NativeClipboardTransformError';
  this.code = code;
  this.message = message;
  if (details !== undefined) this.details = details;
  if (Error.captureStackTrace) Error.captureStackTrace(this, NativeClipboardTransformError);
}
NativeClipboardTransformError.prototype = Object.create(Error.prototype);
NativeClipboardTransformError.prototype.constructor = NativeClipboardTransformError;

function fail(code, message, details) {
  throw new NativeClipboardTransformError(code, message, details);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function countLiteral(value, needle) {
  var source = String(value || '');
  var target = String(needle || '');
  if (!target) return 0;
  var count = 0;
  var offset = 0;
  while (offset <= source.length - target.length) {
    var index = source.indexOf(target, offset);
    if (index < 0) break;
    count += 1;
    offset = index + target.length;
  }
  return count;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildMarkerSnapshot(sourceSnapshot, marker) {
  var source = sourceSnapshot && typeof sourceSnapshot === 'object' ? sourceSnapshot : {};
  var snapshot = {};
  // These fields describe the document tree or block metadata rather than the
  // whiteboard resource. Board-specific token/size/caption fields must not
  // survive in the clipboard payload.
  [
    'parent_id', 'children', 'comments', 'revisions', 'locked', 'hidden',
    'author', 'block_id', 'blockId', 'created_time', 'updated_time',
  ].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(source, key)) snapshot[key] = deepClone(source[key]);
  });
  var text = String(marker || '');
  snapshot.type = 'text';
  snapshot.text = {
    initialAttributedTexts: {
      text: { 0: text },
      attribs: { 0: '+' + text.length.toString(36) },
    },
    apool: { numToAttrib: {} },
  };
  return snapshot;
}

function parseNativeRecord(raw) {
  var value = String(raw || '');
  if (!value || value.length > MAX_CLIPBOARD_FIELD_BYTES) {
    fail('INVALID_DOCX_RECORD', '原生剪贴板缺少可用的 docx/record');
  }
  var parsed;
  try { parsed = JSON.parse(value); }
  catch (error) { fail('INVALID_DOCX_RECORD', '原生 docx/record 不是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !parsed.recordMap || typeof parsed.recordMap !== 'object' || Array.isArray(parsed.recordMap)
    || !Array.isArray(parsed.recordIds)) {
    fail('INVALID_DOCX_RECORD', '原生 docx/record 缺少 recordMap 或 recordIds');
  }
  return parsed;
}

function normalizeTransfer(transfer) {
  if (!transfer || !Array.isArray(transfer.slots) || !transfer.slots.length
    || Number(transfer.boardCount) !== transfer.slots.length) {
    fail('INVALID_TRANSFER', '画板迁移槽位无效');
  }
  var seenSlotIds = {};
  var seenBlockIds = {};
  var seenMarkers = {};
  var slots = transfer.slots.map(function (slot) {
    var normalized = {
      slotId: String(slot && slot.slotId || ''),
      sourceBlockId: String(slot && slot.sourceBlockId || ''),
      marker: String(slot && slot.marker || ''),
    };
    if (!normalized.slotId || !normalized.sourceBlockId || !normalized.marker) {
      fail('INVALID_TRANSFER', '画板迁移槽位字段不完整');
    }
    if (seenSlotIds[normalized.slotId] || seenBlockIds[normalized.sourceBlockId]
      || seenMarkers[normalized.marker]) {
      fail('DUPLICATE_SLOT', '画板迁移槽位包含重复身份');
    }
    seenSlotIds[normalized.slotId] = true;
    seenBlockIds[normalized.sourceBlockId] = true;
    seenMarkers[normalized.marker] = true;
    return normalized;
  });
  return slots;
}

function collectImageRecords(record) {
  var images = [];
  Object.keys(record.recordMap || {}).sort().forEach(function (recordId) {
    var entry = record.recordMap[recordId];
    var snapshot = entry && entry.snapshot;
    if (snapshot && snapshot.type === 'image' && snapshot.image) {
      images.push({
        recordId: recordId,
        token: String(snapshot.image.token || ''),
        snapshot: deepClone(snapshot),
      });
    }
  });
  return images;
}

function resolveSlotRecordKey(recordMap, sourceBlockId) {
  var matches = Object.keys(recordMap || {}).filter(function (recordKey) {
    var record = recordMap[recordKey];
    var snapshot = record && record.snapshot;
    return recordKey === sourceBlockId
      || String(record && record.id || '') === sourceBlockId
      || String(snapshot && snapshot.block_id || '') === sourceBlockId
      || String(snapshot && snapshot.blockId || '') === sourceBlockId;
  });
  if (!matches.length) {
    fail('DOCX_SLOT_MISSING', '原生 docx/record 缺少画板槽位：' + sourceBlockId);
  }
  if (matches.length !== 1) {
    fail('DOCX_SLOT_DUPLICATE', '原生 docx/record 包含重复画板槽位：' + sourceBlockId);
  }
  return matches[0];
}

function readTagEnd(html, start) {
  var quote = '';
  for (var i = start + 1; i < html.length; i++) {
    var ch = html.charAt(i);
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i + 1;
  }
  return -1;
}

function parseTagAttributes(raw, absoluteStart) {
  var attrs = [];
  var head = /^<\/?\s*[^\s/>]+/.exec(raw);
  var offset = head ? head[0].length : 1;
  while (offset < raw.length) {
    while (/\s/.test(raw.charAt(offset))) offset++;
    if (offset >= raw.length || raw.charAt(offset) === '>'
      || (raw.charAt(offset) === '/' && raw.charAt(offset + 1) === '>')) break;
    var attrStart = offset;
    while (offset < raw.length && !/[\s=/>]/.test(raw.charAt(offset))) offset++;
    var name = raw.slice(attrStart, offset).toLowerCase();
    while (/\s/.test(raw.charAt(offset))) offset++;
    var value = '';
    if (raw.charAt(offset) === '=') {
      offset++;
      while (/\s/.test(raw.charAt(offset))) offset++;
      var quote = raw.charAt(offset);
      if (quote === '"' || quote === "'") {
        offset++;
        var valueStart = offset;
        while (offset < raw.length && raw.charAt(offset) !== quote) offset++;
        value = raw.slice(valueStart, offset);
        if (raw.charAt(offset) === quote) offset++;
      } else {
        var unquotedStart = offset;
        while (offset < raw.length && !/[\s>]/.test(raw.charAt(offset))) offset++;
        value = raw.slice(unquotedStart, offset);
      }
    }
    if (name) {
      attrs.push({
        name: name,
        value: value,
        start: absoluteStart + attrStart,
        end: absoluteStart + offset,
      });
    } else offset++;
  }
  return attrs;
}

function tokenizeHtml(html) {
  var tokens = [];
  var offset = 0;
  while (offset < html.length) {
    var start = html.indexOf('<', offset);
    if (start < 0) break;
    if (html.slice(start, start + 4) === '<!--') {
      var commentEnd = html.indexOf('-->', start + 4);
      offset = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    var end = readTagEnd(html, start);
    if (end < 0) break;
    var raw = html.slice(start, end);
    var nameMatch = /^<\s*(\/?)\s*([^\s/>]+)/.exec(raw);
    if (!nameMatch || raw.charAt(1) === '!' || raw.charAt(1) === '?') {
      offset = end;
      continue;
    }
    var name = nameMatch[2].toLowerCase();
    var closing = !!nameMatch[1];
    var selfClosing = /\/\s*>$/.test(raw) || !!HTML_VOID_TAGS[name];
    tokens.push({
      start: start,
      end: end,
      raw: raw,
      name: name,
      closing: closing,
      selfClosing: selfClosing,
      attrs: closing ? [] : parseTagAttributes(raw, start),
      closeEnd: selfClosing ? end : null,
    });
    offset = end;
  }
  var stack = [];
  tokens.forEach(function (token) {
    if (!token.closing && !token.selfClosing) {
      stack.push(token);
      return;
    }
    if (!token.closing) return;
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === token.name) {
        stack[i].closeEnd = token.end;
        stack.length = i;
        return;
      }
    }
  });
  return tokens;
}

function attributeValue(token, name) {
  var target = String(name || '').toLowerCase();
  for (var i = 0; i < token.attrs.length; i++) {
    if (token.attrs[i].name === target) return token.attrs[i].value;
  }
  return '';
}

function chooseWhiteboardHtmlRange(tokens, sourceBlockId) {
  var candidates = tokens.filter(function (token) {
    if (token.closing || token.closeEnd == null) return false;
    return attributeValue(token, 'data-record-id') === sourceBlockId
      || attributeValue(token, 'data-block-id') === sourceBlockId;
  });
  if (!candidates.length) {
    fail('HTML_SLOT_MISSING', '原生 HTML 缺少画板槽位：' + sourceBlockId);
  }
  candidates.sort(function (left, right) {
    return left.start - right.start || right.closeEnd - left.closeEnd;
  });
  var outer = candidates[0];
  var disjoint = candidates.some(function (candidate) {
    return candidate.start < outer.start || candidate.closeEnd > outer.closeEnd;
  });
  if (disjoint) {
    fail('HTML_SLOT_DUPLICATE', '原生 HTML 包含重复画板槽位：' + sourceBlockId);
  }
  return { start: outer.start, end: outer.closeEnd };
}

function removeEmbeddedStructuredRecords(html) {
  var tokens = tokenizeHtml(html);
  var removals = [];
  var removedRecords = 0;
  tokens.forEach(function (token) {
    if (token.closing) return;
    var format = attributeValue(token, 'data-lark-record-format').toLowerCase();
    if (format !== 'docx/record' && format !== 'docx/text') return;
    token.attrs.forEach(function (attr) {
      if (attr.name === 'data-lark-record-format' || attr.name === 'data-lark-record-data') {
        removals.push({ start: attr.start, end: attr.end });
      }
    });
    removedRecords += 1;
  });
  removals.sort(function (left, right) { return right.start - left.start; });
  var result = html;
  removals.forEach(function (range) {
    result = result.slice(0, range.start) + result.slice(range.end);
  });
  return { html: result, removedRecords: removedRecords };
}

function transformHtml(html, slots) {
  var value = String(html || '');
  if (!value || value.length > MAX_CLIPBOARD_FIELD_BYTES) {
    fail('INVALID_HTML', '原生剪贴板缺少可用的 text/html');
  }
  var tokens = tokenizeHtml(value);
  var replacements = slots.map(function (slot) {
    var range = chooseWhiteboardHtmlRange(tokens, slot.sourceBlockId);
    return {
      start: range.start,
      end: range.end,
      value: '<p data-feishu-helper-whiteboard-slot="' + escapeHtml(slot.slotId) + '">'
        + escapeHtml(slot.marker) + '</p>',
    };
  });
  replacements.sort(function (left, right) { return right.start - left.start; });
  var previousStart = value.length;
  replacements.forEach(function (replacement) {
    if (replacement.end > previousStart) {
      fail('HTML_SLOT_OVERLAP', '原生 HTML 的画板槽位互相重叠');
    }
    value = value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end);
    previousStart = replacement.start;
  });
  return removeEmbeddedStructuredRecords(value);
}

function validateMarkerCounts(payload, slots) {
  slots.forEach(function (slot) {
    var fields = {
      text: payload.text,
      html: payload.html,
      docxRecord: payload.docxRecord,
    };
    Object.keys(fields).forEach(function (field) {
      var count = countLiteral(fields[field], slot.marker);
      if (count !== 1) {
        fail('MARKER_COUNT_MISMATCH', field + ' 中的画板标记数量错误', {
          slotId: slot.slotId,
          field: field,
          count: count,
        });
      }
    });
  });
}

function transformNativeClipboardForWhiteboards(
  nativeClipboard,
  whiteboardTransfer,
  markerizedText,
  markerizedHtmlFallback
) {
  var sourceClipboard = nativeClipboard || {};
  var slots = normalizeTransfer(whiteboardTransfer);
  var original = parseNativeRecord(sourceClipboard.docxRecord);
  var transformed = deepClone(original);
  var replacedRecordIds = {};
  var sourceTokens = {};

  slots.forEach(function (slot) {
    var recordKey = resolveSlotRecordKey(transformed.recordMap, slot.sourceBlockId);
    var record = transformed.recordMap[recordKey];
    if (!record || typeof record !== 'object' || !record.snapshot
      || typeof record.snapshot !== 'object') {
      fail('DOCX_SLOT_MISSING', '原生 docx/record 缺少画板槽位：' + slot.sourceBlockId);
    }
    var sourceToken = String(record.snapshot.token || '');
    if (sourceToken) sourceTokens[sourceToken] = true;
    record.snapshot = buildMarkerSnapshot(record.snapshot, slot.marker);
    replacedRecordIds[recordKey] = true;
    slot.recordKey = recordKey;
  });

  Object.keys(original.recordMap).forEach(function (recordId) {
    if (replacedRecordIds[recordId]) return;
    if (!jsonEqual(original.recordMap[recordId], transformed.recordMap[recordId])) {
      fail('NON_WHITEBOARD_RECORD_CHANGED', '非画板 record 被意外修改：' + recordId);
    }
  });
  ['recordIds', 'blockIds', 'selection', 'payloadMap'].forEach(function (field) {
    if (!jsonEqual(original[field], transformed[field])) {
      fail('DOCX_ENVELOPE_CHANGED', '原生 docx/record 的 ' + field + ' 被意外修改');
    }
  });

  var originalImages = collectImageRecords(original);
  var transformedImages = collectImageRecords(transformed);
  if (!jsonEqual(originalImages, transformedImages)) {
    fail('IMAGE_RECORD_CHANGED', '原生正文图片 record 或 token 被意外修改');
  }

  Object.keys(transformed.recordMap).forEach(function (recordId) {
    var snapshot = transformed.recordMap[recordId] && transformed.recordMap[recordId].snapshot;
    if (snapshot && snapshot.type === 'whiteboard') {
      fail('WHITEBOARD_RECORD_REMAINS', '原生 docx/record 仍包含未替换的画板：' + recordId);
    }
  });

  (whiteboardTransfer.browserBoards || []).forEach(function (board) {
    var token = String(board && board.sourceWhiteboardToken || '');
    if (token) sourceTokens[token] = true;
  });
  var docxRecord = JSON.stringify(transformed);
  Object.keys(sourceTokens).forEach(function (token) {
    if (docxRecord.indexOf(token) !== -1) {
      fail('SOURCE_WHITEBOARD_TOKEN_REMAINS', '原生 docx/record 仍包含源画板 token');
    }
  });

  var htmlResult;
  var htmlMode = 'nativeSlotReplacement';
  try {
    htmlResult = transformHtml(sourceClipboard.html, slots);
  } catch (error) {
    // Some Feishu versions serialize whiteboards only in docx/record and omit
    // stable block IDs from text/html. In that case use the independently
    // rendered marker HTML for fallback semantics while keeping the complete
    // native docx/record authoritative for every non-whiteboard component.
    if (!(error && error.code === 'HTML_SLOT_MISSING') || !markerizedHtmlFallback) throw error;
    htmlResult = removeEmbeddedStructuredRecords(String(markerizedHtmlFallback));
    htmlMode = 'markerizedFallback';
  }
  var payload = {
    text: String(markerizedText || ''),
    html: htmlResult.html,
    docxRecord: docxRecord,
  };
  validateMarkerCounts(payload, slots);
  Object.keys(sourceTokens).forEach(function (token) {
    if (payload.html.indexOf(token) !== -1) {
      fail('SOURCE_WHITEBOARD_TOKEN_REMAINS', '原生 HTML 仍包含源画板 token');
    }
  });

  return {
    payload: payload,
    report: {
      mode: 'nativeHybrid',
      slotCount: slots.length,
      replacedRecordIds: slots.map(function (slot) { return slot.recordKey; }),
      imageRecordCount: transformedImages.length,
      embeddedHtmlRecordsRemoved: htmlResult.removedRecords,
      htmlMode: htmlMode,
      externalDocxRecordAuthoritative: true,
    },
  };
}

module.exports = {
  NativeClipboardTransformError: NativeClipboardTransformError,
  buildMarkerSnapshot: buildMarkerSnapshot,
  transformNativeClipboardForWhiteboards: transformNativeClipboardForWhiteboards,
};
