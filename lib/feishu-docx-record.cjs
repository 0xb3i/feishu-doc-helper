'use strict';

// Pure helpers for validating and cloning Feishu docxRecord clipboard payloads,
// enumerating image records, and sanitizing snapshots.

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
  generateRandomId: generateRandomId,
  listImageRecords: listImageRecords,
  sanitizeDocxRecord: sanitizeDocxRecord,
  sanitizeSnapshotForRecord: sanitizeSnapshotForRecord,
};
