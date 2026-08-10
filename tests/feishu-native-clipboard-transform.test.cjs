'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NativeClipboardTransformError,
  transformNativeClipboardForWhiteboards,
} = require('../lib/feishu-native-clipboard-transform.cjs');

const BUNDLE_ID = 'a'.repeat(64);

function textSnapshot(text, parentId) {
  return {
    type: 'text',
    parent_id: parentId,
    text: {
      initialAttributedTexts: { text: { 0: text }, attribs: { 0: '+' + text.length.toString(36) } },
      apool: { numToAttrib: {} },
    },
  };
}

function transfer(slotCount) {
  const slots = Array.from({ length: slotCount }, (_, index) => {
    const number = String(index + 1).padStart(4, '0');
    return {
      slotId: 'board-' + number,
      sourceBlockId: 'board-record-' + number,
      marker: '[[FEISHU_HELPER_WHITEBOARD:' + BUNDLE_ID + ':board-' + number + ']]',
    };
  });
  return {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    boardCount: slots.length,
    slots,
    browserBoards: slots.map((slot, index) => ({
      slotId: slot.slotId,
      sourceBlockId: slot.sourceBlockId,
      sourceWhiteboardToken: 'source-board-token-' + (index + 1),
    })),
  };
}

function nativeRecord() {
  return {
    isCut: false,
    rootId: 'source-page',
    parentId: 'source-page',
    recordIds: ['intro', 'blank', 'container', 'image', 'board-record-0002'],
    blockIds: [2, 3, 4, 5, 6],
    selection: [
      { id: 2, type: 'block', recordId: 'intro' },
      { id: 3, type: 'block', recordId: 'blank' },
      { id: 4, type: 'block', recordId: 'container' },
      { id: 5, type: 'block', recordId: 'image' },
      { id: 6, type: 'block', recordId: 'board-record-0002' },
    ],
    recordMap: {
      'source-page': { id: 'source-page', snapshot: { type: 'page', children: ['intro', 'blank', 'container', 'image', 'board-record-0002'] } },
      intro: { id: 'intro', snapshot: textSnapshot('Document title', 'source-page') },
      blank: { id: 'blank', snapshot: textSnapshot('', 'source-page') },
      container: { id: 'container', snapshot: { type: 'callout', parent_id: 'source-page', children: ['board-record-0001', 'nested-text'] } },
      'board-record-0001': {
        id: 'board-record-0001',
        snapshot: {
          type: 'whiteboard', token: 'source-board-token-1', parent_id: 'container',
          comments: [{ id: 'comment' }], children: [], width: 800, height: 600,
        },
      },
      'nested-text': { id: 'nested-text', snapshot: textSnapshot('after nested board', 'container') },
      image: {
        id: 'image',
        snapshot: {
          type: 'image', parent_id: 'source-page',
          image: { token: 'source-image-token', width: 320, height: 200 },
        },
      },
      'board-record-0002': {
        id: 'board-record-0002',
        snapshot: { type: 'whiteboard', token: 'source-board-token-2', parent_id: 'source-page', locked: true },
      },
    },
    payloadMap: {
      'board-record-0001': { level: 2 },
      'nested-text': { level: 2 },
      'page-title': 'Document title',
    },
    extra: { channel: 'saas', pasteRandomId: 'native-random-id' },
  };
}

function nativeHtml(record) {
  const embedded = JSON.stringify(record).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return '<meta charset="utf-8"><div data-lark-html-role="root" data-docx-has-block-data="true"'
    + ' data-lark-record-format="docx/record" data-lark-record-data="' + embedded + '">'
    + '<p data-record-id="intro">Document title</p>'
    + '<p data-record-id="blank"></p>'
    + '<div data-record-id="container"><aside data-block-id="board-record-0001">board one</aside>'
    + '<p data-record-id="nested-text">after nested board</p></div>'
    + '<figure data-record-id="image"><img src="source-image"></figure>'
    + '<section data-block-id="board-record-0002"><canvas></canvas></section>'
    + '</div>';
}

test('native clipboard transformation preserves structure, empty blocks and images while markerizing boards', () => {
  const sourceRecord = nativeRecord();
  const sourceTransfer = transfer(2);
  const markerizedText = [
    'Document title',
    '',
    sourceTransfer.slots[0].marker,
    'after nested board',
    '[image]',
    sourceTransfer.slots[1].marker,
  ].join('\n');

  const result = transformNativeClipboardForWhiteboards({
    text: 'native text is intentionally not authoritative',
    html: nativeHtml(sourceRecord),
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, markerizedText);
  const transformed = JSON.parse(result.payload.docxRecord);

  assert.deepEqual(transformed.recordIds, sourceRecord.recordIds);
  assert.deepEqual(transformed.blockIds, sourceRecord.blockIds);
  assert.deepEqual(transformed.selection, sourceRecord.selection);
  assert.deepEqual(transformed.payloadMap, sourceRecord.payloadMap);
  assert.deepEqual(transformed.recordMap['source-page'], sourceRecord.recordMap['source-page']);
  assert.deepEqual(transformed.recordMap.blank, sourceRecord.recordMap.blank);
  assert.deepEqual(transformed.recordMap.image, sourceRecord.recordMap.image);
  assert.equal(transformed.recordMap.image.snapshot.image.token, 'source-image-token');

  const firstBoard = transformed.recordMap['board-record-0001'];
  assert.equal(firstBoard.id, 'board-record-0001');
  assert.equal(firstBoard.snapshot.type, 'text');
  assert.equal(firstBoard.snapshot.parent_id, 'container');
  assert.deepEqual(firstBoard.snapshot.children, []);
  assert.deepEqual(firstBoard.snapshot.comments, [{ id: 'comment' }]);
  assert.equal(firstBoard.snapshot.token, undefined);
  assert.equal(firstBoard.snapshot.width, undefined);
  assert.equal(firstBoard.snapshot.text.initialAttributedTexts.text[0], sourceTransfer.slots[0].marker);

  assert.equal(result.payload.text, markerizedText);
  assert.doesNotMatch(result.payload.html, /data-lark-record-format|data-lark-record-data/);
  assert.doesNotMatch(result.payload.html, /board one|<canvas/);
  assert.match(result.payload.html, /data-feishu-helper-whiteboard-slot="board-0001"/);
  assert.match(result.payload.html, /data-feishu-helper-whiteboard-slot="board-0002"/);
  assert.equal(result.report.slotCount, 2);
  assert.equal(result.report.imageRecordCount, 1);
  assert.equal(result.report.embeddedHtmlRecordsRemoved, 1);
  assert.equal(result.report.externalDocxRecordAuthoritative, true);
});

test('nested duplicate HTML identifiers are treated as one board, while disjoint duplicates are rejected', () => {
  const sourceRecord = nativeRecord();
  const sourceTransfer = transfer(2);
  const nestedHtml = nativeHtml(sourceRecord).replace(
    '<aside data-block-id="board-record-0001">board one</aside>',
    '<aside data-block-id="board-record-0001"><span data-record-id="board-record-0001">board one</span></aside>'
  );
  assert.doesNotThrow(() => transformNativeClipboardForWhiteboards({
    html: nestedHtml,
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')));

  const duplicatedHtml = nativeHtml(sourceRecord).replace(
    '</div>',
    '<aside data-record-id="board-record-0001">duplicate</aside></div>'
  );
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html: duplicatedHtml,
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error instanceof NativeClipboardTransformError, true);
    assert.equal(error.code, 'HTML_SLOT_DUPLICATE');
    return true;
  });
});

test('missing or duplicate docx slots return explicit fallback errors', () => {
  const sourceRecord = nativeRecord();
  const sourceTransfer = transfer(2);
  delete sourceRecord.recordMap['board-record-0002'];
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html: nativeHtml(sourceRecord),
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error.code, 'DOCX_SLOT_MISSING');
    assert.match(error.message, /board-record-0002/);
    return true;
  });

  const duplicateTransfer = transfer(2);
  duplicateTransfer.slots[1].sourceBlockId = duplicateTransfer.slots[0].sourceBlockId;
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html: nativeHtml(nativeRecord()),
    docxRecord: JSON.stringify(nativeRecord()),
  }, duplicateTransfer, duplicateTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error.code, 'DUPLICATE_SLOT');
    return true;
  });
});

test('sourceBlockId may match the record wrapper identity, but aliases must remain unique', () => {
  const sourceRecord = nativeRecord();
  const sourceTransfer = transfer(2);
  sourceRecord.recordMap.boardAlias = sourceRecord.recordMap['board-record-0001'];
  delete sourceRecord.recordMap['board-record-0001'];
  const html = nativeHtml(sourceRecord);
  const result = transformNativeClipboardForWhiteboards({
    html,
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n'));
  assert.deepEqual(result.report.replacedRecordIds, ['boardAlias', 'board-record-0002']);

  sourceRecord.recordMap.duplicateAlias = {
    id: 'board-record-0001',
    snapshot: { type: 'whiteboard', token: 'duplicate-token' },
  };
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html,
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error.code, 'DOCX_SLOT_DUPLICATE');
    return true;
  });
});

test('unmapped native whiteboards and incomplete markerized text are rejected', () => {
  const sourceRecord = nativeRecord();
  sourceRecord.recordMap.unmapped = {
    id: 'unmapped',
    snapshot: { type: 'whiteboard', token: 'unmapped-token', parent_id: 'source-page' },
  };
  const sourceTransfer = transfer(2);
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html: nativeHtml(sourceRecord),
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error.code, 'WHITEBOARD_RECORD_REMAINS');
    return true;
  });

  assert.throws(() => transformNativeClipboardForWhiteboards({
    html: nativeHtml(nativeRecord()),
    docxRecord: JSON.stringify(nativeRecord()),
  }, sourceTransfer, sourceTransfer.slots[0].marker), (error) => {
    assert.equal(error.code, 'MARKER_COUNT_MISMATCH');
    assert.equal(error.details.field, 'text');
    return true;
  });
});

test('source whiteboard tokens cannot survive in copied metadata', () => {
  const sourceRecord = nativeRecord();
  sourceRecord.extra.sourceWhiteboardToken = 'source-board-token-1';
  const sourceTransfer = transfer(2);
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html: nativeHtml(sourceRecord),
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error.code, 'SOURCE_WHITEBOARD_TOKEN_REMAINS');
    return true;
  });
});

test('source whiteboard tokens cannot survive outside the replaced HTML block', () => {
  const sourceRecord = nativeRecord();
  const sourceTransfer = transfer(2);
  const html = nativeHtml(sourceRecord).replace(
    '</div>',
    '<span data-debug-token="source-board-token-1"></span></div>'
  );
  assert.throws(() => transformNativeClipboardForWhiteboards({
    html,
    docxRecord: JSON.stringify(sourceRecord),
  }, sourceTransfer, sourceTransfer.slots.map((slot) => slot.marker).join('\n')), (error) => {
    assert.equal(error.code, 'SOURCE_WHITEBOARD_TOKEN_REMAINS');
    return true;
  });
});

test('markerized HTML fallback supports native payloads without board DOM identities', () => {
  const sourceTransfer = transfer(2);
  const markerizedText = sourceTransfer.slots.map((slot) => slot.marker).join('\n');
  const markerHtml = '<div data-docx-has-block-data="true">'
    + sourceTransfer.slots.map((slot) => '<p>' + slot.marker + '</p>').join('') + '</div>';
  const result = transformNativeClipboardForWhiteboards(
    { html: '<p>native text without stable board ids</p>', docxRecord: JSON.stringify(nativeRecord()) },
    sourceTransfer,
    markerizedText,
    markerHtml
  );
  assert.equal(result.report.htmlMode, 'markerizedFallback');
  assert.equal(result.payload.html, markerHtml);
});
