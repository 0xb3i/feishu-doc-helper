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

test('extension protocol only accepts document pages and scoped pending operations', () => {
  assert.equal(protocol.isSupportedDocumentUrl('https://example.feishu.cn/wiki/Abc123'), true);
  assert.equal(protocol.isSupportedDocumentUrl('https://example.feishu.cn/docx/Abc123'), true);
  assert.equal(protocol.isSupportedDocumentUrl('https://example.feishu.cn/messenger/'), false);
  assert.equal(protocol.isSupportedDocumentUrl('https://feishu.cn.evil.example/wiki/Abc123'), false);
  assert.equal(protocol.isPendingOpAllowed('extract', 'set'), true);
  assert.equal(protocol.isPendingOpAllowed('extract', 'get'), false);
  assert.equal(protocol.isPendingOpAllowed('scan', 'delete'), false);
  assert.equal(protocol.validatePendingPayload({ schemaVersion: 1, ts: Date.now(), text: 'ok' }).ok, true);
  assert.equal(protocol.validatePendingPayload({ schemaVersion: 1, ts: Date.now(), unexpected: true }).ok, false);
});

test('privileged image fetch policy is fail-closed', () => {
  const documentUrl = 'https://example.feishu.cn/wiki/Abc123';
  const api = protocol.validateImageUrl(
    'https://example.feishu.cn/space/api/box/stream/download/all/?token=x',
    documentUrl
  );
  assert.deepEqual({ ok: api.ok, credentials: api.credentials }, { ok: true, credentials: 'include' });

  const cdn = protocol.validateImageUrl('https://img.feishucdn.com/static/image.png', documentUrl);
  assert.deepEqual({ ok: cdn.ok, credentials: cdn.credentials }, { ok: true, credentials: 'omit' });
  assert.equal(protocol.validateImageUrl('https://internal.bytedance.net/secret', documentUrl).ok, false);
  assert.equal(protocol.validateImageUrl('javascript:alert(1)', documentUrl).ok, false);
  assert.equal(protocol.isAllowedImageMime('text/html'), false);
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
