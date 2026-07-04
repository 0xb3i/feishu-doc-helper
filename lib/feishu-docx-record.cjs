'use strict';

// Pure helpers around Feishu's docxRecord clipboard payload — token map
// management, image record removal, and token replacement.  These were
// previously duplicated between the userscript and lib/; this module is the
// single source of truth.

function deepCloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pruneRemovedRecordIds(value, removedIds) {
  if (!value || !removedIds || removedIds.size === 0) return value;
  if (Array.isArray(value)) {
    var next = [];
    value.forEach(function (item) {
      if (typeof item === 'string' && removedIds.has(item)) return;
      if (item && typeof item === 'object' && typeof item.recordId === 'string' && removedIds.has(item.recordId)) return;
      next.push(pruneRemovedRecordIds(item, removedIds));
    });
    return next;
  }
  if (typeof value !== 'object') return value;
  Object.keys(value).forEach(function (key) {
    value[key] = pruneRemovedRecordIds(value[key], removedIds);
  });
  return value;
}

function stripStructuredImageAttrsFromHtml(html) {
  if (!html || typeof html !== 'string') return html || '';
  return html.replace(/<figure\b([^>]*)>([\s\S]*?<img\b[^>]*src="data:image\/[^"]+"[^>]*>[\s\S]*?)<\/figure>/gi, function (full, attrs, inner) {
    var cleanedAttrs = String(attrs || '')
      .replace(/\sdata-block-type="[^"]*"/gi, '')
      .replace(/\sdata-block-id="[^"]*"/gi, '')
      .replace(/\sdata-record-id="[^"]*"/gi, '')
      .replace(/\sdata-lark-record-data="[^"]*"/gi, '')
      .replace(/\sdata-meta-block-props="[^"]*"/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    cleanedAttrs = (cleanedAttrs ? cleanedAttrs + ' ' : '') + 'data-feishu-downgraded-images="true"';
    return '<figure ' + cleanedAttrs.trim() + '>' + inner + '</figure>';
  });
}

// Remove image blocks from a deep-cloned copy of `docxRecord` so the paste
// path skips invalid image tokens.  Returns the cloned record (image blocks
// removed) and the html with structured image attrs stripped.
function downgradeStructuredImagesForPaste(options) {
  var config = options || {};
  var originalRecord = config.docxRecord || null;
  var originalHtml = typeof config.html === 'string' ? config.html : '';

  if (!originalRecord || !originalRecord.recordMap || typeof originalRecord.recordMap !== 'object') {
    return {
      docxRecord: originalRecord,
      html: originalHtml,
      removedImageRecordIds: [],
    };
  }

  var imageRecordIds = Object.keys(originalRecord.recordMap).filter(function (recordId) {
    var record = originalRecord.recordMap[recordId];
    return !!(record && record.snapshot && record.snapshot.type === 'image');
  });

  if (!imageRecordIds.length) {
    return {
      docxRecord: originalRecord,
      html: originalHtml,
      removedImageRecordIds: [],
    };
  }

  var removedIds = new Set(imageRecordIds);
  var nextRecord = deepCloneJson(originalRecord);

  if (Array.isArray(nextRecord.recordIds)) {
    var paired = nextRecord.recordIds.map(function (recordId, index) {
      return {
        recordId: recordId,
        blockId: Array.isArray(nextRecord.blockIds) ? nextRecord.blockIds[index] : undefined,
      };
    });
    var kept = paired.filter(function (entry) { return !removedIds.has(entry.recordId); });
    nextRecord.recordIds = kept.map(function (entry) { return entry.recordId; });
    if (Array.isArray(nextRecord.blockIds)) {
      nextRecord.blockIds = kept.map(function (entry) { return entry.blockId; });
    }
  }

  if (Array.isArray(nextRecord.selection)) {
    nextRecord.selection = nextRecord.selection.filter(function (entry) {
      return !(entry && removedIds.has(entry.recordId));
    });
  }

  if (nextRecord.payloadMap && typeof nextRecord.payloadMap === 'object') {
    imageRecordIds.forEach(function (recordId) {
      delete nextRecord.payloadMap[recordId];
    });
  }

  Object.keys(nextRecord.recordMap).forEach(function (recordId) {
    var record = nextRecord.recordMap[recordId];
    if (!record || !record.snapshot) return;
    record.snapshot = pruneRemovedRecordIds(record.snapshot, removedIds);
  });

  imageRecordIds.forEach(function (recordId) {
    delete nextRecord.recordMap[recordId];
  });

  return {
    docxRecord: nextRecord,
    html: stripStructuredImageAttrsFromHtml(originalHtml),
    removedImageRecordIds: imageRecordIds,
  };
}

// Take a token map (oldToken -> newToken) and replace the image tokens inside
// a deep-cloned copy of docxRecord.  Used after the runner uploads images to
// the target document.
function replaceTokensInDocxRecord(docxRecordObj, tokenMap) {
  if (!docxRecordObj || !tokenMap || Object.keys(tokenMap).length === 0) return docxRecordObj;
  var clone = deepCloneJson(docxRecordObj);
  var recordMap = clone.recordMap || {};
  Object.keys(recordMap).forEach(function (recordId) {
    var record = recordMap[recordId];
    if (record && record.snapshot && record.snapshot.type === 'image' && record.snapshot.image) {
      var oldToken = record.snapshot.image.token || '';
      if (oldToken && tokenMap[oldToken]) {
        record.snapshot.image.token = tokenMap[oldToken];
      }
    }
  });
  return clone;
}

// Iterate every image block in docxRecord.recordMap.
function listImageRecords(docxRecordObj) {
  var out = [];
  if (!docxRecordObj || !docxRecordObj.recordMap) return out;
  Object.keys(docxRecordObj.recordMap).forEach(function (recordId) {
    var record = docxRecordObj.recordMap[recordId];
    if (record && record.snapshot && record.snapshot.type === 'image' && record.snapshot.image) {
      out.push({ recordId: recordId, image: record.snapshot.image });
    }
  });
  return out;
}

function generateRandomId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function sanitizeSnapshotForRecord(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  var internalKeys = {
    _reactRootContainer: true,
    _owner: true,
    _store: true,
    _self: true,
    _source: true,
  };
  var internalKeyPrefixes = ['__reactInternalInstance$', '__reactFiber$', '_reactFiber$'];
  function isInternalKey(key) {
    if (internalKeys[key]) return true;
    for (var i = 0; i < internalKeyPrefixes.length; i++) {
      if (key.indexOf(internalKeyPrefixes[i]) === 0) return true;
    }
    return false;
  }
  try {
    return JSON.parse(JSON.stringify(snap, function (key, value) {
      if (isInternalKey(key)) return undefined;
      if (typeof value === 'function' || typeof value === 'symbol') return undefined;
      return value;
    }));
  } catch (e) {
    var out = {};
    Object.keys(snap).forEach(function (k) {
      if (isInternalKey(k)) return;
      var v = snap[k];
      if (typeof v === 'function' || typeof v === 'symbol') return;
      try { JSON.stringify(v); out[k] = v; } catch (e2) {}
    });
    return out;
  }
}

module.exports = {
  deepCloneJson: deepCloneJson,
  downgradeStructuredImagesForPaste: downgradeStructuredImagesForPaste,
  generateRandomId: generateRandomId,
  listImageRecords: listImageRecords,
  pruneRemovedRecordIds: pruneRemovedRecordIds,
  replaceTokensInDocxRecord: replaceTokensInDocxRecord,
  sanitizeSnapshotForRecord: sanitizeSnapshotForRecord,
  stripStructuredImageAttrsFromHtml: stripStructuredImageAttrsFromHtml,
};
