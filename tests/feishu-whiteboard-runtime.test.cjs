const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const attribs = require('../lib/feishu-attribs.cjs');
const styleCodec = require('../lib/feishu-style-codec.cjs');
const docxRecord = require('../lib/feishu-docx-record.cjs');
const { createBlockRenderer } = require('../lib/feishu-block-render.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_ID = 'a'.repeat(64);

function loadWhiteboardRuntime() {
  const source = fs.readFileSync(path.join(ROOT, 'src/feishu-runtime/29-whiteboard-transfer.js'), 'utf8');
  const context = {
    Promise,
    clearTimeout,
    console,
    docxRecord,
    setTimeout,
    WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH: 64,
    Date,
    location: { href: 'https://example.feishu.cn/docx/source' },
    document: {
      addEventListener() {},
      dispatchEvent() {},
      removeEventListener() {},
    },
    CustomEvent: function CustomEvent(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__whiteboardTestApi = {'
    + 'assertWhiteboardMarkersInExtractedContent: assertWhiteboardMarkersInExtractedContent,'
    + 'cloneBlockTreeWithWhiteboardMarkers: cloneBlockTreeWithWhiteboardMarkers,'
    + 'inspectWhiteboardSlotMatches: inspectWhiteboardSlotMatches,'
    + 'isValidWhiteboardTransfer: isValidWhiteboardTransfer,'
    + 'requestWhiteboardExport: requestWhiteboardExport,'
    + 'requestDocumentInspect: requestDocumentInspect,'
    + 'buildBrowserDocumentSummary: buildBrowserDocumentSummary,'
    + 'waitForWhiteboardSourceTree: waitForWhiteboardSourceTree'
    + '};', context, { filename: '29-whiteboard-transfer.js' });
  return context;
}

function makeTransfer(count) {
  const slots = [];
  for (let i = 0; i < count; i++) {
    const slotId = 'board-' + String(i + 1).padStart(4, '0');
    slots.push({
      slotId,
      sourceBlockId: 'source_board_' + (i + 1),
      marker: '[[FEISHU_HELPER_WHITEBOARD:' + BUNDLE_ID + ':' + slotId + ']]',
    });
  }
  return { schemaVersion: 1, bundleId: BUNDLE_ID, boardCount: count, slots };
}

function block(id, snapshot, children) {
  return { record: { id, snapshot }, children: children || [] };
}

function blankTextSnapshot() {
  return {
    type: 'text',
    text: {
      initialAttributedTexts: { text: { 0: '' }, attribs: { 0: '+0' } },
      apool: { numToAttrib: {} },
    },
  };
}

function branchWithBoard(boardIndex, targetDepth, snapshotType) {
  let node = block('source_board_' + (boardIndex + 1), {
    type: snapshotType || 'whiteboard',
    token: 'source_board_token_' + (boardIndex + 1),
  });
  for (let depth = targetDepth - 1; depth >= 1; depth--) {
    node = block('wrapper_' + boardIndex + '_' + depth, blankTextSnapshot(), [node]);
  }
  return node;
}

function rootWithBoards(depths) {
  return block('root', { type: 'page' }, depths.map(function (depth, index) {
    // 第一个槽位故意使用陈旧的 text type，验证匹配只依赖官方 sourceBlockId。
    return branchWithBoard(index, depth, index === 0 ? 'text' : 'whiteboard');
  }));
}

function countOccurrences(value, needle) {
  return String(value || '').split(needle).length - 1;
}

test('10 API whiteboard slots are markerized and rendered beyond the legacy 12-level limit', () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  const transfer = makeTransfer(10);
  const tree = rootWithBoards([2, 3, 4, 5, 13, 14, 15, 16, 17, 18]);

  const cloned = api.cloneBlockTreeWithWhiteboardMarkers(tree, transfer);
  assert.equal(cloned.matchedCount, 10);
  assert.equal(cloned.unmatchedSlots.length, 0);
  assert.equal(cloned.duplicateSlots.length, 0);
  assert.equal(cloned.maxMatchedDepth, 18);
  assert.equal(tree.children[0].children[0].record.snapshot.type, 'text');

  const renderer = createBlockRenderer({
    attribs,
    styleCodec,
    docxRecord,
    sanitizer: { finalizeHtmlFragment: function (value) { return String(value || ''); } },
  });
  const legacy = renderer.renderRootBlock(cloned.rootBlock, { maxDepth: 12 });
  assert.equal(countOccurrences(legacy.mdParts.join('\n'), '[[FEISHU_HELPER_WHITEBOARD:'), 4);

  const maxDepth = Math.max(12, cloned.maxMatchedDepth);
  const rendered = renderer.renderRootBlock(cloned.rootBlock, { maxDepth });
  const payload = renderer.buildDocxRecordPayload(cloned.rootBlock, { maxDepth });
  const content = {
    html: rendered.htmlParts.join('\n'),
    text: rendered.mdParts.join('\n'),
    docxRecord: JSON.stringify(payload),
  };
  assert.equal(countOccurrences(content.html, '[[FEISHU_HELPER_WHITEBOARD:'), 10);
  assert.equal(countOccurrences(content.text, '[[FEISHU_HELPER_WHITEBOARD:'), 10);
  assert.equal(countOccurrences(content.docxRecord, '[[FEISHU_HELPER_WHITEBOARD:'), 10);
  assert.equal(api.assertWhiteboardMarkersInExtractedContent(content, transfer), true);
});

test('document inspect rejects native false-zero on a rendered personal document', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  context.requestWhiteboardNative = function () {
    return Promise.resolve({ blockCount: 0, equationCount: 0, imageCount: 0, whiteboardCount: 0 });
  };
  context.getEditorReadyState = function () {
    return {
      readyState: 'complete',
      hasContentRoot: true,
      hasStructService: true,
      hasRootBlock: true,
      hasContentLoaded: true,
    };
  };
  context.isVisibleDocumentBodyEmpty = function () { return false; };
  context.captureValidationSnapshot = function () {
    return {
      blockCount: 195,
      equationCount: 0,
      imageCount: 0,
      whiteboardCount: 4,
      semanticSnapshot: { componentCounts: { image: 34, whiteboard: 10 } },
    };
  };
  context.setTimeout = function (callback) { callback(); return 0; };
  let now = 0;
  context.Date = { now: function () { now += 240; return now; } };

  assert.deepEqual(JSON.parse(JSON.stringify(await api.requestDocumentInspect())), {
    blockCount: 195,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 10,
  });
});

test('document inspect falls back to the rendered structure when native identity lacks access', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  context.requestWhiteboardNative = function () {
    return Promise.reject(new Error(
      'No permission to operate on this document: the current user lacks view or edit access.'
    ));
  };
  context.getEditorReadyState = function () {
    return {
      readyState: 'complete',
      hasContentRoot: true,
      hasStructService: true,
      hasRootBlock: true,
      hasContentLoaded: true,
    };
  };
  context.isVisibleDocumentBodyEmpty = function () { return false; };
  context.captureValidationSnapshot = function () {
    return {
      blockCount: 17,
      equationCount: 0,
      imageCount: 0,
      whiteboardCount: 1,
      semanticSnapshot: { componentCounts: { callout: 12, whiteboard: 1 } },
    };
  };
  context.setTimeout = function (callback) { callback(); return 0; };
  let now = 0;
  context.Date = { now: function () { now += 240; return now; } };

  assert.deepEqual(JSON.parse(JSON.stringify(await api.requestDocumentInspect())), {
    blockCount: 17,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 1,
  });
});

test('document inspect does not hide unrelated native host failures', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  context.requestWhiteboardNative = function () {
    return Promise.reject(new Error('Native Messaging host unavailable'));
  };
  context.getEditorReadyState = function () {
    return {
      readyState: 'complete',
      hasContentRoot: true,
      hasStructService: true,
      hasRootBlock: true,
      hasContentLoaded: true,
    };
  };
  context.isVisibleDocumentBodyEmpty = function () { return false; };

  await assert.rejects(api.requestDocumentInspect(), /Native Messaging host unavailable/);
});

test('document inspect preserves a confirmed empty document', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  context.requestWhiteboardNative = function () {
    return Promise.resolve({ blockCount: 0, equationCount: 0, imageCount: 0, whiteboardCount: 0 });
  };
  context.getEditorReadyState = function () {
    return {
      readyState: 'complete',
      hasContentRoot: true,
      hasStructService: true,
      hasRootBlock: true,
      hasContentLoaded: true,
    };
  };
  context.isVisibleDocumentBodyEmpty = function () { return true; };
  context.captureValidationSnapshot = function () { throw new Error('empty documents need no fallback'); };

  assert.deepEqual(JSON.parse(JSON.stringify(await api.requestDocumentInspect())), {
    blockCount: 0,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 0,
  });
});

test('document inspect never publishes zero metrics when editor readiness times out', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  let nativeCalls = 0;
  context.requestWhiteboardNative = function () {
    nativeCalls += 1;
    return Promise.resolve({ blockCount: 0, equationCount: 0, imageCount: 0, whiteboardCount: 0 });
  };
  context.getEditorReadyState = function () {
    return {
      readyState: 'loading',
      hasContentRoot: false,
      hasStructService: false,
      hasRootBlock: false,
      hasContentLoaded: false,
    };
  };
  context.setTimeout = function (callback) { callback(); return 0; };
  let now = 0;
  context.Date = { now: function () { now += 1000; return now; } };

  await assert.rejects(api.requestDocumentInspect(), /页面正文仍在加载/);
  assert.equal(nativeCalls, 0);
});

test('a partial Struct Service tree fails closed before pending paste can be written', () => {
  const api = loadWhiteboardRuntime().__whiteboardTestApi;
  const transfer = makeTransfer(10);
  const cloned = api.cloneBlockTreeWithWhiteboardMarkers(rootWithBoards([2, 3, 4, 5]), transfer);

  assert.equal(cloned.matchedCount, 4);
  assert.equal(cloned.unmatchedSlots.length, 6);
  assert.equal(cloned.duplicateSlots.length, 0);
});

test('Struct Service readiness uses API slot IDs and waits for the complete tree', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  const transfer = makeTransfer(10);
  let checks = 0;
  context.getStructService = function () {
    checks += 1;
    return {
      rootBlock: checks === 1
        ? rootWithBoards([2, 3, 4, 5])
        : rootWithBoards([2, 3, 4, 5, 13, 14, 15, 16, 17, 18]),
    };
  };
  context.setTimeout = function (callback) { callback(); return 0; };

  const matches = await api.waitForWhiteboardSourceTree(transfer, 1000);
  assert.equal(checks, 2);
  assert.equal(matches.matchedCount, 10);
  assert.equal(matches.maxMatchedDepth, 18);
});

test('rendered marker validation rejects a missing or duplicated slot', () => {
  const api = loadWhiteboardRuntime().__whiteboardTestApi;
  const transfer = makeTransfer(2);
  const complete = transfer.slots.map(function (slot) { return slot.marker; }).join('\n');

  assert.equal(api.assertWhiteboardMarkersInExtractedContent({
    html: complete,
    text: complete,
    docxRecord: complete,
  }, transfer), true);

  assert.throws(function () {
    api.assertWhiteboardMarkersInExtractedContent({
      html: transfer.slots[0].marker,
      text: complete,
      docxRecord: complete,
    }, transfer);
  }, /HTML 中的画板占位符数量不完整/);

  assert.throws(function () {
    api.assertWhiteboardMarkersInExtractedContent({
      html: complete + '\n' + transfer.slots[0].marker,
      text: complete,
      docxRecord: complete,
    }, transfer);
  }, /HTML 中的画板占位符数量不完整/);
});

test('official export accepts an explicit zero-board result and validates non-empty metadata', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  context.captureBrowserWhiteboards = function (transfer) { return Promise.resolve(transfer); };
  context.requestWhiteboardNative = function () {
    return Promise.resolve({
      whiteboardTransfer: null,
      boardCount: 0,
      sourceSummary: { blockCount: 1, equationCount: 0, imageCount: 0, whiteboardCount: 0 },
    });
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await api.requestWhiteboardExport())), {
    whiteboardTransfer: null,
    sourceSummary: { blockCount: 1, equationCount: 0, imageCount: 0, whiteboardCount: 0 },
  });

  const transfer = makeTransfer(2);
  context.requestWhiteboardNative = function () {
    return Promise.resolve({
      whiteboardTransfer: transfer,
      boardCount: 2,
      sourceSummary: { blockCount: 205, equationCount: 0, imageCount: 33, whiteboardCount: 2 },
    });
  };
  const exported = await api.requestWhiteboardExport();
  assert.equal(exported.whiteboardTransfer.boardCount, 2);
  assert.equal(exported.sourceSummary.blockCount, 205);

  context.requestWhiteboardNative = function () {
    return Promise.resolve({
      whiteboardTransfer: transfer,
      boardCount: 2,
      sourceSummary: { blockCount: 205, equationCount: 0, imageCount: 33, whiteboardCount: 1 },
    });
  };
  await assert.rejects(api.requestWhiteboardExport(), /文档统计与画板数量不一致/);

  context.requestWhiteboardNative = function () {
    return Promise.resolve({
      whiteboardTransfer: transfer,
      boardCount: 1,
      sourceSummary: { blockCount: 1, equationCount: 0, imageCount: 0, whiteboardCount: 1 },
    });
  };
  await assert.rejects(api.requestWhiteboardExport(), /未返回有效的画板槽位/);

  context.requestWhiteboardNative = function () {
    return Promise.resolve({ whiteboardTransfer: null, boardCount: 0 });
  };
  await assert.rejects(api.requestWhiteboardExport(), /未返回有效的文档统计/);
});

test('document extraction falls back to browser whiteboards when native identity lacks access', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  const transfer = makeTransfer(1);
  context.requestWhiteboardNative = function () {
    return Promise.reject(new Error(
      'No permission to operate on this document: the current user lacks view or edit access.'
    ));
  };
  context.getEditorReadyState = function () {
    return {
      readyState: 'complete',
      hasContentRoot: true,
      hasStructService: true,
      hasRootBlock: true,
      hasContentLoaded: true,
    };
  };
  context.isVisibleDocumentBodyEmpty = function () { return false; };
  context.captureValidationSnapshot = function () {
    return {
      blockCount: 17,
      equationCount: 0,
      imageCount: 0,
      whiteboardCount: 1,
      semanticSnapshot: { componentCounts: { callout: 12, whiteboard: 1 } },
    };
  };
  context.buildBrowserWhiteboardTransfer = function () { return transfer; };
  context.captureBrowserWhiteboards = function (value) {
    return Promise.resolve(Object.assign({}, value, { browserBoards: ['captured'] }));
  };
  context.setTimeout = function (callback) { callback(); return 0; };
  let now = 0;
  context.Date = { now: function () { now += 240; return now; } };

  const result = JSON.parse(JSON.stringify(await api.requestWhiteboardExport()));
  assert.equal(result.whiteboardTransfer.browserBoards[0], 'captured');
  assert.deepEqual(result.sourceSummary, {
    blockCount: 17,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 1,
  });
});

test('document extraction does not hide unrelated native export failures', async () => {
  const context = loadWhiteboardRuntime();
  const api = context.__whiteboardTestApi;
  context.requestWhiteboardNative = function () {
    return Promise.reject(new Error('Native export protocol mismatch'));
  };

  await assert.rejects(api.requestWhiteboardExport(), /Native export protocol mismatch/);
});

test('document extraction always asks the official API even when browser structure reports no boards', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/feishu-runtime/36-document-workflows.js'), 'utf8');
  let exportCalls = 0;
  let pending = null;
  const context = {
    Promise,
    console,
    setTimeout: function (callback) { callback(); return 0; },
    getDocToken: function () { return 'doc_token'; },
    showToast: function () {},
    emitUiProgress: function () {},
    getStructService: function () { throw new Error('browser count must not gate official export'); },
    requestWhiteboardExport: function () {
      exportCalls += 1;
      return Promise.resolve({
        whiteboardTransfer: null,
        sourceSummary: { blockCount: 205, equationCount: 3, imageCount: 0, whiteboardCount: 0 },
      });
    },
    waitForWhiteboardSourceTree: function () { throw new Error('zero-board result must not wait for slots'); },
    captureEmbeddedChartFallbacks: function () {
      return Promise.resolve({ count: 0, byRecordId: {} });
    },
    extractFullDoc: function () {
      return { html: '<p>body</p>', text: 'body', blockCount: 1, equationCount: 0, docxRecord: '' };
    },
    getDocumentTitle: function () { return 'source'; },
    extractPageIconEmojiFromDom: function () { return ''; },
    buildClipboardPayload: function () {
      return Promise.resolve({ html: '<p>body</p>', docxRecord: '', orderedImageBase64List: [] });
    },
    captureValidationSnapshot: function () { return { semanticSnapshot: null }; },
    setPendingPaste: function (value) { pending = value; return Promise.resolve(); },
    countExtractedImages: function () { return 0; },
    setDocJsonAttr: function () {},
    requestWhiteboardDiscard: function () { return Promise.resolve(); },
    stringifyError: function (error) { return String(error && error.message || error); },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__workflowTestApi = {'
    + 'duplicateDocumentForAutomation: duplicateDocumentForAutomation'
    + '};', context, { filename: '36-document-workflows.js' });

  const result = await context.__workflowTestApi.duplicateDocumentForAutomation();
  assert.equal(exportCalls, 1);
  assert.equal(result.blockCount, 205);
  assert.equal(result.equationCount, 3);
  assert.equal(result.whiteboardCount, 0);
  assert.equal(pending.text, 'body');
});
