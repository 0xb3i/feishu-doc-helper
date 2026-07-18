'use strict';

// Pure helpers for validating and cloning Feishu docxRecord clipboard payloads,
// replacing image tokens, enumerating image records, and sanitizing snapshots.

function deepCloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

var MAX_DOCX_RECORD_BYTES = 8 * 1024 * 1024;

function sanitizeDocxRecord(raw) {
  var value = String(raw || '');
  if (!value || value.length > MAX_DOCX_RECORD_BYTES) return '';
  try {
    var parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    if (parsed.recordIds && !Array.isArray(parsed.recordIds)) return '';
    if (parsed.recordMap && (typeof parsed.recordMap !== 'object' || Array.isArray(parsed.recordMap))) return '';
    return JSON.stringify(parsed);
  } catch (error) {
    return '';
  }
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
  generateRandomId: generateRandomId,
  listImageRecords: listImageRecords,
  replaceTokensInDocxRecord: replaceTokensInDocxRecord,
  sanitizeDocxRecord: sanitizeDocxRecord,
  sanitizeSnapshotForRecord: sanitizeSnapshotForRecord,
};
