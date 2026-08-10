'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const transfer = require('../lib/feishu-whiteboard-transfer.cjs');
const { BundleStore } = require('../native-host/bundle-store.cjs');
const {
  TransferService,
  buildCanonicalDocumentUrl,
  buildDryRunNodes,
  collectOwnershipCleanupBlockIds,
  extractNewWhiteboardFromUpdate,
  reconcileCompletedRollback,
  waitForWhiteboardImport,
  whiteboardNodesMatch,
} = require('../native-host/transfer-service.cjs');
const {
  computeExtensionId,
  discoverLarkCli,
  discoverStableNodePath,
  installNativeManifests,
  parseArgs,
  parseMap,
  validateConfiguredProfiles,
} = require('../native-host/install.cjs');
const { LarkClient } = require('../native-host/lark-client.cjs');
const { resolveProfile, validateRequest } = require('../native-host/host.cjs');
const identity = require('../extension/extension-identity.json');

const BUNDLE_ID = 'a'.repeat(64);

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-whiteboard-test-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function makeTransfer() {
  return transfer.createTransferMetadata(BUNDLE_ID, [{ blockId: 'source_board_1' }]);
}

function saveSimpleBundle(store) {
  const metadata = makeTransfer();
  store.create(BUNDLE_ID);
  store.saveBundle({
    schemaVersion: 1,
    id: BUNDLE_ID,
    createdAt: Date.now(),
    expiresAt: Date.now() + transfer.BUNDLE_TTL_MS,
    source: { url: 'https://source.feishu.cn/docx/Source1', documentId: 'Source1', revisionId: 1 },
    transfer: metadata,
    boards: [{
      slotId: metadata.slots[0].slotId,
      sourceBlockId: metadata.slots[0].sourceBlockId,
      nodeCount: 1,
      nodes: [{ id: 'node-1', type: 'shape', x: 1, y: 2 }],
      bindings: [],
    }],
    assets: [],
  });
  return metadata;
}

function createTargetClient(metadata, failUpdate) {
  const marker = metadata.slots[0].marker;
  let ownershipMarker = '';
  let hasMarker = true;
  let hasOwnershipMarker = false;
  let hasBoard = false;
  let whiteboardNodes = [];
  const calls = [];
  function renderContent() {
    return (hasMarker ? '<p id="target_marker_1">' + marker + '</p>' : '')
      + (hasOwnershipMarker
        ? '<p id="target_ownership_marker_1">' + ownershipMarker + '</p>'
        : '')
      + (hasBoard
        ? '<whiteboard id="target_board_block_1" token="target_board_token_1"></whiteboard>'
        : '');
  }
  return {
    calls: calls,
    get content() { return renderContent(); },
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 1, content: renderContent() };
    },
    async canEditDocument() { return true; },
    async updateDocument(options) {
      calls.push({ kind: 'document', options: Object.assign({}, options) });
      if (options.command === 'block_insert_after') {
        const match = String(options.content || '').match(
          /\[\[FEISHU_HELPER_WHITEBOARD_OWNERSHIP:[a-f0-9]{64}:board-[0-9]{4}:[a-f0-9]{32}\]\]/
        );
        assert.ok(match, 'create payload must include ownership marker');
        ownershipMarker = match[0];
        hasOwnershipMarker = true;
        hasBoard = true;
        return {
          ok: true,
          data: {
            document: {
              new_blocks: [{
                block_id: 'target_board_block_1',
                block_type: 'whiteboard',
                block_token: 'target_board_token_1',
              }],
            },
          },
        };
      }
      if (options.command === 'block_delete') {
        const ids = String(options.blockId || '').split(',');
        if (ids.includes('target_board_block_1')) hasBoard = false;
        if (ids.includes('target_ownership_marker_1')) hasOwnershipMarker = false;
        if (ids.includes('target_marker_1')) hasMarker = false;
        return { ok: true, data: { document: {} } };
      }
      throw new Error('unexpected document operation');
    },
    async updateWhiteboard(options) {
      calls.push({ kind: 'whiteboard', options: Object.assign({}, options) });
      if (failUpdate) throw new Error('simulated update failure');
      whiteboardNodes = JSON.parse(JSON.stringify(options.nodes || []));
      return { ok: true, data: {} };
    },
    async exportWhiteboard() {
      return JSON.parse(JSON.stringify(whiteboardNodes));
    },
    async uploadWhiteboardMedia() {
      throw new Error('no assets expected');
    },
  };
}

test('document XML parser preserves board order and locates exact marker blocks', () => {
  const metadata = makeTransfer();
  const xml = '<title>示例</title>'
    + '<whiteboard id="source_board_1" token="source_board_token_1"></whiteboard>'
    + '<p id="target_marker_1"><span>' + metadata.slots[0].marker + '</span></p>'
    + '<whiteboard id="target_board_1" token="target_board_token_1"></whiteboard>';
  assert.deepEqual(transfer.listDocumentWhiteboards(xml), [
    { blockId: 'source_board_1', token: 'source_board_token_1' },
    { blockId: 'target_board_1', token: 'target_board_token_1' },
  ]);
  assert.deepEqual(transfer.findTransferMarkers(xml, metadata), [{
    slotId: 'board-0001',
    marker: metadata.slots[0].marker,
    markerBlockId: 'target_marker_1',
    followingBoard: { blockId: 'target_board_1', token: 'target_board_token_1' },
  }]);

  const nested = '<callout id="container_1"><p id="deep_marker_1"><span>'
    + metadata.slots[0].marker + '</span></p></callout>';
  assert.deepEqual(transfer.findTransferMarkers(nested, metadata), [{
    slotId: 'board-0001',
    marker: metadata.slots[0].marker,
    markerBlockId: 'deep_marker_1',
    followingBoard: null,
  }]);

  const ownershipMarker = transfer.buildOwnershipMarker(
    BUNDLE_ID,
    'board-0001',
    'e'.repeat(32)
  );
  const owned = '<p id="target_marker_1">' + metadata.slots[0].marker + '</p>'
    + '<p id="ownership_marker_1">' + ownershipMarker + '</p>'
    + '<whiteboard id="owned_board_1" token="owned_board_token_1"></whiteboard>';
  assert.deepEqual(transfer.findOwnedWhiteboard(
    owned,
    metadata.slots[0].marker,
    ownershipMarker
  ), {
    ownershipMarkerBlockId: 'ownership_marker_1',
    boardBlockId: 'owned_board_1',
    boardToken: 'owned_board_token_1',
  });
  assert.throws(function () {
    transfer.findOwnershipRecord(
      owned + '<p id="ownership_marker_2">' + ownershipMarker + '</p>',
      ownershipMarker
    );
  }, /重复/);
  assert.throws(function () {
    collectOwnershipCleanupBlockIds({
      boards: {
        'board-0001': {
          slotId: 'board-0001',
          ownershipMarker: ownershipMarker,
          ownershipMarkerBlockId: 'ownership_marker_1',
          boardBlockId: 'owned_board_1',
          boardToken: 'owned_board_token_1',
        },
      },
    }, '<p id="target_marker_1">' + metadata.slots[0].marker + '</p>'
      + '<section><p id="ownership_marker_1">' + ownershipMarker + '</p>'
      + '<whiteboard id="owned_board_1" token="owned_board_token_1"></whiteboard></section>',
    true,
    metadata);
  }, /所有权结构已被修改/);
});

test('official document summary counts stable block IDs and structured media', () => {
  const xml = '<title id="title_block">标题</title>'
    + '<p id="paragraph_1">正文</p>'
    + '<table id="table_1"><tbody><tr><td><p id="cell_text_1">单元格</p></td></tr></tbody></table>'
    + '<img id="image_1" token="image_token_1"/>'
    + '<equation id="equation_1">x</equation>'
    + '<whiteboard id="board_1" token="board_token_1"></whiteboard>';
  assert.deepEqual(transfer.summarizeDocumentStructure(xml), {
    blockCount: 4,
    equationCount: 1,
    imageCount: 1,
    whiteboardCount: 1,
  });
});

test('image bindings replace only OpenAPI image nodes and keep source nodes immutable', () => {
  const nodes = [
    { id: 'image-1', type: 'image', image: { token: 'source_image_token' } },
    { id: 'shape-1', type: 'shape', image: { token: 'not_an_image_node' } },
  ];
  const bindings = transfer.collectImageTokenBindings(nodes);
  assert.deepEqual(bindings, [{ nodeIndex: 0, path: ['image', 'token'], sourceToken: 'source_image_token' }]);
  const assetId = 'b'.repeat(64);
  const replaced = transfer.replaceSourceTokensWithAssets(nodes, bindings, {
    source_image_token: assetId,
  });
  assert.equal(nodes[0].image.token, 'source_image_token');
  assert.equal(replaced.nodes[0].image.token, 'feishu-helper-asset:' + assetId);
  assert.equal(replaced.nodes[1].image.token, 'not_an_image_node');
  const target = transfer.applyTargetAssetTokens(replaced.nodes, replaced.bindings, {
    [assetId]: 'target_image_token',
  });
  assert.equal(target[0].image.token, 'target_image_token');
  assert.equal(replaced.nodes[0].image.token, 'feishu-helper-asset:' + assetId);
});

test('raw transfer strips tenant identity and rejects SVG external resources', () => {
  const nodes = [
    {
      id: 'sticky-1',
      type: 'sticky_note',
      sticky_note: { text: '保留正文', user_id: 'ou_source_tenant_user' },
    },
    {
      id: 'svg-1',
      type: 'svg',
      svg: {
        key: 'local-shape-key',
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
          + '<defs><path id="shape" d="M0 0h10v10z"/></defs><use href="#shape"/></svg>',
      },
    },
  ];
  const sanitized = transfer.sanitizeRawNodesForTransfer(nodes);
  assert.equal(sanitized[0].sticky_note.user_id, undefined);
  assert.equal(sanitized[0].sticky_note.text, '保留正文');
  assert.equal(sanitized[1].svg.key, 'local-shape-key');
  assert.equal(nodes[0].sticky_note.user_id, 'ou_source_tenant_user');

  assert.throws(function () {
    transfer.sanitizeRawNodesForTransfer([{
      type: 'svg',
      svg: {
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/a.png"/></svg>',
      },
    }]);
  }, /SVG.*外部/);
  assert.throws(function () {
    transfer.sanitizeRawNodesForTransfer([{
      type: 'svg',
      svg: {
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/a.svg#x"/></svg>',
      },
    }]);
  }, /SVG.*外部/);
  assert.throws(function () {
    transfer.sanitizeRawNodesForTransfer([{
      type: 'svg',
      svg: {
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg">'
          + '<rect style="fill:&#x75;rl(h&#116;tp:&#47;&#47;evil.example/a.svg)"/></svg>',
      },
    }]);
  }, /SVG.*外部/);
});

test('source export deduplicates image downloads and persists no source board/image token', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  let downloadCount = 0;
  const client = {
    async fetchDocument() {
      return {
        document_id: 'SourceDoc1',
        revision_id: 7,
        content: '<whiteboard id="source_board_1" token="source_board_token_1"></whiteboard>'
          + '<whiteboard id="source_board_2" token="source_board_token_2"></whiteboard>',
      };
    },
    async exportWhiteboard() {
      return [
        { id: 'image-node-1', type: 'image', image: { token: 'source_shared_image_token' } },
        {
          id: 'sticky-node-1',
          type: 'sticky_note',
          sticky_note: { text: '保留', user_id: 'ou_source_tenant_user' },
        },
      ];
    },
    async downloadMedia(_token, outputPath, cwd) {
      downloadCount += 1;
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
      fs.writeFileSync(path.join(cwd, outputPath + '.png'), png);
      return { ok: true };
    },
  };
  const service = new TransferService({ client: client, store: store });
  const result = await service.exportSource('https://source.feishu.cn/docx/SourceDoc1');
  assert.equal(result.boardCount, 2);
  assert.deepEqual(result.sourceSummary, {
    blockCount: 0,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 2,
  });
  assert.equal(downloadCount, 1);
  const bundle = store.loadBundle(result.whiteboardTransfer.bundleId);
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /source_board_token_[12]|source_shared_image_token|ou_source_tenant_user/);
  assert.equal(bundle.assets.length, 1);
  assert.equal(bundle.boards[0].bindings[0].assetId, bundle.boards[1].bindings[0].assetId);
});

test('source inspection counts official document whiteboards without creating a bundle', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const client = {
    async fetchDocument() {
      return {
        document_id: 'SourceDoc1',
        revision_id: 7,
        content: '<whiteboard id="source_board_1" token="source_token_1"></whiteboard>'
          + '<p>正文</p>'
          + '<whiteboard id="source_board_2" token="source_token_2"></whiteboard>',
      };
    },
  };
  const service = new TransferService({ client: client, store: store });
  assert.deepEqual(await service.inspectSource('https://source.feishu.cn/docx/SourceDoc1'), {
    blockCount: 1,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 2,
  });
  assert.deepEqual(fs.readdirSync(store.bundleRoot), []);
});

test('target visibility polling tolerates remapped IDs and eventual consistency', async () => {
  const expected = [
    { id: 'source-shape', type: 'shape', x: 1 },
    { id: 'source-connector', type: 'connector', x: 2 },
  ];
  const sequence = [
    [],
    [{ id: 'target-shape', type: 'shape', x: 1 }],
    [
      { id: 'target-shape', type: 'shape', x: 1 },
      { id: 'target-connector', type: 'connector', x: 2 },
    ],
  ];
  let calls = 0;
  let clock = 0;
  const client = {
    async exportWhiteboard() {
      const value = sequence[Math.min(calls, sequence.length - 1)];
      calls += 1;
      return value;
    },
  };
  const actual = await waitForWhiteboardImport(client, 'target_board_token', expected, {
    timeoutMs: 10,
    intervalMs: 1,
    now: function () { return clock; },
    sleep: async function (delayMs) { clock += delayMs; },
  });
  assert.equal(calls, 3);
  assert.equal(actual[0].id, 'target-shape');
  assert.equal(whiteboardNodesMatch(expected, actual), true);
  assert.equal(whiteboardNodesMatch(expected, actual.slice(0, 1)), false);
});

test('target visibility polling fails before placeholder cleanup when nodes stay incomplete', async () => {
  let clock = 0;
  await assert.rejects(waitForWhiteboardImport({
    async exportWhiteboard() { return []; },
  }, 'target_board_token', [{ id: 'node-1', type: 'shape' }], {
    timeoutMs: 2,
    intervalMs: 1,
    now: function () { return clock; },
    sleep: async function (delayMs) { clock += delayMs; },
  }), /校验超时.*尚未完整可见/);
});

test('target apply creates exact returned board, imports nodes, and removes marker only after success', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const client = createTargetClient(metadata, false);
  const service = new TransferService({ client: client, store: store });
  const result = await service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1');
  assert.deepEqual(result, { status: 'complete', alreadyComplete: false, boardCount: 1 });
  assert.doesNotMatch(client.content, /FEISHU_HELPER_WHITEBOARD/);
  assert.match(client.content, /target_board_block_1/);
  const update = client.calls.find((call) => call.kind === 'whiteboard');
  assert.equal(update.options.boardToken, 'target_board_token_1');
  assert.match(update.options.idempotentToken, /^fsh-[a-f0-9]{40}$/);
});

test('target apply rolls back only the newly created board and leaves marker retryable', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const client = createTargetClient(metadata, true);
  const service = new TransferService({ client: client, store: store });
  await assert.rejects(
    service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'),
    /simulated update failure/
  );
  assert.match(client.content, /FEISHU_HELPER_WHITEBOARD/);
  assert.doesNotMatch(client.content, /target_board_block_1/);
  const deletes = client.calls.filter((call) => call.kind === 'document'
    && call.options.command === 'block_delete');
  assert.equal(deletes.length, 1);
  assert.equal(
    deletes[0].options.blockId,
    'target_board_block_1,target_ownership_marker_1'
  );
});

test('first target create failure is persisted as retryable instead of staying applying', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const client = {
    async fetchDocument() {
      return {
        document_id: 'TargetDoc1',
        revision_id: 1,
        content: '<p id="target_marker_1">' + metadata.slots[0].marker + '</p>',
      };
    },
    async updateDocument() { throw new Error('permission denied'); },
    async updateWhiteboard() { throw new Error('must not update a missing board'); },
  };
  const service = new TransferService({ client: client, store: store });
  await assert.rejects(
    service.apply(BUNDLE_ID, 'https://target.feishu.cn/wiki/WikiNode1'),
    /permission denied/
  );
  const journal = store.loadJournal(BUNDLE_ID, 'TargetDoc1');
  assert.equal(journal.status, 'retryableFailed');
  assert.match(journal.lastError, /permission denied/);
});

test('rollingBack journal recovers after remote board deletion completed before journal cleanup', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const client = createTargetClient(metadata, false);
  store.saveJournal(BUNDLE_ID, 'TargetDoc1', {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    targetDocumentId: 'TargetDoc1',
    targetUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    status: 'rollingBack',
    boards: {
      'board-0001': {
        slotId: 'board-0001',
        markerBlockId: 'target_marker_1',
        state: 'created',
        baselineBoardIds: [],
        ownershipMarker: transfer.buildOwnershipMarker(
          BUNDLE_ID,
          'board-0001',
          '1'.repeat(32)
        ),
        ownershipMarkerBlockId: 'deleted_owner_1',
        boardBlockId: 'deleted_board_1',
        boardToken: 'deleted_board_token_1',
        assetTokens: {},
      },
    },
  });
  const service = new TransferService({ client: client, store: store });
  assert.deepEqual(await service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'), {
    status: 'complete',
    alreadyComplete: false,
    boardCount: 1,
  });
  assert.match(client.content, /target_board_block_1/);
  assert.doesNotMatch(client.content, /FEISHU_HELPER_WHITEBOARD/);
});

test('rollback reconciliation clears all absent multi-board entries atomically', () => {
  const metadata = transfer.createTransferMetadata(BUNDLE_ID, [
    { blockId: 'source_board_1' },
    { blockId: 'source_board_2' },
  ]);
  const xml = '<p id="marker_1">' + metadata.slots[0].marker + '</p>'
    + '<p id="marker_2">' + metadata.slots[1].marker + '</p>';
  const journal = {
    status: 'rollbackFailed',
    boards: {
      'board-0001': {
        slotId: 'board-0001', markerBlockId: 'marker_1',
        ownershipMarker: transfer.buildOwnershipMarker(BUNDLE_ID, 'board-0001', '2'.repeat(32)),
        boardBlockId: 'deleted_board_1', boardToken: 'deleted_token_1',
      },
      'board-0002': {
        slotId: 'board-0002', markerBlockId: 'marker_2',
        ownershipMarker: transfer.buildOwnershipMarker(BUNDLE_ID, 'board-0002', '3'.repeat(32)),
        boardBlockId: 'deleted_board_2', boardToken: 'deleted_token_2',
      },
    },
  };
  assert.equal(reconcileCompletedRollback(
    journal,
    metadata,
    transfer.findTransferMarkers(xml, metadata),
    [],
    xml
  ), true);
  assert.deepEqual(journal.boards, {});
  assert.equal(journal.status, 'applying');
});

test('fresh apply never adopts, overwrites, or deletes a pre-existing following board', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const marker = metadata.slots[0].marker;
  const content = '<p id="target_marker_1">' + marker + '</p>'
    + '<whiteboard id="user_board" token="user_board_token"></whiteboard>';
  const calls = [];
  const client = {
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 1, content: content };
    },
    async canEditDocument() { return true; },
    async updateDocument(options) {
      calls.push({ kind: 'document', options: options });
      return { ok: true };
    },
    async updateWhiteboard(options) {
      calls.push({ kind: 'whiteboard', options: options });
      return { ok: true };
    },
  };
  const service = new TransferService({ client: client, store: store });
  await assert.rejects(
    service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'),
    /保护原内容/
  );
  assert.equal(calls.length, 0);
  assert.equal(store.loadJournal(BUNDLE_ID, 'TargetDoc1').status, 'conflict');
});

test('creating recovery never claims or deletes an unpersisted adjacent board', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const marker = metadata.slots[0].marker;
  const ownershipMarker = transfer.buildOwnershipMarker(
    BUNDLE_ID,
    'board-0001',
    'd'.repeat(32)
  );
  const content = '<p id="target_marker_1">' + marker + '</p>'
    + '<p id="target_ownership_marker_1">' + ownershipMarker + '</p>'
    + '<whiteboard id="user_board" token="user_board_token"></whiteboard>';
  const calls = [];
  const client = {
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 2, content: content };
    },
    async updateDocument(options) {
      calls.push({ kind: 'document', options: options });
      return { ok: true };
    },
    async updateWhiteboard(options) {
      calls.push({ kind: 'whiteboard', options: options });
      throw new Error('must not import into an unpersisted board');
    },
  };
  store.saveJournal(BUNDLE_ID, 'TargetDoc1', {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    targetDocumentId: 'TargetDoc1',
    targetUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    status: 'applying',
    boards: {
      'board-0001': {
        slotId: 'board-0001',
        markerBlockId: 'target_marker_1',
        state: 'creating',
        baselineBoardIds: [],
        ownershipMarker: ownershipMarker,
        assetTokens: {},
      },
    },
  });
  const service = new TransferService({ client: client, store: store });
  await assert.rejects(
    service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'),
    /无法证明相邻画板所有权/
  );
  assert.equal(calls.length, 0);
  assert.equal(store.loadJournal(BUNDLE_ID, 'TargetDoc1').status, 'conflict');
});

test('commitPending with imported boards and no marker reconciles without repasting', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = saveSimpleBundle(store);
  const boardContent = '<whiteboard id="target_board_block_1" token="target_board_token_1"></whiteboard>';
  const client = {
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 2, content: boardContent };
    },
    async updateDocument() { throw new Error('reconcile must not write the body again'); },
    async updateWhiteboard() { throw new Error('reconcile must not re-import'); },
  };
  store.saveJournal(BUNDLE_ID, 'TargetDoc1', {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    targetDocumentId: 'TargetDoc1',
    targetUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    status: 'commitPending',
    boards: {
      'board-0001': {
        slotId: 'board-0001',
        markerBlockId: 'target_marker_1',
        boardBlockId: 'target_board_block_1',
        boardToken: 'target_board_token_1',
        state: 'imported',
        assetTokens: {},
      },
    },
  });
  const service = new TransferService({ client: client, store: store });
  assert.deepEqual(await service.preflight(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'), {
    needsBodyPaste: false,
    alreadyComplete: true,
    boardCount: 1,
  });
  assert.deepEqual(await service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'), {
    status: 'complete',
    alreadyComplete: true,
    boardCount: 1,
  });
  assert.equal(store.loadJournal(BUNDLE_ID, 'TargetDoc1').status, 'complete');
});

test('commit recovery removes a surviving ownership marker without re-importing', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  const ownershipMarker = transfer.buildOwnershipMarker(
    BUNDLE_ID,
    'board-0001',
    'f'.repeat(32)
  );
  let content = '<p id="target_ownership_marker_1">' + ownershipMarker + '</p>'
    + '<whiteboard id="target_board_block_1" token="target_board_token_1"></whiteboard>';
  const documentCalls = [];
  const client = {
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 3, content: content };
    },
    async updateDocument(options) {
      documentCalls.push(options);
      assert.equal(options.command, 'block_delete');
      assert.equal(options.blockId, 'target_ownership_marker_1');
      content = '<whiteboard id="target_board_block_1" token="target_board_token_1"></whiteboard>';
      return { ok: true };
    },
    async updateWhiteboard() { throw new Error('commit recovery must not re-import'); },
  };
  store.saveJournal(BUNDLE_ID, 'TargetDoc1', {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    targetDocumentId: 'TargetDoc1',
    targetUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    status: 'commitPending',
    boards: {
      'board-0001': {
        slotId: 'board-0001',
        markerBlockId: 'target_marker_1',
        ownershipMarker: ownershipMarker,
        ownershipMarkerBlockId: 'target_ownership_marker_1',
        boardBlockId: 'target_board_block_1',
        boardToken: 'target_board_token_1',
        state: 'imported',
        assetTokens: {},
      },
    },
  });
  const service = new TransferService({ client: client, store: store });
  assert.equal((await service.preflight(
    BUNDLE_ID,
    'https://target.feishu.cn/docx/TargetDoc1'
  )).alreadyComplete, false);
  assert.deepEqual(await service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1'), {
    status: 'complete',
    alreadyComplete: true,
    boardCount: 1,
  });
  assert.equal(documentCalls.length, 1);
  assert.doesNotMatch(content, /OWNERSHIP/);
});

test('image bundle preflight uses target-shaped tokens and apply uploads exactly once', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const metadata = makeTransfer();
  const assetId = 'b'.repeat(64);
  const bundleDir = store.create(BUNDLE_ID);
  const assetFile = path.join('assets', assetId + '.png');
  fs.writeFileSync(path.join(bundleDir, assetFile), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  store.saveBundle({
    schemaVersion: 1,
    id: BUNDLE_ID,
    createdAt: Date.now(),
    expiresAt: Date.now() + transfer.BUNDLE_TTL_MS,
    source: { url: 'https://source.feishu.cn/docx/Source1', documentId: 'Source1', revisionId: 1 },
    transfer: metadata,
    boards: [{
      slotId: 'board-0001',
      sourceBlockId: 'source_board_1',
      nodeCount: 1,
      nodes: [{ id: 'image-1', type: 'image', image: { token: 'feishu-helper-asset:' + assetId } }],
      bindings: [{ nodeIndex: 0, path: ['image', 'token'], assetId: assetId }],
    }],
    assets: [{ id: assetId, mime: 'image/png', byteLength: 8, file: assetFile }],
  });

  let content = '<p id="target_marker_1">' + metadata.slots[0].marker + '</p>';
  let uploadCount = 0;
  let importedNodes = [];
  const documentCalls = [];
  const whiteboardCalls = [];
  const client = {
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 1, content: content };
    },
    async canEditDocument() { return true; },
    async updateDocument(options) {
      documentCalls.push(options);
      if (options.dryRun) return { ok: true, data: { result: 'success' } };
      if (options.command === 'block_insert_after') {
        const ownerMatch = String(options.content || '').match(
          /\[\[FEISHU_HELPER_WHITEBOARD_OWNERSHIP:[a-f0-9]{64}:board-[0-9]{4}:[a-f0-9]{32}\]\]/
        );
        assert.ok(ownerMatch);
        content += '<p id="target_ownership_marker_1">' + ownerMatch[0] + '</p>'
          + '<whiteboard id="target_board_block_1" token="target_board_token_1"></whiteboard>';
        return { data: { document: { new_blocks: [{
          block_id: 'target_board_block_1', block_type: 'whiteboard', block_token: 'target_board_token_1',
        }] } } };
      }
      if (options.command === 'block_delete') {
        content = '<whiteboard id="target_board_block_1" token="target_board_token_1"></whiteboard>';
        return { ok: true };
      }
      throw new Error('unexpected document operation');
    },
    async updateWhiteboard(options) {
      whiteboardCalls.push(options);
      if (!options.dryRun) importedNodes = JSON.parse(JSON.stringify(options.nodes || []));
      return { ok: true };
    },
    async exportWhiteboard() {
      return JSON.parse(JSON.stringify(importedNodes));
    },
    async uploadWhiteboardMedia(options) {
      uploadCount += 1;
      assert.equal(options.file, assetFile);
      return 'target_image_token';
    },
  };
  const service = new TransferService({ client: client, store: store });
  const plan = await service.preflight(BUNDLE_ID, 'https://target.feishu.cn/wiki/WikiNode1');
  assert.equal(plan.needsBodyPaste, false);
  assert.equal(documentCalls[0].documentUrl, 'https://target.feishu.cn/docx/TargetDoc1');
  assert.equal(whiteboardCalls[0].dryRun, true);
  assert.equal(whiteboardCalls[0].nodes[0].image.token, 'boxcnFeishuHelperDryRun0001');
  assert.doesNotMatch(JSON.stringify(whiteboardCalls[0].nodes), /feishu-helper-asset:/);

  const result = await service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1');
  assert.equal(result.status, 'complete');
  assert.equal(uploadCount, 1);
  assert.equal(whiteboardCalls[1].nodes[0].image.token, 'target_image_token');
  await service.apply(BUNDLE_ID, 'https://target.feishu.cn/docx/TargetDoc1');
  assert.equal(uploadCount, 1);
});

test('preflight rejects a read-only CLI identity before any target mutation', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  let mutationCalls = 0;
  const client = {
    async fetchDocument() {
      return { document_id: 'TargetDoc1', revision_id: 1, content: '<p id="blank_1"> </p>' };
    },
    async canEditDocument(documentId) {
      assert.equal(documentId, 'TargetDoc1');
      return false;
    },
    async updateDocument() { mutationCalls += 1; },
    async updateWhiteboard() { mutationCalls += 1; },
  };
  const service = new TransferService({ client: client, store: store });
  await assert.rejects(
    service.preflight(BUNDLE_ID, 'https://target.feishu.cn/wiki/WikiNode1'),
    /CLI 身份没有编辑权限/
  );
  assert.equal(mutationCalls, 0);
});

test('native installer identity and selector parsing are deterministic', () => {
  assert.equal(computeExtensionId(identity.publicKey), identity.extensionId);
  assert.deepEqual(parseMap('*.feishu.cn/wiki/=personal'), {
    hostSuffix: 'feishu.cn',
    pathPrefix: '/wiki/',
    profile: 'personal',
  });
  assert.throws(function () { parseMap('feishu.cn=bad profile'); });
  assert.deepEqual(
    parseArgs(['--chrome-user-data-dir', '/tmp/agent-canary']),
    { maps: [], larkCliPath: '', chromeUserDataDirs: ['/tmp/agent-canary'] },
  );
  assert.deepEqual(extractNewWhiteboardFromUpdate({
    data: { document: { new_blocks: [{
      block_id: 'new_board_block', block_type: 'whiteboard', block_token: 'new_board_token',
    }] } },
  }), { blockId: 'new_board_block', token: 'new_board_token' });
  assert.equal(
    buildCanonicalDocumentUrl('https://target.feishu.cn/wiki/WikiNode1', 'TargetDoc1'),
    'https://target.feishu.cn/docx/TargetDoc1',
  );
  assert.ok(path.isAbsolute(discoverStableNodePath()));
});

test('native installer rejects missing or unauthenticated mapped profiles', () => {
  const rules = [
    { hostSuffix: 'larkoffice.com', pathPrefix: '/', profile: 'corp' },
    { hostSuffix: 'feishu.cn', pathPrefix: '/', profile: 'personal' },
    { hostSuffix: 'my.feishu.cn', pathPrefix: '/', profile: 'personal' },
  ];
  const calls = [];
  const valid = validateConfiguredProfiles('/mock/lark-cli', rules, function (binary, args, options) {
    calls.push({ binary: binary, args: args, options: options });
    return {
      status: 0,
      stdout: JSON.stringify({
        identity: 'user',
        verified: true,
        identities: { user: { status: 'ready', available: true, verified: true } },
      }),
      stderr: '',
    };
  });
  assert.deepEqual(valid, ['corp', 'personal']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    'auth', 'status', '--json', '--verify', '--profile', 'corp',
  ]);

  assert.throws(function () {
    validateConfiguredProfiles('/mock/lark-cli', [rules[0]], function () {
      return { status: 3, stdout: '', stderr: 'profile not found' };
    });
  }, /corp.*不存在/);
  assert.throws(function () {
    validateConfiguredProfiles('/mock/lark-cli', [rules[0]], function () {
      return {
        status: 0,
        stdout: JSON.stringify({
          identity: 'user',
          verified: false,
          identities: { user: { status: 'expired', available: true, verified: false } },
        }),
      };
    });
  }, /登录已失效/);
});

test('installer resolves the npm launcher to a cancellable native lark-cli binary', (t) => {
  const root = makeTempDir(t);
  const scripts = path.join(root, 'scripts');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(scripts);
  fs.mkdirSync(bin);
  const wrapper = path.join(scripts, 'run.js');
  const native = path.join(bin, 'lark-cli');
  fs.writeFileSync(wrapper, '#!/usr/bin/env node\n');
  fs.writeFileSync(native, 'native-binary');
  fs.chmodSync(wrapper, 0o700);
  fs.chmodSync(native, 0o700);
  assert.equal(discoverLarkCli(wrapper), fs.realpathSync(native));
});

test('installer keeps working when an optional browser manifest directory is unavailable', (t) => {
  const root = makeTempDir(t);
  const unavailableParent = path.join(root, 'not-a-directory');
  const availableDirectory = path.join(root, 'available');
  fs.writeFileSync(unavailableParent, 'file');
  const manifest = { name: 'com.example.host', type: 'stdio', path: '/tmp/example' };
  const result = installNativeManifests([
    path.join(unavailableParent, 'NativeMessagingHosts'),
    availableDirectory,
  ], 'com.example.host.json', manifest);
  assert.deepEqual(result.manifestPaths, [path.join(availableDirectory, 'com.example.host.json')]);
  assert.equal(result.manifestWarnings.length, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.manifestPaths[0], 'utf8')),
    manifest,
  );
  assert.throws(function () {
    installNativeManifests([
      path.join(unavailableParent, 'another-directory'),
    ], 'com.example.host.json', manifest);
  }, /无法为任何受支持浏览器安装/);
});

test('profile routing and host request validation fail closed across tenants', () => {
  const config = {
    hostName: 'com.feishu_doc_helper.whiteboard',
    profileRules: [
      { hostSuffix: 'feishu.cn', pathPrefix: '/', profile: 'personal' },
      { hostSuffix: 'my.feishu.cn', pathPrefix: '/wiki/', profile: 'personal-wiki' },
      { hostSuffix: 'larkoffice.com', pathPrefix: '/', profile: 'corp' },
    ],
  };
  assert.equal(resolveProfile(config, 'https://bytedance.sg.larkoffice.com/docx/Doc1'), 'corp');
  assert.equal(resolveProfile(config, 'https://my.feishu.cn/wiki/Doc1'), 'personal-wiki');
  assert.equal(resolveProfile(config, 'https://team.feishu.cn/docx/Doc1'), 'personal');
  assert.equal(resolveProfile(config, 'https://feishu.cn.evil.example/docx/Doc1'), '');

  const base = {
    type: 'FEISHU_HELPER_WHITEBOARD_REQUEST',
    host: config.hostName,
  };
  assert.doesNotThrow(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'inspect', action: 'scan', sourceUrl: 'https://team.feishu.cn/docx/Doc1',
    }));
  });
  assert.doesNotThrow(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'discard', action: 'extract', bundleId: BUNDLE_ID,
    }));
  });
  assert.throws(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'inspect', action: 'extract', sourceUrl: 'https://team.feishu.cn/docx/Doc1',
    }));
  });
  assert.throws(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'discard', action: 'paste', bundleId: BUNDLE_ID,
    }));
  });
  assert.throws(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'discard', action: 'extract', bundleId: BUNDLE_ID, targetUrl: null,
    }));
  });
});

test('LarkClient binds document writes to a revision and requires explicit success', async () => {
  const client = new LarkClient({ binary: '/unused' });
  client.run = async function (args) {
    assert.deepEqual(args, [
      'drive', 'permission.members', 'auth', '--as', 'user',
      '--type', 'docx', '--token', 'TargetDoc1', '--action', 'edit',
    ]);
    return { ok: true, data: { auth_result: true } };
  };
  assert.equal(await client.canEditDocument('TargetDoc1'), true);
  await assert.rejects(client.updateDocument({
    documentUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    command: 'block_delete',
    blockId: 'block_1',
  }), /revision_id/);
  client.run = async function () { return { ok: true, data: {} }; };
  await assert.rejects(client.updateDocument({
    documentUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    command: 'block_delete',
    blockId: 'block_1',
    revisionId: 1,
  }), /missing_result/);
  client.run = async function () { return { ok: true, data: { result: 'partial_success' } }; };
  await assert.rejects(client.updateDocument({
    documentUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    command: 'block_delete',
    blockId: 'block_1',
    revisionId: 1,
  }), /partial_success/);
  let finalArgs = null;
  client.run = async function (args) {
    finalArgs = args;
    return { ok: true, data: { result: 'success' } };
  };
  await assert.doesNotReject(client.updateDocument({
    documentUrl: 'https://target.feishu.cn/docx/TargetDoc1',
    command: 'block_delete',
    blockId: 'block_1',
    revisionId: 1,
  }));
  assert.deepEqual(finalArgs.slice(-2), ['--revision-id', '1']);
});

test('LarkClient accepts the official empty-board shape and requires an update acknowledgement', async () => {
  const client = new LarkClient({ binary: '/unused' });
  client.run = async function () {
    return { ok: true, data: { msg: 'whiteboard has no nodes' } };
  };
  assert.deepEqual(await client.exportWhiteboard('empty_board_token'), []);

  client.run = async function () {
    return { ok: true, data: { created_node_ids: ['target-node-1', 'target-node-2'] } };
  };
  await assert.doesNotReject(client.updateWhiteboard({
    boardToken: 'target_board_token',
    nodes: [{ id: 'source-1' }, { id: 'source-2' }],
    idempotentToken: 'fsh-' + '1'.repeat(40),
  }));

  client.run = async function () {
    return { ok: true, data: {} };
  };
  await assert.rejects(client.updateWhiteboard({
    boardToken: 'target_board_token',
    nodes: [{ id: 'source-1' }, { id: 'source-2' }],
    idempotentToken: 'fsh-' + '2'.repeat(40),
  }), /未返回节点确认/);
});

test('dry-run image nodes never expose local asset placeholders', () => {
  const assetId = 'c'.repeat(64);
  const nodes = buildDryRunNodes({
    nodes: [{ type: 'image', image: { token: 'feishu-helper-asset:' + assetId } }],
    bindings: [{ nodeIndex: 0, path: ['image', 'token'], assetId: assetId }],
  });
  assert.equal(nodes[0].image.token, 'boxcnFeishuHelperDryRun0001');
});
