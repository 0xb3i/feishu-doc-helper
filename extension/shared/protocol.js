(function (root, factory) {
  'use strict';

  var protocol = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = protocol;
  }
  if (root) root.FeishuExtensionProtocol = protocol;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MESSAGES = Object.freeze({
    UI: 'FEISHU_EXTENSION_UI',
    PROGRESS: 'FEISHU_EXTENSION_PROGRESS',
    PROGRESS_QUERY: 'FEISHU_EXTENSION_PROGRESS_QUERY',
    IMAGE_FETCH: 'FEISHU_EXTENSION_IMAGE_FETCH',
    CLIPBOARD_WRITE: 'FEISHU_EXTENSION_CLIPBOARD_WRITE',
    CLIPBOARD_WRITE_TARGET: 'FEISHU_EXTENSION_CLIPBOARD_WRITE_TARGET',
    PENDING_PASTE: 'FEISHU_EXTENSION_PENDING_PASTE',
  });

  var DOM_EVENTS = Object.freeze({
    UI_ACTION: 'feishu-helper:ui-action',
    UI_RESULT: 'feishu-helper:ui-result',
    UI_PROGRESS: 'feishu-helper:ui-progress',
    IMAGE_FETCH: 'feishu-helper:image-fetch',
    IMAGE_FETCH_RESULT: 'feishu-helper:image-fetch-result',
    PENDING_PASTE: 'feishu-helper:pending-paste',
    PENDING_PASTE_RESULT: 'feishu-helper:pending-paste-result',
    WHITEBOARD_NATIVE: 'feishu-helper:whiteboard-native',
    WHITEBOARD_NATIVE_RESULT: 'feishu-helper:whiteboard-native-result',
    CLIPBOARD_TRANSFER: 'feishu-helper:clipboard-transfer',
    CLIPBOARD_TRANSFER_RESULT: 'feishu-helper:clipboard-transfer-result',
  });

  var ACTIONS = Object.freeze({
    EXTRACT: 'extract',
    PASTE: 'paste',
    PREPARE_NATIVE_PASTE: 'prepareNativePaste',
    SNAPSHOT: 'snapshot',
    SCAN: 'scan',
    IMAGES: 'images',
  });

  var PENDING_OPS = Object.freeze({
    GET: 'get',
    SET: 'set',
    DELETE: 'delete',
  });

  var NATIVE_MESSAGING = Object.freeze({
    HOST_NAME: 'com.feishu_doc_helper.whiteboard',
    REQUEST_TYPE: 'FEISHU_HELPER_WHITEBOARD_REQUEST',
    OPS: Object.freeze({
      INSPECT: 'inspect',
      EXPORT: 'export',
      PREFLIGHT: 'preflight',
      APPLY: 'apply',
      RECONCILE_IMAGES: 'reconcileImages',
      DISCARD: 'discard',
    }),
  });

  var LIMITS = Object.freeze({
    FETCH_TIMEOUT_MS: 15000,
    IMAGE_GESTURE_TTL_MS: 15000,
    MAX_ACTION_PAYLOAD_BYTES: 1024 * 1024,
    MAX_IMAGE_BYTES: 20 * 1024 * 1024,
    MAX_IMAGE_DIMENSION: 1000000,
    MAX_IMAGE_TOKEN_LENGTH: 1024,
    MAX_IMAGE_URL_LENGTH: 4096,
    MAX_PENDING_IMAGE_COUNT: 500,
    MAX_PENDING_IMAGE_ENCODED_BYTES: 48 * 1024 * 1024,
    MAX_PENDING_PAYLOAD_BYTES: 64 * 1024 * 1024,
    MAX_CLIPBOARD_PAYLOAD_BYTES: 8 * 1024 * 1024,
    PENDING_TTL_MS: 60 * 60 * 1000,
    PENDING_FUTURE_SKEW_MS: 60 * 1000,
    MAX_PROGRESS_LABEL_LENGTH: 256,
    MAX_REQUEST_ID_LENGTH: 160,
    MAX_WHITEBOARD_COUNT: 100,
    MAX_WHITEBOARD_ID_LENGTH: 256,
    MAX_WHITEBOARD_MARKER_LENGTH: 256,
    MAX_WHITEBOARD_PAGE_DETAIL_BYTES: 4 * 1024 * 1024,
    MAX_WHITEBOARD_PAGE_DETAIL_TOTAL_BYTES: 16 * 1024 * 1024,
    MAX_WHITEBOARD_PAGE_DETAIL_NODES: 20000,
    MAX_WHITEBOARD_PAGE_DETAIL_DEPTH: 64,
    MAX_WHITEBOARD_ASSET_COUNT: 500,
  });

  var DOCUMENT_HOST_SUFFIXES = Object.freeze([
    'feishu.cn',
    'larksuite.com',
    'larkoffice.com',
  ]);
  var DOCUMENT_PATH_SEGMENTS = Object.freeze(['docx', 'wiki', 'doc', 'docs']);
  var CDN_HOST_SUFFIXES = Object.freeze([
    'feishucdn.com',
    'larksuitecdn.com',
    'byteimg.com',
  ]);
  var DOCUMENT_PATH_RE = /^\/(?:docx|docs?|wiki)\/[A-Za-z0-9_-]+(?:[/?#]|$)/i;
  var FEISHU_IMAGE_API_PATH_RE = /^\/space\/api\/box\/stream\/download\/(?:preview\/|v2\/cover\/|all\/)/i;
  var FEISHU_CHART_IMAGE_API_PATH_RE = /^\/space\/api\/file\/f\/cdp-chart-[A-Za-z0-9_-]+~noop\/$/i;

  var UI_ACTION_SET = Object.freeze((function () {
    var values = {};
    Object.keys(ACTIONS).forEach(function (key) { values[ACTIONS[key]] = true; });
    return values;
  })());

  var PENDING_OP_SET = Object.freeze((function () {
    var values = {};
    Object.keys(PENDING_OPS).forEach(function (key) { values[PENDING_OPS[key]] = true; });
    return values;
  })());

  var ACTION_PENDING_OPS = Object.freeze({
    extract: Object.freeze({ set: true }),
    // Target pages may only read canonical source data; expiry is enforced by
    // the service worker and never delegated to page-controlled events.
    paste: Object.freeze({ get: true }),
    prepareNativePaste: Object.freeze({ get: true }),
  });

  function hostMatchesSuffix(hostname, suffix) {
    var host = String(hostname || '').toLowerCase();
    var expected = String(suffix || '').toLowerCase();
    return host === expected || host.endsWith('.' + expected);
  }

  function buildDocumentMatchPatterns() {
    var patterns = [];
    DOCUMENT_HOST_SUFFIXES.forEach(function (host) {
      DOCUMENT_PATH_SEGMENTS.forEach(function (pathSegment) {
        patterns.push('https://*.' + host + '/' + pathSegment + '/*');
      });
    });
    return patterns;
  }

  function hostMatchesAnySuffix(hostname, suffixes) {
    return suffixes.some(function (suffix) { return hostMatchesSuffix(hostname, suffix); });
  }

  function parseHttpsUrl(value) {
    var source = String(value || '');
    if (!source || source.length > LIMITS.MAX_IMAGE_URL_LENGTH) return null;
    try {
      var url = new URL(source);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      if (url.port && url.port !== '443') return null;
      return url;
    } catch (error) {
      return null;
    }
  }

  function isSupportedDocumentUrl(value) {
    var url = parseHttpsUrl(value);
    if (!url || !hostMatchesAnySuffix(url.hostname, DOCUMENT_HOST_SUFFIXES)) return false;
    return DOCUMENT_PATH_RE.test(url.pathname + url.search + url.hash);
  }

  function isTrustedDocumentMediaHost(hostname) {
    var host = String(hostname || '').toLowerCase();
    if (!hostMatchesAnySuffix(host, DOCUMENT_HOST_SUFFIXES)) return false;
    var label = host.split('.')[0];
    return label === 'internal-api-drive-stream' || label.indexOf('internal-api-drive-stream-') === 0;
  }

  function isUiAction(action) {
    return !!UI_ACTION_SET[String(action || '')];
  }

  function isPendingOp(op) {
    return !!PENDING_OP_SET[String(op || '')];
  }

  function isPendingOpAllowed(action, op) {
    var allowed = ACTION_PENDING_OPS[String(action || '')];
    return !!(allowed && allowed[String(op || '')]);
  }

  function utf8ByteLength(value) {
    var text = String(value == null ? '' : value);
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function getJsonByteLength(value) {
    try {
      var json = JSON.stringify(value);
      return typeof json === 'string' ? utf8ByteLength(json) : -1;
    } catch (error) {
      return -1;
    }
  }

  function validateRequestId(requestId) {
    var value = String(requestId || '');
    return !!value && value.length <= LIMITS.MAX_REQUEST_ID_LENGTH;
  }

  function normalizeProgressNumber(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    return Math.min(Math.floor(number), 1000000);
  }

  function normalizeProgressLabel(value) {
    return String(value || '').slice(0, LIMITS.MAX_PROGRESS_LABEL_LENGTH);
  }

  function validateActionPayload(payload) {
    if (payload == null) return { ok: true, bytes: 0 };
    var bytes = getJsonByteLength(payload);
    return bytes >= 0 && bytes <= LIMITS.MAX_ACTION_PAYLOAD_BYTES
      ? { ok: true, bytes: bytes }
      : { ok: false, error: 'action payload is invalid or too large' };
  }

  function findUnsupportedField(value, allowedFields) {
    var fields = Object.keys(value || {});
    for (var i = 0; i < fields.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(allowedFields, fields[i])) return fields[i];
    }
    return '';
  }

  function hasOwnField(value, field) {
    return !!value && Object.prototype.hasOwnProperty.call(value, field);
  }

  function isBoundedIdentifier(value, maxLength) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= maxLength
      && /^[A-Za-z0-9_-]+$/.test(value);
  }

  function isBundleId(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function base64CharacterValue(code) {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (code === 43) return 62;
    if (code === 47) return 63;
    return -1;
  }

  function validateImageDataUrl(value) {
    if (typeof value !== 'string' || !value) {
      return { ok: false, error: 'pending image data must be a non-empty data URL' };
    }
    if (value.slice(0, 5) !== 'data:') {
      return { ok: false, error: 'pending image data URL has an unsupported MIME or encoding' };
    }
    var separatorIndex = value.indexOf(';base64,', 5);
    if (separatorIndex <= 5 || value.indexOf(';', 5) !== separatorIndex) {
      return { ok: false, error: 'pending image data URL has an unsupported MIME or encoding' };
    }
    var mime = value.slice(5, separatorIndex);
    if (!isAllowedImageMime(mime)) {
      return { ok: false, error: 'pending image data URL has an unsupported MIME or encoding' };
    }
    var encoded = value.slice(separatorIndex + 8);
    if (!encoded || encoded.length % 4 !== 0) {
      return { ok: false, error: 'pending image data URL contains malformed base64' };
    }
    var padding = encoded.slice(-2) === '==' ? 2 : (encoded.slice(-1) === '=' ? 1 : 0);
    var contentLength = encoded.length - padding;
    if ((padding === 0 && contentLength % 4 !== 0)
      || (padding === 1 && contentLength % 4 !== 3)
      || (padding === 2 && contentLength % 4 !== 2)) {
      return { ok: false, error: 'pending image data URL contains malformed base64' };
    }
    for (var i = 0; i < contentLength; i++) {
      if (base64CharacterValue(encoded.charCodeAt(i)) < 0) {
        return { ok: false, error: 'pending image data URL contains malformed base64' };
      }
    }
    for (var j = contentLength; j < encoded.length; j++) {
      if (encoded.charCodeAt(j) !== 61) {
        return { ok: false, error: 'pending image data URL contains malformed base64' };
      }
    }
    var lastValue = base64CharacterValue(encoded.charCodeAt(contentLength - 1));
    if ((padding === 1 && (lastValue & 3) !== 0)
      || (padding === 2 && (lastValue & 15) !== 0)) {
      return { ok: false, error: 'pending image data URL contains non-canonical base64' };
    }
    var decodedBytes = (encoded.length / 4) * 3 - padding;
    if (decodedBytes <= 0 || decodedBytes > LIMITS.MAX_IMAGE_BYTES) {
      return { ok: false, error: 'pending image exceeds decoded size limit' };
    }
    return {
      ok: true,
      mime: normalizeImageMime(mime),
      decodedBytes: decodedBytes,
      encodedBytes: encoded.length,
    };
  }

  function validatePendingImageList(value, allowEmptyBase64) {
    if (value == null) return { ok: true, encodedBytes: 0 };
    if (!Array.isArray(value)) return { ok: false, error: 'pending image list must be an array' };
    if (value.length > LIMITS.MAX_PENDING_IMAGE_COUNT) {
      return { ok: false, error: 'pending image list exceeds item limit' };
    }

    var allowedFields = { token: true, base64: true, width: true, height: true };
    var totalEncodedBytes = 0;
    for (var i = 0; i < value.length; i++) {
      var image = value[i];
      if (!image || typeof image !== 'object' || Array.isArray(image)) {
        return { ok: false, error: 'pending image entry must be an object' };
      }
      var unknownField = findUnsupportedField(image, allowedFields);
      if (unknownField) {
        return { ok: false, error: 'pending image entry has an unsupported field: ' + unknownField };
      }
      if (!hasOwnField(image, 'token') || typeof image.token !== 'string' || !image.token
        || image.token.length > LIMITS.MAX_IMAGE_TOKEN_LENGTH
        || !/^[A-Za-z0-9_.~-]+$/.test(image.token)) {
        return { ok: false, error: 'pending image token is invalid' };
      }
      if (!hasOwnField(image, 'base64') || typeof image.base64 !== 'string') {
        return { ok: false, error: 'pending image base64 must be a string' };
      }
      if (!image.base64 && !allowEmptyBase64) {
        return { ok: false, error: 'pending image base64 must be a non-empty data URL' };
      }
      if (image.base64) {
        var dataUrlValidation = validateImageDataUrl(image.base64);
        if (!dataUrlValidation.ok) return dataUrlValidation;
        totalEncodedBytes += dataUrlValidation.encodedBytes;
        if (totalEncodedBytes > LIMITS.MAX_PENDING_IMAGE_ENCODED_BYTES) {
          return { ok: false, error: 'pending image list exceeds aggregate encoded size limit' };
        }
      }
      var dimensionFields = ['width', 'height'];
      for (var j = 0; j < dimensionFields.length; j++) {
        var dimension = image[dimensionFields[j]];
        if (dimension != null && (!Number.isFinite(dimension) || dimension < 0
          || dimension > LIMITS.MAX_IMAGE_DIMENSION)) {
          return { ok: false, error: 'pending image dimension is invalid: ' + dimensionFields[j] };
        }
      }
    }
    return { ok: true, encodedBytes: totalEncodedBytes };
  }

  function validateWhiteboardPageDetailNodes(nodes, depth, state) {
    if (!Array.isArray(nodes) || depth > LIMITS.MAX_WHITEBOARD_PAGE_DETAIL_DEPTH) {
      return { ok: false, error: 'whiteboard PageDetail nodes are invalid' };
    }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return { ok: false, error: 'whiteboard PageDetail node must be an object' };
      }
      var unknown = findUnsupportedField(node, { id: true, info: true, children: true });
      if (unknown || typeof node.id !== 'string' || !node.id
        || node.id.length > LIMITS.MAX_WHITEBOARD_ID_LENGTH
        || !node.info || typeof node.info !== 'object' || Array.isArray(node.info)
        || !Array.isArray(node.children)) {
        return { ok: false, error: 'whiteboard PageDetail node shape is invalid' };
      }
      state.count += 1;
      if (state.count > LIMITS.MAX_WHITEBOARD_PAGE_DETAIL_NODES) {
        return { ok: false, error: 'whiteboard PageDetail node count exceeds limit' };
      }
      var childValidation = validateWhiteboardPageDetailNodes(node.children, depth + 1, state);
      if (!childValidation.ok) return childValidation;
    }
    return { ok: true };
  }

  function validateWhiteboardPageDetail(value, expectedNodeCount) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'whiteboard PageDetail must be an object' };
    }
    var unknown = findUnsupportedField(value, {
      nodes: true, meta: true, comments: true, resources: true, ops: true,
    });
    if (unknown || !Array.isArray(value.nodes) || !value.comments
      || typeof value.comments !== 'object' || Array.isArray(value.comments)
      || !Array.isArray(value.resources) || !Array.isArray(value.ops)
      || !value.meta || typeof value.meta !== 'object' || Array.isArray(value.meta)) {
      return { ok: false, error: 'whiteboard PageDetail shape is invalid' };
    }
    var state = { count: 0 };
    var nodeValidation = validateWhiteboardPageDetailNodes(value.nodes, 0, state);
    if (!nodeValidation.ok) return nodeValidation;
    if (Number.isInteger(expectedNodeCount) && state.count !== expectedNodeCount) {
      return { ok: false, error: 'whiteboard PageDetail node count does not match source export' };
    }
    var bytes = getJsonByteLength(value);
    if (bytes <= 0 || bytes > LIMITS.MAX_WHITEBOARD_PAGE_DETAIL_BYTES) {
      return { ok: false, error: 'whiteboard PageDetail exceeds size limit' };
    }
    return { ok: true, bytes: bytes, nodeCount: state.count };
  }

  function validateBrowserWhiteboardBoards(value, transfer) {
    if (!Array.isArray(value) || value.length !== transfer.boardCount) {
      return { ok: false, error: 'browser whiteboard list must match board count' };
    }
    var slotById = Object.create(null);
    transfer.slots.forEach(function (slot) { slotById[slot.slotId] = slot; });
    var seen = Object.create(null);
    var totalPageBytes = 0;
    var totalAssetCount = 0;
    for (var i = 0; i < value.length; i++) {
      var board = value[i];
      if (!board || typeof board !== 'object' || Array.isArray(board)) {
        return { ok: false, error: 'browser whiteboard entry must be an object' };
      }
      var unknown = findUnsupportedField(board, {
        slotId: true, sourceBlockId: true, sourceWhiteboardToken: true,
        pageDetail: true, assets: true,
      });
      var slot = slotById[board.slotId];
      if (unknown || !slot || seen[board.slotId]
        || board.sourceBlockId !== slot.sourceBlockId
        || !isBoundedIdentifier(board.sourceWhiteboardToken, LIMITS.MAX_WHITEBOARD_ID_LENGTH)
        || !Array.isArray(board.assets)) {
        return { ok: false, error: 'browser whiteboard entry identity is invalid' };
      }
      seen[board.slotId] = true;
      var pageValidation = validateWhiteboardPageDetail(board.pageDetail, slot.nodeCount);
      if (!pageValidation.ok) return pageValidation;
      totalPageBytes += pageValidation.bytes;
      if (totalPageBytes > LIMITS.MAX_WHITEBOARD_PAGE_DETAIL_TOTAL_BYTES) {
        return { ok: false, error: 'browser whiteboard PageDetail total exceeds size limit' };
      }
      var assetKeys = Object.create(null);
      for (var j = 0; j < board.assets.length; j++) {
        var asset = board.assets[j];
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)
          || findUnsupportedField(asset, { sourceKey: true, dataUrl: true })
          || !isBoundedIdentifier(asset.sourceKey, LIMITS.MAX_IMAGE_TOKEN_LENGTH)
          || assetKeys[asset.sourceKey] || typeof asset.dataUrl !== 'string') {
          return { ok: false, error: 'browser whiteboard asset entry is invalid' };
        }
        var dataUrlValidation = validateImageDataUrl(asset.dataUrl);
        if (!dataUrlValidation.ok) return dataUrlValidation;
        assetKeys[asset.sourceKey] = true;
        totalAssetCount += 1;
        if (totalAssetCount > LIMITS.MAX_WHITEBOARD_ASSET_COUNT) {
          return { ok: false, error: 'browser whiteboard asset count exceeds limit' };
        }
      }
    }
    return { ok: true, pageBytes: totalPageBytes, assetCount: totalAssetCount };
  }

  function validateWhiteboardTransfer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'whiteboard transfer must be an object' };
    }
    var allowedFields = {
      schemaVersion: true, bundleId: true, boardCount: true, slots: true, browserBoards: true,
    };
    var unknownField = findUnsupportedField(value, allowedFields);
    if (unknownField) {
      return { ok: false, error: 'whiteboard transfer has an unsupported field: ' + unknownField };
    }
    if (!hasOwnField(value, 'schemaVersion') || value.schemaVersion !== 1) {
      return { ok: false, error: 'whiteboard transfer schema version is unsupported' };
    }
    if (!hasOwnField(value, 'bundleId') || !isBundleId(value.bundleId)) {
      return { ok: false, error: 'whiteboard bundle ID is invalid' };
    }
    if (!hasOwnField(value, 'boardCount') || !Number.isFinite(value.boardCount)
      || Math.floor(value.boardCount) !== value.boardCount
      || value.boardCount < 1 || value.boardCount > LIMITS.MAX_WHITEBOARD_COUNT) {
      return { ok: false, error: 'whiteboard board count is invalid' };
    }
    if (!hasOwnField(value, 'slots') || !Array.isArray(value.slots)
      || value.slots.length !== value.boardCount) {
      return { ok: false, error: 'whiteboard slots must match board count' };
    }

    var slotAllowedFields = { slotId: true, sourceBlockId: true, marker: true, nodeCount: true };
    var slotIds = Object.create(null);
    var sourceBlockIds = Object.create(null);
    for (var i = 0; i < value.slots.length; i++) {
      var slot = value.slots[i];
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
        return { ok: false, error: 'whiteboard slot must be an object' };
      }
      var slotUnknownField = findUnsupportedField(slot, slotAllowedFields);
      if (slotUnknownField) {
        return { ok: false, error: 'whiteboard slot has an unsupported field: ' + slotUnknownField };
      }
      if (!hasOwnField(slot, 'slotId')
        || !/^board-[0-9]{4}$/.test(slot.slotId)) {
        return { ok: false, error: 'whiteboard slot ID is invalid' };
      }
      if (!hasOwnField(slot, 'sourceBlockId')
        || !isBoundedIdentifier(slot.sourceBlockId, LIMITS.MAX_WHITEBOARD_ID_LENGTH)) {
        return { ok: false, error: 'whiteboard source block ID is invalid' };
      }
      if (hasOwnField(slot, 'nodeCount') && (!Number.isInteger(slot.nodeCount)
        || slot.nodeCount < 0 || slot.nodeCount > LIMITS.MAX_WHITEBOARD_PAGE_DETAIL_NODES)) {
        return { ok: false, error: 'whiteboard source node count is invalid' };
      }
      if (slotIds[slot.slotId] || sourceBlockIds[slot.sourceBlockId]) {
        return { ok: false, error: 'whiteboard slot IDs must be unique' };
      }
      slotIds[slot.slotId] = true;
      sourceBlockIds[slot.sourceBlockId] = true;

      var expectedMarker = '[[FEISHU_HELPER_WHITEBOARD:' + value.bundleId + ':' + slot.slotId + ']]';
      if (!hasOwnField(slot, 'marker') || typeof slot.marker !== 'string'
        || slot.marker.length > LIMITS.MAX_WHITEBOARD_MARKER_LENGTH
        || slot.marker !== expectedMarker) {
        return { ok: false, error: 'whiteboard marker is invalid' };
      }
    }
    if (hasOwnField(value, 'browserBoards')) {
      var browserValidation = validateBrowserWhiteboardBoards(value.browserBoards, value);
      if (!browserValidation.ok) return browserValidation;
    }
    return { ok: true };
  }

  function isPendingFresh(value, now) {
    var timestamp = Number(value && value.ts);
    var currentTime = now == null ? Date.now() : Number(now);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(currentTime)) return false;
    var age = currentTime - timestamp;
    return age >= -LIMITS.PENDING_FUTURE_SKEW_MS && age < LIMITS.PENDING_TTL_MS;
  }

  function validatePendingPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'pending payload must be an object' };
    }
    var bytes = getJsonByteLength(value);
    if (bytes < 0) return { ok: false, error: 'pending payload is not serializable' };
    if (bytes > LIMITS.MAX_PENDING_PAYLOAD_BYTES) {
      return { ok: false, error: 'pending payload exceeds size limit' };
    }

    var schemaVersion = hasOwnField(value, 'schemaVersion') ? value.schemaVersion : 0;
    if (schemaVersion !== 1 && schemaVersion !== 2) {
      return { ok: false, error: 'pending payload schema version is unsupported' };
    }
    var allowedFields = {
      schemaVersion: true, ts: true, savedFromHost: true, savedFromHref: true,
      html: true, text: true, clipboardHtml: true, docxRecord: true, title: true,
      pageIconEmoji: true, hasDowngradedImages: true, hasImagesToInject: true,
      hasImagesToUpload: true, orderedImageBase64List: true, semanticSnapshot: true,
    };
    if (schemaVersion === 2) {
      allowedFields.pendingId = true;
      allowedFields.whiteboardTransfer = true;
    }
    var unknownField = findUnsupportedField(value, allowedFields);
    if (unknownField) return { ok: false, error: 'pending payload has an unsupported field: ' + unknownField };
    if (!hasOwnField(value, 'ts') || !Number.isFinite(value.ts) || value.ts <= 0) {
      return { ok: false, error: 'pending payload timestamp is invalid' };
    }
    if (schemaVersion === 2 && (!hasOwnField(value, 'pendingId')
      || !isBoundedIdentifier(value.pendingId, LIMITS.MAX_REQUEST_ID_LENGTH))) {
      return { ok: false, error: 'pending payload ID is invalid' };
    }

    var stringFields = [
      'html', 'text', 'clipboardHtml', 'docxRecord', 'title', 'pageIconEmoji',
      'savedFromHost', 'savedFromHref',
    ];
    for (var i = 0; i < stringFields.length; i++) {
      var field = stringFields[i];
      if (value[field] != null && typeof value[field] !== 'string') {
        return { ok: false, error: 'pending payload field must be a string: ' + field };
      }
    }
    // Legacy v1 caches could contain unresolved image entries with an empty
    // base64 field. Keep those readable until TTL expiry; newly written v2
    // payloads require every image entry to carry validated bytes.
    var imageListValidation = validatePendingImageList(value.orderedImageBase64List, schemaVersion === 1);
    if (!imageListValidation.ok) return imageListValidation;

    var booleanFields = ['hasDowngradedImages', 'hasImagesToInject', 'hasImagesToUpload'];
    for (var j = 0; j < booleanFields.length; j++) {
      var booleanField = booleanFields[j];
      if (value[booleanField] != null && typeof value[booleanField] !== 'boolean') {
        return { ok: false, error: 'pending payload field must be a boolean: ' + booleanField };
      }
    }
    if (value.semanticSnapshot != null
      && (typeof value.semanticSnapshot !== 'object' || Array.isArray(value.semanticSnapshot))) {
      return { ok: false, error: 'pending semantic snapshot must be an object' };
    }
    if (schemaVersion === 2 && hasOwnField(value, 'whiteboardTransfer')) {
      if (value.whiteboardTransfer == null) {
        return { ok: false, error: 'whiteboard transfer must be an object' };
      }
      var transferValidation = validateWhiteboardTransfer(value.whiteboardTransfer);
      if (!transferValidation.ok) return transferValidation;
    }
    return { ok: true, bytes: bytes, imageEncodedBytes: imageListValidation.encodedBytes };
  }

  function validateClipboardBridgePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'clipboard payload must be an object' };
    }
    var unknownField = findUnsupportedField(value, {
      text: true, html: true, docxRecord: true, imageDataUrl: true, pasteAfterWrite: true,
    });
    if (unknownField) {
      return { ok: false, error: 'clipboard payload has an unsupported field: ' + unknownField };
    }
    var bytes = getJsonByteLength(value);
    if (bytes < 0 || bytes > LIMITS.MAX_CLIPBOARD_PAYLOAD_BYTES) {
      return { ok: false, error: 'clipboard payload exceeds size limit' };
    }
    var fields = ['text', 'html', 'docxRecord'];
    var hasContent = false;
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (value[field] != null && typeof value[field] !== 'string') {
        return { ok: false, error: 'clipboard payload field must be a string: ' + field };
      }
      if (value[field]) hasContent = true;
    }
    if (value.imageDataUrl != null && typeof value.imageDataUrl !== 'string') {
      return { ok: false, error: 'clipboard image payload must be a string' };
    }
    if (value.imageDataUrl) {
      var imageValidation = validateImageDataUrl(value.imageDataUrl);
      if (!imageValidation.ok) return imageValidation;
      hasContent = true;
    }
    if (!hasContent) return { ok: false, error: 'clipboard payload is empty' };
    if (typeof value.pasteAfterWrite !== 'boolean') {
      return { ok: false, error: 'clipboard paste flag must be a boolean' };
    }
    return { ok: true, bytes: bytes };
  }

  function validateNativeMessagingRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'native messaging request must be an object' };
    }
    var allowedFields = {
      type: true, host: true, op: true, action: true,
      bundleId: true, sourceUrl: true, targetUrl: true, images: true,
    };
    var unknownField = findUnsupportedField(value, allowedFields);
    if (unknownField) {
      return { ok: false, error: 'native messaging request has an unsupported field: ' + unknownField };
    }
    if (value.type !== NATIVE_MESSAGING.REQUEST_TYPE) {
      return { ok: false, error: 'native messaging request type is invalid' };
    }
    if (value.host !== NATIVE_MESSAGING.HOST_NAME) {
      return { ok: false, error: 'native messaging host is invalid' };
    }

    var hasOwn = Object.prototype.hasOwnProperty;
    if (!hasOwn.call(value, 'type') || !hasOwn.call(value, 'host')
      || !hasOwn.call(value, 'op') || !hasOwn.call(value, 'action')) {
      return { ok: false, error: 'native messaging request envelope is incomplete' };
    }
    var hasBundleId = hasOwn.call(value, 'bundleId');
    var hasSourceUrl = hasOwn.call(value, 'sourceUrl');
    var hasTargetUrl = hasOwn.call(value, 'targetUrl');
    var op = typeof value.op === 'string' ? value.op : '';
    var action = typeof value.action === 'string' ? value.action : '';
    if (hasSourceUrl && (typeof value.sourceUrl !== 'string' || !isSupportedDocumentUrl(value.sourceUrl))) {
      return { ok: false, error: 'native messaging source URL is invalid' };
    }
    if (hasTargetUrl && (typeof value.targetUrl !== 'string' || !isSupportedDocumentUrl(value.targetUrl))) {
      return { ok: false, error: 'native messaging target URL is invalid' };
    }

    if (op === NATIVE_MESSAGING.OPS.INSPECT) {
      if (action !== ACTIONS.SCAN || !isSupportedDocumentUrl(value.sourceUrl)
        || !hasSourceUrl || hasBundleId || hasTargetUrl) {
        return { ok: false, error: 'native inspect request fields are invalid' };
      }
      return { ok: true, op: op };
    }
    if (op === NATIVE_MESSAGING.OPS.EXPORT) {
      if (action !== ACTIONS.EXTRACT || !isSupportedDocumentUrl(value.sourceUrl)
        || !hasSourceUrl || hasBundleId || hasTargetUrl) {
        return { ok: false, error: 'native export request fields are invalid' };
      }
      return { ok: true, op: op };
    }
    if (op === NATIVE_MESSAGING.OPS.PREFLIGHT || op === NATIVE_MESSAGING.OPS.APPLY) {
      if (action !== ACTIONS.PASTE || !isBundleId(value.bundleId)
        || !hasBundleId || !hasTargetUrl || !isSupportedDocumentUrl(value.targetUrl) || hasSourceUrl) {
        return { ok: false, error: 'native target request fields are invalid' };
      }
      return { ok: true, op: op };
    }
    if (op === NATIVE_MESSAGING.OPS.RECONCILE_IMAGES) {
      if (action !== ACTIONS.PASTE || hasBundleId || hasSourceUrl || !hasTargetUrl
        || !Array.isArray(value.images) || !value.images.length || value.images.length > 500) {
        return { ok: false, error: 'native image reconciliation request fields are invalid' };
      }
      var seenMarkers = Object.create(null);
      var seenBlocks = Object.create(null);
      for (var imageIndex = 0; imageIndex < value.images.length; imageIndex++) {
        var image = value.images[imageIndex];
        if (!image || typeof image !== 'object' || Array.isArray(image)
          || findUnsupportedField(image, { marker: true, targetToken: true, stagingBlockId: true })
          || !/^\[\[FEISHU_HELPER_IMAGE:[a-z0-9]+:[0-9]{4}\]\]$/.test(String(image.marker || ''))
          || !isBoundedIdentifier(image.targetToken, LIMITS.MAX_IMAGE_TOKEN_LENGTH)
          || !isBoundedIdentifier(image.stagingBlockId, LIMITS.MAX_IMAGE_TOKEN_LENGTH)
          || seenMarkers[image.marker] || seenBlocks[image.stagingBlockId]) {
          return { ok: false, error: 'native image reconciliation binding is invalid' };
        }
        seenMarkers[image.marker] = true;
        seenBlocks[image.stagingBlockId] = true;
      }
      return { ok: true, op: op };
    }
    if (op === NATIVE_MESSAGING.OPS.DISCARD) {
      if (action !== ACTIONS.EXTRACT || !hasBundleId
        || !isBundleId(value.bundleId) || hasSourceUrl || hasTargetUrl) {
        return { ok: false, error: 'native discard request fields are invalid' };
      }
      return { ok: true, op: op };
    }
    return { ok: false, error: 'native messaging operation is unsupported' };
  }

  function validateImageUrl(value, documentUrl) {
    var url = parseHttpsUrl(value);
    var documentPageUrl = parseHttpsUrl(documentUrl);
    if (!url) return { ok: false, error: 'image URL must be a bounded HTTPS URL' };

    url.hash = '';
    if (hostMatchesAnySuffix(url.hostname, CDN_HOST_SUFFIXES)) {
      return { ok: true, url: url.href, kind: 'cdn', credentials: 'omit' };
    }

    if (documentPageUrl
      && isSupportedDocumentUrl(documentPageUrl.href)
      && url.origin === documentPageUrl.origin
      && hostMatchesAnySuffix(url.hostname, DOCUMENT_HOST_SUFFIXES)
      && (FEISHU_IMAGE_API_PATH_RE.test(url.pathname)
        || FEISHU_CHART_IMAGE_API_PATH_RE.test(url.pathname))) {
      return { ok: true, url: url.href, kind: 'same-origin-api', credentials: 'include' };
    }

    // 白板 PageDetail 会引用飞书专用 drive-stream 子域；它不是页面同源，
    // 但仍属于受控文档媒体接口。仅允许稳定的官方主机前缀和精确下载路径。
    if (documentPageUrl && isSupportedDocumentUrl(documentPageUrl.href)
      && isTrustedDocumentMediaHost(url.hostname)
      && FEISHU_IMAGE_API_PATH_RE.test(url.pathname)) {
      return { ok: true, url: url.href, kind: 'document-media-api', credentials: 'include' };
    }

    return { ok: false, error: 'image URL is outside the approved CDN/API allowlist' };
  }

  function normalizeImageMime(value) {
    return String(value || '').split(';')[0].trim().toLowerCase();
  }

  function isAllowedImageMime(value) {
    var mime = normalizeImageMime(value);
    return /^image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|heic|heif|tiff|x-icon|vnd\.microsoft\.icon)$/.test(mime);
  }

  function detectImageMime(bytes) {
    var value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    function ascii(offset, length) {
      var text = '';
      for (var i = 0; i < length && offset + i < value.length; i++) {
        text += String.fromCharCode(value[offset + i]);
      }
      return text;
    }
    if (value.length >= 8 && value[0] === 0x89 && ascii(1, 3) === 'PNG'
      && value[4] === 0x0d && value[5] === 0x0a && value[6] === 0x1a && value[7] === 0x0a) return 'image/png';
    if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
    if (value.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
    if (value.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
    if (value.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp';
    if (value.length >= 4 && ((ascii(0, 2) === 'II' && value[2] === 0x2a && value[3] === 0)
      || (ascii(0, 2) === 'MM' && value[2] === 0 && value[3] === 0x2a))) return 'image/tiff';
    if (value.length >= 4 && value[0] === 0 && value[1] === 0 && value[2] === 1 && value[3] === 0) return 'image/x-icon';
    if (value.length >= 12 && ascii(4, 4) === 'ftyp') {
      var brand = ascii(8, 4);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (/^(?:heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'image/heic';
    }
    return '';
  }

  return Object.freeze({
    ACTIONS: ACTIONS,
    CDN_HOST_SUFFIXES: CDN_HOST_SUFFIXES,
    DOCUMENT_HOST_SUFFIXES: DOCUMENT_HOST_SUFFIXES,
    DOM_EVENTS: DOM_EVENTS,
    LIMITS: LIMITS,
    MESSAGES: MESSAGES,
    NATIVE_MESSAGING: NATIVE_MESSAGING,
    PENDING_OPS: PENDING_OPS,
    buildDocumentMatchPatterns: buildDocumentMatchPatterns,
    detectImageMime: detectImageMime,
    isAllowedImageMime: isAllowedImageMime,
    isPendingFresh: isPendingFresh,
    isPendingOp: isPendingOp,
    isPendingOpAllowed: isPendingOpAllowed,
    isSupportedDocumentUrl: isSupportedDocumentUrl,
    isUiAction: isUiAction,
    normalizeProgressLabel: normalizeProgressLabel,
    normalizeProgressNumber: normalizeProgressNumber,
    normalizeImageMime: normalizeImageMime,
    validateActionPayload: validateActionPayload,
    validateClipboardBridgePayload: validateClipboardBridgePayload,
    validateImageUrl: validateImageUrl,
    validateNativeMessagingRequest: validateNativeMessagingRequest,
    validatePendingPayload: validatePendingPayload,
    validateWhiteboardTransfer: validateWhiteboardTransfer,
    validateRequestId: validateRequestId,
  });
});
