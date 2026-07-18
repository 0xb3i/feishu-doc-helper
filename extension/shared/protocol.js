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

  var LIMITS = Object.freeze({
    FETCH_TIMEOUT_MS: 15000,
    IMAGE_GESTURE_TTL_MS: 15000,
    MAX_ACTION_PAYLOAD_BYTES: 1024 * 1024,
    MAX_IMAGE_BYTES: 20 * 1024 * 1024,
    MAX_IMAGE_URL_LENGTH: 4096,
    MAX_PENDING_PAYLOAD_BYTES: 64 * 1024 * 1024,
    PENDING_TTL_MS: 60 * 60 * 1000,
    MAX_PROGRESS_LABEL_LENGTH: 256,
    MAX_REQUEST_ID_LENGTH: 160,
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
    paste: Object.freeze({ get: true, set: true, delete: true }),
    prepareNativePaste: Object.freeze({ get: true, set: true, delete: true }),
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

  function validatePendingPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'pending payload must be an object' };
    }
    var bytes = getJsonByteLength(value);
    if (bytes < 0) return { ok: false, error: 'pending payload is not serializable' };
    if (bytes > LIMITS.MAX_PENDING_PAYLOAD_BYTES) {
      return { ok: false, error: 'pending payload exceeds size limit' };
    }
    var allowedFields = {
      schemaVersion: true, ts: true, savedFromHost: true, savedFromHref: true,
      html: true, text: true, clipboardHtml: true, docxRecord: true, title: true,
      pageIconEmoji: true, hasDowngradedImages: true, hasImagesToInject: true,
      hasImagesToUpload: true, orderedImageBase64List: true, semanticSnapshot: true,
    };
    var unknownField = Object.keys(value).find(function (field) { return !allowedFields[field]; });
    if (unknownField) return { ok: false, error: 'pending payload has an unsupported field: ' + unknownField };
    if (value.schemaVersion !== 1) return { ok: false, error: 'pending payload schema version is unsupported' };
    if (!Number.isFinite(value.ts) || value.ts <= 0) return { ok: false, error: 'pending payload timestamp is invalid' };

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
    if (value.orderedImageBase64List != null && !Array.isArray(value.orderedImageBase64List)) {
      return { ok: false, error: 'pending image list must be an array' };
    }
    if (value.orderedImageBase64List && value.orderedImageBase64List.length > 500) {
      return { ok: false, error: 'pending image list exceeds item limit' };
    }
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
    return { ok: true, bytes: bytes };
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
      && FEISHU_IMAGE_API_PATH_RE.test(url.pathname)) {
      return { ok: true, url: url.href, kind: 'same-origin-api', credentials: 'include' };
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

  return Object.freeze({
    ACTIONS: ACTIONS,
    ACTION_PENDING_OPS: ACTION_PENDING_OPS,
    CDN_HOST_SUFFIXES: CDN_HOST_SUFFIXES,
    DOCUMENT_HOST_SUFFIXES: DOCUMENT_HOST_SUFFIXES,
    DOCUMENT_PATH_SEGMENTS: DOCUMENT_PATH_SEGMENTS,
    DOM_EVENTS: DOM_EVENTS,
    LIMITS: LIMITS,
    MESSAGES: MESSAGES,
    PENDING_OPS: PENDING_OPS,
    getJsonByteLength: getJsonByteLength,
    buildDocumentMatchPatterns: buildDocumentMatchPatterns,
    hostMatchesSuffix: hostMatchesSuffix,
    isAllowedImageMime: isAllowedImageMime,
    isPendingOp: isPendingOp,
    isPendingOpAllowed: isPendingOpAllowed,
    isSupportedDocumentUrl: isSupportedDocumentUrl,
    isUiAction: isUiAction,
    normalizeProgressLabel: normalizeProgressLabel,
    normalizeProgressNumber: normalizeProgressNumber,
    normalizeImageMime: normalizeImageMime,
    validateActionPayload: validateActionPayload,
    validateImageUrl: validateImageUrl,
    validatePendingPayload: validatePendingPayload,
    validateRequestId: validateRequestId,
  });
});
