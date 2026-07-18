const test = require('node:test');
const assert = require('node:assert/strict');

const attribs = require('../lib/feishu-attribs.cjs');
const styleCodec = require('../lib/feishu-style-codec.cjs');
const docxRecord = require('../lib/feishu-docx-record.cjs');
const { createHtmlSanitizer } = require('../lib/feishu-html-sanitizer.cjs');
const { createBlockRenderer } = require('../lib/feishu-block-render.cjs');

const sanitizer = createHtmlSanitizer({
  normalizeLatexHtmlTextNodes: attribs.normalizeLatexHtmlTextNodes,
  normalizeLatexForHtml: attribs.normalizeLatexForHtml,
  containsLatexText: attribs.containsLatexText,
  escapeAttr: attribs.escapeAttr,
});

const renderer = createBlockRenderer({ attribs, styleCodec, sanitizer, docxRecord });

function textSnapshot(text) {
  const value = String(text || '');
  return {
    type: 'text',
    text: {
      initialAttributedTexts: {
        text: { 0: value },
        attribs: { 0: '+' + value.length.toString(36) },
      },
      apool: { numToAttrib: {} },
    },
  };
}

function pageWith(children) {
  return {
    record: { id: 'root', snapshot: { type: 'page' } },
    children,
  };
}

function block(id, snapshot, children) {
  return {
    record: { id, snapshot },
    children: children || [],
  };
}

test('empty Feishu body placeholder blocks are not counted as document content', () => {
  const root = pageWith([
    block('blank_text', { type: 'text' }),
  ]);

  const rendered = renderer.renderRootBlock(root, {});
  assert.equal(rendered.blockCount, 0);
  assert.deepEqual(rendered.mdParts.filter(Boolean), []);

  const payload = renderer.buildDocxRecordPayload(root, {});
  assert.equal(payload, null);
});

test('visible text blocks are counted and included in docx records', () => {
  const root = pageWith([
    block('body_text', textSnapshot('hello')),
  ]);

  const rendered = renderer.renderRootBlock(root, {});
  assert.equal(rendered.blockCount, 1);
  assert.deepEqual(rendered.mdParts, ['hello']);

  const payload = renderer.buildDocxRecordPayload(root, {});
  assert.deepEqual(payload.recordIds, ['body_text']);
});

test('unsupported whiteboard blocks are silently skipped from rendered content and docx records', () => {
  const root = pageWith([
    block('intro', textSnapshot('hello')),
    block('board', { type: 'whiteboard', token: 'whiteboard_token', width: 800, height: 600 }),
  ]);

  const rendered = renderer.renderRootBlock(root, {});
  assert.equal(rendered.blockCount, 1);
  assert.deepEqual(rendered.mdParts, ['hello']);
  assert.equal(rendered.blockTypeCounts.whiteboard, 1);
  assert.doesNotMatch(rendered.htmlParts.join('\n'), /白板|whiteboard_token/);

  const payload = renderer.buildDocxRecordPayload(root, {});
  assert.deepEqual(payload.recordIds, ['intro']);
  assert.equal(payload.recordMap.board, undefined);
  assert.equal(Object.values(payload.recordMap).some(function (record) {
    return record && record.snapshot && record.snapshot.type === 'whiteboard';
  }), false);
});
