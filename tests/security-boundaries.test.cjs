const test = require('node:test');
const assert = require('node:assert/strict');

const protocol = require('../extension/shared/protocol.js');
const attribs = require('../lib/feishu-attribs.cjs');
const docxRecord = require('../lib/feishu-docx-record.cjs');
const {
  sanitizeStyleAttribute,
  sanitizeUrlAttribute,
} = require('../lib/feishu-html-sanitizer.cjs');
const {
  discoverRuntimeParts,
  validateRuntimeParts,
  validateManifestVersion,
} = require('../bin/build-feishu-extension.cjs');

const BUNDLE_ID = 'a'.repeat(64);
const DOCUMENT_URL = 'https://example.feishu.cn/docx/Abc123';
const VALID_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function whiteboardMarker(bundleId, slotId) {
  return `[[FEISHU_HELPER_WHITEBOARD:${bundleId}:${slotId}]]`;
}

function makeWhiteboardTransfer() {
  return {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    boardCount: 1,
    slots: [{
      slotId: 'board-0001',
      sourceBlockId: 'block_1',
      marker: whiteboardMarker(BUNDLE_ID, 'board-0001'),
    }],
  };
}

function makePendingV2(patch) {
  return Object.assign({
    schemaVersion: 2,
    pendingId: 'pending_12345678',
    ts: Date.now(),
    text: 'ok',
  }, patch || {});
}

function makeNativeRequest(patch) {
  return Object.assign({
    type: protocol.NATIVE_MESSAGING.REQUEST_TYPE,
    host: protocol.NATIVE_MESSAGING.HOST_NAME,
  }, patch || {});
}

test('extension protocol only accepts document pages and scoped pending operations', () => {
  assert.equal(protocol.isSupportedDocumentUrl('https://example.feishu.cn/wiki/Abc123'), true);
  assert.equal(protocol.isSupportedDocumentUrl('https://example.feishu.cn/docx/Abc123'), true);
  assert.equal(protocol.isSupportedDocumentUrl('https://example.feishu.cn/messenger/'), false);
  assert.equal(protocol.isSupportedDocumentUrl('https://feishu.cn.evil.example/wiki/Abc123'), false);
  assert.equal(protocol.isPendingOpAllowed('extract', 'set'), true);
  assert.equal(protocol.isPendingOpAllowed('extract', 'get'), false);
  assert.equal(protocol.isPendingOpAllowed('paste', 'get'), true);
  assert.equal(protocol.isPendingOpAllowed('paste', 'set'), false);
  assert.equal(protocol.isPendingOpAllowed('prepareNativePaste', 'set'), false);
  assert.equal(protocol.isPendingOpAllowed('paste', 'delete'), false);
  assert.equal(protocol.isPendingOpAllowed('scan', 'delete'), false);
  assert.equal(protocol.validatePendingPayload({ schemaVersion: 1, ts: Date.now(), text: 'ok' }).ok, true);
  assert.equal(protocol.validatePendingPayload({ schemaVersion: 1, ts: Date.now(), unexpected: true }).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2()).ok, true);
  assert.equal(protocol.validatePendingPayload({
    schemaVersion: 1,
    ts: Date.now(),
    pendingId: 'legacy_must_not_gain_v2_fields',
  }).ok, false);
  assert.equal(protocol.validatePendingPayload(JSON.parse(
    '{"schemaVersion":1,"ts":1,"__proto__":{"polluted":true}}'
  )).ok, false);
});

test('clipboard bridge accepts only bounded paste payloads', () => {
  assert.equal(protocol.validateClipboardBridgePayload({
    text: '正文',
    html: '<p>正文</p>',
    docxRecord: '{"recordIds":[]}',
    pasteAfterWrite: true,
  }).ok, true);
  assert.equal(protocol.validateClipboardBridgePayload({
    text: '', html: '', docxRecord: '', pasteAfterWrite: false,
  }).ok, false);
  assert.equal(protocol.validateClipboardBridgePayload({
    text: '正文', pasteAfterWrite: 'yes',
  }).ok, false);
  assert.equal(protocol.validateClipboardBridgePayload({
    text: '正文', pasteAfterWrite: false, unexpected: true,
  }).ok, false);
  assert.equal(protocol.validateClipboardBridgePayload({
    text: 'x'.repeat(protocol.LIMITS.MAX_CLIPBOARD_PAYLOAD_BYTES + 1),
    pasteAfterWrite: false,
  }).ok, false);
});

test('pending whiteboard transfer accepts only bounded official PageDetail data', () => {
  const validTransfer = makeWhiteboardTransfer();
  assert.equal(protocol.validateWhiteboardTransfer(validTransfer).ok, true);
  assert.equal(protocol.validatePendingPayload(makePendingV2({ whiteboardTransfer: validTransfer })).ok, true);

  assert.equal(protocol.validateWhiteboardTransfer(Object.assign({}, validTransfer, {
    bundleId: BUNDLE_ID.toUpperCase(),
  })).ok, false);
  assert.equal(protocol.validateWhiteboardTransfer(Object.assign({}, validTransfer, {
    boardCount: 2,
  })).ok, false);
  assert.equal(protocol.validateWhiteboardTransfer(Object.assign({}, validTransfer, {
    boardCount: 0,
    slots: [],
  })).ok, false);
  assert.equal(protocol.validateWhiteboardTransfer(Object.assign({}, validTransfer, {
    nodes: [],
  })).ok, false);

  const duplicateSlot = makeWhiteboardTransfer();
  duplicateSlot.boardCount = 2;
  duplicateSlot.slots.push(Object.assign({}, duplicateSlot.slots[0]));
  assert.equal(protocol.validateWhiteboardTransfer(duplicateSlot).ok, false);

  const duplicateBlock = makeWhiteboardTransfer();
  duplicateBlock.boardCount = 2;
  duplicateBlock.slots.push({
    slotId: 'board-0002',
    sourceBlockId: 'block_1',
    marker: whiteboardMarker(BUNDLE_ID, 'board-0002'),
  });
  assert.equal(protocol.validateWhiteboardTransfer(duplicateBlock).ok, false);

  const wrongMarker = makeWhiteboardTransfer();
  wrongMarker.slots[0].marker = '[[FEISHU_HELPER_WHITEBOARD:wrong]]';
  assert.equal(protocol.validateWhiteboardTransfer(wrongMarker).ok, false);

  const invalidSlotId = makeWhiteboardTransfer();
  invalidSlotId.slots[0].slotId = 'slot:1';
  invalidSlotId.slots[0].marker = whiteboardMarker(BUNDLE_ID, 'slot:1');
  assert.equal(protocol.validateWhiteboardTransfer(invalidSlotId).ok, false);

  const browserTransfer = makeWhiteboardTransfer();
  browserTransfer.slots[0].nodeCount = 1;
  browserTransfer.browserBoards = [{
    slotId: 'board-0001',
    sourceBlockId: 'block_1',
    sourceWhiteboardToken: 'source_board_token_1',
    pageDetail: {
      nodes: [{ id: 'p1:1', info: {}, children: [] }],
      meta: { appliedVersion: 1 },
      comments: {},
      resources: [],
      ops: [],
    },
    assets: [{ sourceKey: 'source_image_token_1', dataUrl: VALID_IMAGE_DATA_URL }],
  }];
  assert.equal(protocol.validateWhiteboardTransfer(browserTransfer).ok, true);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    whiteboardTransfer: browserTransfer,
  })).ok, true);

  const wrongNodeCount = structuredClone(browserTransfer);
  wrongNodeCount.slots[0].nodeCount = 2;
  assert.equal(protocol.validateWhiteboardTransfer(wrongNodeCount).ok, false);

  const unknownNodeField = structuredClone(browserTransfer);
  unknownNodeField.browserBoards[0].pageDetail.nodes[0].script = 'alert(1)';
  assert.equal(protocol.validateWhiteboardTransfer(unknownNodeField).ok, false);

  const invalidAsset = structuredClone(browserTransfer);
  invalidAsset.browserBoards[0].assets[0].dataUrl = 'data:text/html;base64,PGgxPng8L2gxPg==';
  assert.equal(protocol.validateWhiteboardTransfer(invalidAsset).ok, false);
});

test('pending image entries validate data URLs, MIME, dimensions, and item count', () => {
  const image = { token: 'image_token-1', base64: VALID_IMAGE_DATA_URL, width: 1, height: 1 };
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [image],
  })).ok, true);
  assert.equal(protocol.validatePendingPayload({
    schemaVersion: 1,
    ts: Date.now(),
    orderedImageBase64List: [{ token: 'image_token-1', base64: '', width: 1, height: 1 }],
  }).ok, true);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'image_token-1', base64: '', width: 1, height: 1 }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'bad token', base64: VALID_IMAGE_DATA_URL }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'image_token', base64: 'iVBORw0KGgo=' }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'image_token', base64: 'data:text/html;base64,PGgxPng8L2gxPg==' }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'image_token', base64: 'data:image/png;base64,A===' }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'image_token', base64: VALID_IMAGE_DATA_URL, width: -1 }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'image_token', base64: VALID_IMAGE_DATA_URL, extra: true }],
  })).ok, false);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: new Array(protocol.LIMITS.MAX_PENDING_IMAGE_COUNT + 1).fill(image),
  })).ok, false);
});

test('pending images enforce decoded and aggregate encoded byte limits', () => {
  const tooLargeEncodedLength = Math.ceil((protocol.LIMITS.MAX_IMAGE_BYTES + 1) / 3) * 4;
  const tooLargeDataUrl = 'data:image/png;base64,' + 'A'.repeat(tooLargeEncodedLength);
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: [{ token: 'too_large', base64: tooLargeDataUrl }],
  })).ok, false);

  const eighteenMiBEncoded = 'A'.repeat(24 * 1024 * 1024);
  const eighteenMiBDataUrl = 'data:image/png;base64,' + eighteenMiBEncoded;
  const aggregate = [
    { token: 'large_1', base64: eighteenMiBDataUrl },
    { token: 'large_2', base64: eighteenMiBDataUrl },
    { token: 'over_limit', base64: 'data:image/png;base64,AAAA' },
  ];
  assert.equal(protocol.validatePendingPayload(makePendingV2({
    orderedImageBase64List: aggregate,
  })).ok, false);
});

test('pending freshness rejects expired and excessively future timestamps', () => {
  const now = 2000000000000;
  assert.equal(protocol.isPendingFresh({ ts: now }, now), true);
  assert.equal(protocol.isPendingFresh({ ts: now - protocol.LIMITS.PENDING_TTL_MS + 1 }, now), true);
  assert.equal(protocol.isPendingFresh({ ts: now - protocol.LIMITS.PENDING_TTL_MS }, now), false);
  assert.equal(protocol.isPendingFresh({ ts: now + protocol.LIMITS.PENDING_FUTURE_SKEW_MS }, now), true);
  assert.equal(protocol.isPendingFresh({ ts: now + protocol.LIMITS.PENDING_FUTURE_SKEW_MS + 1 }, now), false);
  assert.equal(protocol.isPendingFresh({ ts: Infinity }, now), false);
  assert.equal(protocol.isPendingFresh({ ts: now }, NaN), false);
});

test('native messaging requests are operation-scoped and fail closed', () => {
  assert.deepEqual(protocol.validateNativeMessagingRequest(makeNativeRequest({
    op: 'inspect',
    action: 'scan',
    sourceUrl: DOCUMENT_URL,
  })), { ok: true, op: 'inspect' });
  assert.deepEqual(protocol.validateNativeMessagingRequest(makeNativeRequest({
    op: 'export',
    action: 'extract',
    sourceUrl: DOCUMENT_URL,
  })), { ok: true, op: 'export' });
  assert.equal(protocol.validateNativeMessagingRequest(makeNativeRequest({
    op: 'preflight',
    action: 'paste',
    bundleId: BUNDLE_ID,
    targetUrl: DOCUMENT_URL,
  })).ok, true);
  assert.equal(protocol.validateNativeMessagingRequest(makeNativeRequest({
    op: 'apply',
    action: 'paste',
    bundleId: BUNDLE_ID,
    targetUrl: DOCUMENT_URL,
  })).ok, true);
  assert.equal(protocol.validateNativeMessagingRequest(makeNativeRequest({
    op: 'discard',
    action: 'extract',
    bundleId: BUNDLE_ID,
  })).ok, true);
  assert.equal(protocol.validateNativeMessagingRequest(makeNativeRequest({
    op: 'discard',
    action: 'paste',
    bundleId: BUNDLE_ID,
  })).ok, false);

  [
    { type: 'WRONG', op: 'export', action: 'extract', sourceUrl: DOCUMENT_URL },
    { host: 'evil.native.host', op: 'export', action: 'extract', sourceUrl: DOCUMENT_URL },
    { op: 'export', action: 'paste', sourceUrl: DOCUMENT_URL },
    { op: 'inspect', action: 'extract', sourceUrl: DOCUMENT_URL },
    { op: 'inspect', action: 'scan', sourceUrl: DOCUMENT_URL, bundleId: BUNDLE_ID },
    { op: 'export', action: 'extract', sourceUrl: 'https://evil.example/docx/Abc123' },
    { op: 'export', action: 'extract', sourceUrl: new URL(DOCUMENT_URL) },
    { op: 'export', action: 'extract', sourceUrl: DOCUMENT_URL, bundleId: BUNDLE_ID },
    { op: 'export', action: 'extract', sourceUrl: DOCUMENT_URL, targetUrl: null },
    { op: 'preflight', action: 'extract', bundleId: BUNDLE_ID, targetUrl: DOCUMENT_URL },
    { op: 'apply', action: 'paste', bundleId: BUNDLE_ID.toUpperCase(), targetUrl: DOCUMENT_URL },
    { op: 'apply', action: 'paste', bundleId: BUNDLE_ID, targetUrl: DOCUMENT_URL, sourceUrl: DOCUMENT_URL },
    { op: 'discard', action: 'scan', bundleId: BUNDLE_ID },
    { op: 'discard', action: 'paste', bundleId: BUNDLE_ID, targetUrl: DOCUMENT_URL },
    { op: 'discard', action: 'paste', bundleId: BUNDLE_ID, sourceUrl: null },
    { op: 'unknown', action: 'paste', bundleId: BUNDLE_ID },
    { op: 'export', action: 'extract', sourceUrl: DOCUMENT_URL, slots: [] },
  ].forEach(function (patch) {
    assert.equal(protocol.validateNativeMessagingRequest(makeNativeRequest(patch)).ok, false);
  });
});

test('privileged image fetch policy is fail-closed', () => {
  const documentUrl = 'https://example.feishu.cn/wiki/Abc123';
  const api = protocol.validateImageUrl(
    'https://example.feishu.cn/space/api/box/stream/download/all/?token=x',
    documentUrl
  );
  assert.deepEqual({ ok: api.ok, credentials: api.credentials }, { ok: true, credentials: 'include' });
  const chart = protocol.validateImageUrl(
    'https://example.feishu.cn/space/api/file/f/cdp-chart-ChartToken_1~noop/?query=width%3D398',
    documentUrl
  );
  assert.deepEqual(
    { ok: chart.ok, credentials: chart.credentials, kind: chart.kind },
    { ok: true, credentials: 'include', kind: 'same-origin-api' }
  );
  assert.equal(protocol.validateImageUrl(
    'https://other.feishu.cn/space/api/file/f/cdp-chart-ChartToken_1~noop/',
    documentUrl
  ).ok, false);
  assert.equal(protocol.validateImageUrl(
    'https://example.feishu.cn/space/api/file/f/not-a-chart/',
    documentUrl
  ).ok, false);

  const cdn = protocol.validateImageUrl('https://img.feishucdn.com/static/image.png', documentUrl);
  assert.deepEqual({ ok: cdn.ok, credentials: cdn.credentials }, { ok: true, credentials: 'omit' });
  const whiteboardMedia = protocol.validateImageUrl(
    'https://internal-api-drive-stream-sg.larkoffice.com/space/api/box/stream/download/preview/Token1?preview_type=16',
    documentUrl
  );
  assert.deepEqual(
    { ok: whiteboardMedia.ok, credentials: whiteboardMedia.credentials, kind: whiteboardMedia.kind },
    { ok: true, credentials: 'include', kind: 'document-media-api' }
  );
  assert.equal(protocol.validateImageUrl(
    'https://internal-api-drive-stream-sg.larkoffice.com.evil.example/space/api/box/stream/download/preview/Token1',
    documentUrl
  ).ok, false);
  assert.equal(protocol.validateImageUrl('https://internal.bytedance.net/secret', documentUrl).ok, false);
  assert.equal(protocol.validateImageUrl('javascript:alert(1)', documentUrl).ok, false);
  assert.equal(protocol.isAllowedImageMime('text/html'), false);
  assert.equal(protocol.detectImageMime(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(protocol.detectImageMime(Uint8Array.from([255, 216, 255, 224])), 'image/jpeg');
  assert.equal(protocol.detectImageMime(Uint8Array.from([60, 115, 118, 103, 62])), '');
  assert.equal(protocol.detectImageMime(Uint8Array.from([60, 104, 116, 109, 108, 62])), '');
});

test('malformed and executable links are rejected without throwing', () => {
  assert.equal(attribs.safeDecodeURIComponent('%'), '%');
  assert.equal(attribs.normalizeLinkHref('javascript%3Aalert(1)'), '');
  assert.equal(attribs.normalizeLinkHref('https%3A%2F%2Fexample.com%2Fa'), 'https://example.com/a');
  assert.doesNotThrow(function () {
    attribs.decodeFeishuAttribs('*0+1', 'x', { 0: ['link', '%'] });
  });
});

test('HTML attribute policies remove active content and preserve safe formatting', () => {
  assert.equal(sanitizeUrlAttribute('javascript:alert(1)', 'link'), '');
  assert.equal(sanitizeUrlAttribute('data:text/html;base64,abc', 'image'), '');
  assert.equal(sanitizeUrlAttribute('https://example.com/image.png', 'image'), 'https://example.com/image.png');
  assert.equal(
    sanitizeStyleAttribute('color:#123;background:url(https://evil);position:fixed;margin:0;'),
    'color:#123;margin:0;'
  );
});

test('docx record and manifest versions are bounded and validated', () => {
  assert.equal(docxRecord.sanitizeDocxRecord('{"recordIds":[],"recordMap":{}}'), '{"recordIds":[],"recordMap":{}}');
  assert.equal(docxRecord.sanitizeDocxRecord('{broken'), '');
  assert.equal(validateManifestVersion('1.1.0'), '1.1.0');
  assert.throws(function () { validateManifestVersion('1.1.0-beta.1'); });
  assert.throws(function () { validateManifestVersion('65536.0.0'); });
});

test('runtime module discovery is ordered and rejects duplicate shared symbols', () => {
  const parts = discoverRuntimeParts();
  assert.ok(parts.length >= 10);
  assert.deepEqual(parts, parts.slice().sort());
  assert.doesNotThrow(function () { validateRuntimeParts(parts); });
  assert.throws(function () { validateRuntimeParts([parts[0], parts[0]]); }, /duplicate runtime symbol/);
});
