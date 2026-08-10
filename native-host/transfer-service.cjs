'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const transfer = require('../lib/feishu-whiteboard-transfer.cjs');

const MAX_PARALLEL_EXPORTS = 3;
const MAX_PARALLEL_DOWNLOADS = 3;
const MAX_PARALLEL_PREFLIGHTS = 3;
const MAX_PARALLEL_UPLOADS = 3;
const WHITEBOARD_VERIFY_TIMEOUT_MS = 15000;
const WHITEBOARD_VERIFY_INTERVAL_MS = 500;
const BLANK_WHITEBOARD_XML = '<whiteboard type="blank"></whiteboard>';

class TransferConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferConflictError';
    this.skipRollback = true;
  }
}

function runPool(items, concurrency, worker) {
  const values = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const count = Math.min(Math.max(1, Number(concurrency) || 1), items.length || 1);

  function runOne() {
    if (firstError) return Promise.resolve();
    const index = nextIndex++;
    if (index >= items.length) return Promise.resolve();
    return Promise.resolve(worker(items[index], index)).then(function (value) {
      values[index] = value;
    }).catch(function (error) {
      if (!firstError) firstError = error;
    }).then(function () {
      return runOne();
    });
  }

  const workers = [];
  for (let i = 0; i < count; i += 1) workers.push(runOne());
  return Promise.all(workers).then(function () {
    if (firstError) throw firstError;
    return values;
  });
}

function detectImageFile(buffer, fileName) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const lower = String(fileName || '').toLowerCase();
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a'
    || data.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mime: 'image/gif', extension: 'gif' };
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', extension: 'webp' };
  }
  if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM') {
    return { mime: 'image/bmp', extension: 'bmp' };
  }
  if (data.length >= 4 && (data.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0]))
    || data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))) {
    return { mime: 'image/tiff', extension: 'tiff' };
  }
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) {
    return { mime: 'image/x-icon', extension: 'ico' };
  }
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', extension: 'avif' };
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1') {
      return { mime: 'image/heic', extension: 'heic' };
    }
  }
  if (/\.jpe?g$/.test(lower)) return { mime: 'image/jpeg', extension: 'jpg' };
  throw new Error('画板资源不是受支持的图片格式');
}

function findDownloadedFile(bundleDir, relativePrefix) {
  const absolutePrefix = path.join(bundleDir, relativePrefix);
  const dir = path.dirname(absolutePrefix);
  const prefix = path.basename(absolutePrefix);
  const candidates = fs.readdirSync(dir).filter(function (name) {
    return name === prefix || name.startsWith(prefix + '.');
  });
  if (candidates.length !== 1) throw new Error('无法确定下载后的画板图片文件');
  return path.join(dir, candidates[0]);
}

function extractNewWhiteboardFromUpdate(envelope) {
  const document = envelope && envelope.data && envelope.data.document;
  const blocks = document && Array.isArray(document.new_blocks) ? document.new_blocks : [];
  const boards = blocks.filter(function (block) {
    return block && block.block_type === 'whiteboard'
      && transfer.BLOCK_ID_RE.test(String(block.block_id || ''))
      && transfer.RESOURCE_TOKEN_RE.test(String(block.block_token || ''));
  });
  if (boards.length !== 1) return null;
  return { blockId: String(boards[0].block_id), token: String(boards[0].block_token) };
}

function buildDryRunNodes(board) {
  const targetTokens = Object.create(null);
  let index = 0;
  (board && board.bindings || []).forEach(function (binding) {
    if (!targetTokens[binding.assetId]) {
      index += 1;
      targetTokens[binding.assetId] = 'boxcnFeishuHelperDryRun' + String(index).padStart(4, '0');
    }
  });
  return transfer.applyTargetAssetTokens(board.nodes, board.bindings || [], targetTokens);
}

function summarizeWhiteboardNodeTypes(nodes) {
  const counts = Object.create(null);
  (nodes || []).forEach(function (node) {
    const type = String(node && node.type || '');
    counts[type] = (counts[type] || 0) + 1;
  });
  return Object.keys(counts).sort().map(function (type) {
    return [type, counts[type]];
  });
}

function whiteboardNodesMatch(expectedNodes, actualNodes) {
  if (!Array.isArray(expectedNodes) || !Array.isArray(actualNodes)
    || expectedNodes.length !== actualNodes.length) return false;
  return JSON.stringify(summarizeWhiteboardNodeTypes(expectedNodes))
    === JSON.stringify(summarizeWhiteboardNodeTypes(actualNodes));
}

async function waitForWhiteboardImport(client, boardToken, expectedNodes, options) {
  const opts = options || {};
  const timeoutMs = Math.max(0, Number.isFinite(opts.timeoutMs)
    ? Number(opts.timeoutMs) : WHITEBOARD_VERIFY_TIMEOUT_MS);
  const intervalMs = Math.max(1, Number.isFinite(opts.intervalMs)
    ? Number(opts.intervalMs) : WHITEBOARD_VERIFY_INTERVAL_MS);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : function (delayMs) { return new Promise((resolve) => setTimeout(resolve, delayMs)); };
  const deadline = now() + timeoutMs;
  let lastError = null;

  while (true) {
    try {
      const exported = transfer.sanitizeRawNodesForTransfer(
        await client.exportWhiteboard(boardToken)
      );
      if (whiteboardNodesMatch(expectedNodes, exported)) return exported;
      lastError = new Error('目标画板节点尚未完整可见');
    } catch (error) {
      lastError = error;
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }

  throw new Error('画板更新后校验超时：' + String(lastError && lastError.message || lastError));
}

function importedJournalBoardsPresent(journal, documentBoards, expectedCount) {
  const entries = Object.values(journal && journal.boards || {});
  if (entries.length !== expectedCount) return false;
  return entries.every(function (entry) {
    return entry && entry.state === 'imported'
      && documentBoards.some(function (board) {
        return board.blockId === entry.boardBlockId && board.token === entry.boardToken;
      });
  });
}

function buildOwnedWhiteboardXml(ownershipMarker) {
  if (!transfer.OWNERSHIP_MARKER_RE.test(String(ownershipMarker || ''))) {
    throw new Error('迁移所有权标识无效');
  }
  return '<p>' + ownershipMarker + '</p>' + BLANK_WHITEBOARD_XML;
}

function buildCanonicalDocumentUrl(documentUrl, documentId) {
  const id = String(documentId || '');
  if (!transfer.BLOCK_ID_RE.test(id) || !transfer.isSupportedDocumentUrl(documentUrl)) {
    throw new Error('目标文档 canonical 标识无效');
  }
  const url = new URL(documentUrl);
  url.pathname = '/docx/' + id;
  url.search = '';
  url.hash = '';
  return url.href;
}

function journalFailureMessage(error) {
  return String(error && error.message || error || '目标画板迁移失败')
    .replace(/(access[_-]?token|authorization|bearer)\s*[:=]\s*[^\s;,]+/gi, '$1=[已隐藏]')
    .slice(0, 1000);
}

function collectOwnershipCleanupBlockIds(journal, xml, requireOwnedBoard, transferMetadata) {
  const blockIds = [];
  Object.values(journal && journal.boards || {}).forEach(function (entry) {
    if (!entry || !entry.ownershipMarker) return;
    let record;
    try {
      if (requireOwnedBoard) {
        const slot = transferMetadata && Array.isArray(transferMetadata.slots)
          ? transferMetadata.slots.find((candidate) => candidate.slotId === entry.slotId)
          : null;
        if (!slot) throw new Error('迁移 slot 缺失');
        record = transfer.findOwnedWhiteboard(xml, slot.marker, entry.ownershipMarker);
      } else {
        record = transfer.findOwnershipRecord(xml, entry.ownershipMarker);
      }
    } catch (error) {
      throw new TransferConflictError('迁移所有权结构已被修改，未自动删除任何 block');
    }
    if (!record) {
      if (requireOwnedBoard && entry.boardBlockId) {
        throw new TransferConflictError('迁移所有权标识缺失，未自动删除任何 block');
      }
      return;
    }
    if ((entry.ownershipMarkerBlockId && record.ownershipMarkerBlockId !== entry.ownershipMarkerBlockId)
      || (entry.boardBlockId && record.boardBlockId !== entry.boardBlockId)
      || (entry.boardToken && record.boardToken !== entry.boardToken)) {
      throw new TransferConflictError('迁移所有权 block 已被替换，未自动删除任何 block');
    }
    blockIds.push(record.ownershipMarkerBlockId);
  });
  return blockIds;
}

function reconcileCompletedRollback(journal, transferMetadata, markers, existingBoards, xml) {
  if (!journal || (journal.status !== 'rollingBack' && journal.status !== 'rollbackFailed')) return false;
  if (!transfer.validateTransferMetadata(transferMetadata)) return false;
  const validSlots = new Set(transferMetadata.slots.map((slot) => slot.slotId));
  const entries = Object.values(journal.boards || {}).filter(function (entry) {
    return entry && transfer.BLOCK_ID_RE.test(String(entry.boardBlockId || ''));
  });
  if (!entries.length) return false;
  const markerBySlot = new Map((markers || []).map((marker) => [marker.slotId, marker]));
  const allAbsent = entries.every(function (entry) {
    if (!validSlots.has(entry.slotId)) return false;
    const marker = markerBySlot.get(entry.slotId);
    if (!marker || marker.markerBlockId !== entry.markerBlockId || marker.followingBoard) return false;
    const boardStillExists = (existingBoards || []).some(function (candidate) {
      return candidate.blockId === entry.boardBlockId || candidate.token === entry.boardToken;
    });
    if (boardStillExists) return false;
    return !transfer.findExactTextBlock(xml, entry.ownershipMarker);
  });
  if (!allAbsent) return false;
  entries.forEach(function (entry) { delete journal.boards[entry.slotId]; });
  journal.status = Object.keys(journal.boards).length ? 'recoveryRequired' : 'applying';
  journal.updatedAt = Date.now();
  return true;
}

function persistJournal(store, bundleId, targetDocumentId, journal, status) {
  if (status) journal.status = status;
  journal.updatedAt = Date.now();
  store.saveJournal(bundleId, targetDocumentId, journal);
}

function assertOwnedBoard(document, marker, entry) {
  let owned;
  try {
    owned = transfer.findOwnedWhiteboard(
      document.content,
      marker.marker,
      entry.ownershipMarker
    );
  } catch (error) {
    throw new TransferConflictError('目标画板所有权结构已被移动或替换，未自动删除任何画板');
  }
  if (!owned || owned.ownershipMarkerBlockId !== entry.ownershipMarkerBlockId
    || owned.boardBlockId !== entry.boardBlockId || owned.boardToken !== entry.boardToken) {
    throw new TransferConflictError('目标画板所有权无法验证，未自动删除任何画板');
  }
}

async function ensureOwnedBoard(options) {
  const opts = options || {};
  const client = opts.client;
  const store = opts.store;
  const bundle = opts.bundle;
  const marker = opts.marker;
  const board = opts.board;
  const journal = opts.journal;
  const targetDocumentId = opts.targetDocumentId;
  let document = opts.document;
  let entry = journal.boards[board.slotId] || null;

  if (entry && entry.boardBlockId) assertOwnedBoard(document, marker, entry);
  if (entry && entry.state !== 'creating') return { document: document, entry: entry };
  if (!entry && marker.followingBoard) {
    throw new TransferConflictError('画板占位符后已有非本次迁移创建的画板，已停止以保护原内容');
  }

  const existingBoards = transfer.listDocumentWhiteboards(document.content);
  if (!entry) {
    entry = {
      slotId: board.slotId,
      markerBlockId: marker.markerBlockId,
      state: 'creating',
      baselineBoardIds: existingBoards.map((item) => item.blockId),
      ownershipMarker: transfer.buildOwnershipMarker(
        bundle.id,
        board.slotId,
        crypto.randomBytes(16).toString('hex')
      ),
      assetTokens: {},
    };
    journal.boards[board.slotId] = entry;
    persistJournal(store, bundle.id, targetDocumentId, journal);
  }
  if (!transfer.OWNERSHIP_MARKER_RE.test(String(entry.ownershipMarker || ''))
    || !Array.isArray(entry.baselineBoardIds)) {
    throw new TransferConflictError('旧的创建中状态缺少可验证所有权，请重新提取后再粘贴');
  }

  const existingOwnershipBlock = transfer.findExactTextBlock(document.content, entry.ownershipMarker);
  const baselineBoardIds = new Set(entry.baselineBoardIds);
  const unownedNewBoards = existingBoards.filter(function (candidate) {
    return !baselineBoardIds.has(candidate.blockId);
  });
  if (existingOwnershipBlock || marker.followingBoard || unownedNewBoards.length) {
    throw new TransferConflictError('创建结果尚未持久化，无法证明相邻画板所有权；未覆盖或删除任何画板');
  }

  const updateResult = await client.updateDocument({
    documentUrl: opts.canonicalTargetUrl,
    command: 'block_insert_after',
    blockId: marker.markerBlockId,
    revisionId: document.revision_id,
    content: buildOwnedWhiteboardXml(entry.ownershipMarker),
  });
  const returnedBoard = extractNewWhiteboardFromUpdate(updateResult);
  if (!returnedBoard) {
    throw new TransferConflictError('创建空白画板未返回唯一 block/token，未认领任何画板');
  }

  document = await client.fetchDocument(opts.targetUrl);
  let owned;
  try {
    owned = transfer.findOwnedWhiteboard(document.content, marker.marker, entry.ownershipMarker);
  } catch (error) {
    throw new TransferConflictError('创建后的所有权结构无法验证，未认领任何画板');
  }
  if (!owned || owned.boardBlockId !== returnedBoard.blockId
    || owned.boardToken !== returnedBoard.token || baselineBoardIds.has(owned.boardBlockId)) {
    throw new TransferConflictError('创建返回与目标文档不一致，未认领任何画板');
  }

  entry.ownershipMarkerBlockId = owned.ownershipMarkerBlockId;
  entry.boardBlockId = owned.boardBlockId;
  entry.boardToken = owned.boardToken;
  entry.state = 'created';
  entry.assetTokens = entry.assetTokens || {};
  entry.idempotentToken = transfer.createIdempotentToken(
    bundle.id,
    targetDocumentId,
    board.slotId,
    owned.boardToken
  );
  persistJournal(store, bundle.id, targetDocumentId, journal);
  return { document: document, entry: entry };
}

async function uploadBoardAssets(options) {
  const opts = options || {};
  const entry = opts.entry;
  const assetIds = Array.from(new Set((opts.board.bindings || []).map((binding) => binding.assetId)))
    .filter((assetId) => !entry.assetTokens[assetId]);
  await runPool(assetIds, MAX_PARALLEL_UPLOADS, async function (assetId, index) {
    const asset = opts.assetById.get(assetId);
    if (!asset) throw new Error('迁移包缺少画板图片资源');
    const bundleDir = opts.store.bundleDir(opts.bundle.id);
    const assetPath = path.join(bundleDir, asset.file);
    const relativeAssetPath = path.relative(bundleDir, assetPath);
    if (relativeAssetPath.startsWith('..') || path.isAbsolute(relativeAssetPath)) {
      throw new Error('画板图片路径越界');
    }
    try {
      entry.assetTokens[assetId] = await opts.client.uploadWhiteboardMedia({
        documentId: opts.targetDocumentId,
        boardToken: entry.boardToken,
        file: relativeAssetPath,
        cwd: bundleDir,
      });
    } catch (error) {
      throw new Error(opts.board.slotId + ' 第 ' + (index + 1) + ' 个图片上传失败：'
        + String(error && error.message || error));
    }
    persistJournal(opts.store, opts.bundle.id, opts.targetDocumentId, opts.journal);
  });
}

async function importBoard(options) {
  const opts = options || {};
  const entry = opts.entry;
  if (entry.state === 'imported') return;
  await uploadBoardAssets(opts);
  const targetNodes = transfer.applyTargetAssetTokens(
    opts.board.nodes,
    opts.board.bindings,
    entry.assetTokens
  );
  await opts.client.updateWhiteboard({
    boardToken: entry.boardToken,
    nodes: targetNodes,
    idempotentToken: entry.idempotentToken,
    cwd: opts.store.bundleDir(opts.bundle.id),
  });
  await waitForWhiteboardImport(opts.client, entry.boardToken, targetNodes);
  entry.state = 'imported';
  persistJournal(opts.store, opts.bundle.id, opts.targetDocumentId, opts.journal);
}

async function rollbackCreatedBoards(options, originalError) {
  const opts = options || {};
  const journal = opts.journal;
  const createdBlockIds = Object.values(journal.boards || {})
    .map((entry) => String(entry.boardBlockId || ''))
    .filter((blockId) => transfer.BLOCK_ID_RE.test(blockId));
  if (!createdBlockIds.length) {
    journal.lastError = journalFailureMessage(originalError);
    persistJournal(opts.store, opts.bundle.id, opts.targetDocumentId, journal, 'retryableFailed');
    return;
  }

  persistJournal(opts.store, opts.bundle.id, opts.targetDocumentId, journal, 'rollingBack');
  try {
    const beforeRollback = await opts.client.fetchDocument(opts.targetUrl);
    const ownershipBlockIds = collectOwnershipCleanupBlockIds(
      journal,
      beforeRollback.content,
      true,
      opts.bundle.transfer
    );
    await opts.client.updateDocument({
      documentUrl: opts.canonicalTargetUrl,
      command: 'block_delete',
      blockId: createdBlockIds.concat(ownershipBlockIds).join(','),
      revisionId: beforeRollback.revision_id,
    });
    const afterRollback = await opts.client.fetchDocument(opts.targetUrl);
    const remainingIds = new Set(transfer.listDocumentWhiteboards(afterRollback.content)
      .map((board) => board.blockId));
    if (createdBlockIds.some((blockId) => remainingIds.has(blockId))) {
      throw new Error('回滚后仍检测到本次创建的画板');
    }
    const remainingOwnership = Object.values(journal.boards || {}).some(function (entry) {
      return entry && entry.ownershipMarker
        && transfer.findExactTextBlock(afterRollback.content, entry.ownershipMarker);
    });
    if (remainingOwnership) throw new Error('回滚后仍检测到迁移所有权标识');
    const unresolved = Object.entries(journal.boards || {}).filter(function (pair) {
      return !transfer.BLOCK_ID_RE.test(String(pair[1] && pair[1].boardBlockId || ''));
    });
    journal.boards = Object.fromEntries(unresolved);
    persistJournal(
      opts.store,
      opts.bundle.id,
      opts.targetDocumentId,
      journal,
      unresolved.length ? 'recoveryRequired' : 'rolledBack'
    );
  } catch (rollbackError) {
    persistJournal(
      opts.store,
      opts.bundle.id,
      opts.targetDocumentId,
      journal,
      rollbackError && rollbackError.skipRollback ? 'conflict' : 'rollbackFailed'
    );
    throw new Error(String(originalError.message || originalError)
      + '；自动回滚失败：' + String(rollbackError.message || rollbackError));
  }
}

class TransferService {
  constructor(options) {
    const opts = options || {};
    this.client = opts.client;
    this.store = opts.store;
    if (!this.client || !this.store) throw new Error('TransferService 缺少 client/store');
  }

  async inspectSource(sourceUrl) {
    if (!transfer.isSupportedDocumentUrl(sourceUrl)) throw new Error('源文档 URL 不受支持');
    const document = await this.client.fetchDocument(sourceUrl);
    return transfer.summarizeDocumentStructure(document.content);
  }

  async inspectCopyPermission(sourceUrl) {
    if (!transfer.isSupportedDocumentUrl(sourceUrl)) return { copyAllowed: false };
    try {
      if (typeof this.client.canCopyDocument !== 'function') return { copyAllowed: false };
      return { copyAllowed: await this.client.canCopyDocument(sourceUrl) === true };
    } catch (error) {
      return { copyAllowed: false };
    }
  }

  async exportSource(sourceUrl) {
    if (!transfer.isSupportedDocumentUrl(sourceUrl)) throw new Error('源文档 URL 不受支持');
    this.store.cleanupExpired();
    const document = await this.client.fetchDocument(sourceUrl);
    const sourceSummary = transfer.summarizeDocumentStructure(document.content);
    const sourceBoards = transfer.listDocumentWhiteboards(document.content);
    if (!sourceBoards.length) {
      return { whiteboardTransfer: null, boardCount: 0, sourceSummary: sourceSummary };
    }

    const bundleId = transfer.createBundleId();
    const bundleDir = this.store.create(bundleId);
    const metadata = transfer.createTransferMetadata(bundleId, sourceBoards);
    const sourceTokens = sourceBoards.map((board) => board.token);

    try {
      let totalNodeBytes = 0;
      const exportedBoards = await runPool(sourceBoards, MAX_PARALLEL_EXPORTS, async (board, index) => {
        const stats = {};
        const nodes = transfer.sanitizeRawNodesForTransfer(
          await this.client.exportWhiteboard(board.token),
          stats
        );
        totalNodeBytes += stats.byteLength;
        if (totalNodeBytes > transfer.MAX_BUNDLE_NODE_JSON_BYTES) {
          throw new Error('画板节点总量超过迁移包 64MiB 安全上限');
        }
        const bindings = transfer.collectImageTokenBindings(nodes, { validated: true });
        bindings.forEach((binding) => sourceTokens.push(binding.sourceToken));
        return {
          slotId: metadata.slots[index].slotId,
          sourceBlockId: board.blockId,
          nodes: nodes,
          bindings: bindings,
        };
      });

      const uniqueSourceImageTokens = [];
      const seenSourceImageTokens = new Set();
      exportedBoards.forEach(function (board) {
        board.bindings.forEach(function (binding) {
          if (seenSourceImageTokens.has(binding.sourceToken)) return;
          seenSourceImageTokens.add(binding.sourceToken);
          uniqueSourceImageTokens.push(binding.sourceToken);
        });
      });
      if (uniqueSourceImageTokens.length > transfer.MAX_ASSETS) {
        throw new Error('画板图片数量超过安全上限');
      }

      let totalAssetBytes = 0;
      const downloads = await runPool(uniqueSourceImageTokens, MAX_PARALLEL_DOWNLOADS, async (token, index) => {
        const relativePrefix = path.join('assets', 'download-' + String(index + 1).padStart(4, '0'));
        await this.client.downloadMedia(token, relativePrefix, bundleDir);
        const downloadedPath = findDownloadedFile(bundleDir, relativePrefix);
        const stat = fs.statSync(downloadedPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > transfer.MAX_ASSET_BYTES) {
          throw new Error('画板图片为空或超过 20MiB 上限');
        }
        totalAssetBytes += stat.size;
        if (totalAssetBytes > transfer.MAX_BUNDLE_ASSET_BYTES) {
          throw new Error('画板图片总量超过迁移包 256MiB 安全上限');
        }
        const bytes = fs.readFileSync(downloadedPath);
        const detected = detectImageFile(bytes, downloadedPath);
        const assetId = crypto.createHash('sha256').update(bytes).digest('hex');
        const relativeFile = path.join('assets', assetId + '.' + detected.extension);
        const finalPath = path.join(bundleDir, relativeFile);
        if (fs.existsSync(finalPath)) fs.rmSync(downloadedPath, { force: true });
        else fs.renameSync(downloadedPath, finalPath);
        return {
          sourceToken: token,
          assetId: assetId,
          asset: {
            id: assetId,
            mime: detected.mime,
            byteLength: stat.size,
            file: relativeFile,
          },
        };
      });

      const sourceTokenToAssetId = Object.create(null);
      const assetsById = new Map();
      downloads.forEach(function (download) {
        sourceTokenToAssetId[download.sourceToken] = download.assetId;
        if (!assetsById.has(download.assetId)) assetsById.set(download.assetId, download.asset);
      });

      const bundleBoards = exportedBoards.map(function (board) {
        const replaced = transfer.replaceSourceTokensWithAssets(
          board.nodes,
          board.bindings,
          sourceTokenToAssetId
        );
        return {
          slotId: board.slotId,
          sourceBlockId: board.sourceBlockId,
          nodeCount: replaced.nodes.length,
          nodes: replaced.nodes,
          bindings: replaced.bindings,
        };
      });

      // 浏览器端会导出飞书自身的 PageDetail，nodeCount 是两条独立导出链
      // 之间的完整性契约。后续若页面只加载了局部画板，提取阶段会直接失败，
      // 不会把空壳或残缺画板写入 pending paste。
      metadata.slots.forEach(function (slot, index) {
        slot.nodeCount = bundleBoards[index].nodeCount;
      });

      const now = Date.now();
      const bundle = {
        schemaVersion: transfer.BUNDLE_SCHEMA_VERSION,
        id: bundleId,
        createdAt: now,
        expiresAt: now + transfer.BUNDLE_TTL_MS,
        source: {
          url: sourceUrl,
          documentId: String(document.document_id),
          revisionId: Number(document.revision_id || 0),
        },
        transfer: metadata,
        boards: bundleBoards,
        assets: Array.from(assetsById.values()),
      };
      transfer.assertBundleDoesNotContainSourceTokens(bundle, sourceTokens);
      this.store.saveBundle(bundle);
      return {
        whiteboardTransfer: metadata,
        boardCount: metadata.boardCount,
        sourceSummary: sourceSummary,
      };
    } catch (error) {
      this.store.discard(bundleId);
      throw error;
    }
  }

  async preflight(bundleId, targetUrl) {
    if (!transfer.isSupportedDocumentUrl(targetUrl)) throw new Error('目标文档 URL 不受支持');
    this.store.cleanupExpired();
    const bundle = this.store.loadBundle(bundleId);
    const document = await this.client.fetchDocument(targetUrl);
    const canonicalTargetUrl = buildCanonicalDocumentUrl(targetUrl, document.document_id);
    const markers = transfer.findTransferMarkers(document.content, bundle.transfer);
    const journal = this.store.loadJournal(bundleId, String(document.document_id));
    const allTargetBoards = transfer.listDocumentWhiteboards(document.content);

    if (journal) {
      const allBoardsPresent = importedJournalBoardsPresent(
        journal,
        allTargetBoards,
        bundle.transfer.boardCount
      );
      if (allBoardsPresent && markers.length === 0) {
        const ownershipCleanupPending = collectOwnershipCleanupBlockIds(
          journal,
          document.content,
          false
        ).length > 0;
        return {
          needsBodyPaste: false,
          alreadyComplete: !ownershipCleanupPending,
          boardCount: bundle.transfer.boardCount,
        };
      }
      if (allBoardsPresent && journal.status !== 'complete') {
        return { needsBodyPaste: false, alreadyComplete: false, boardCount: bundle.transfer.boardCount };
      }
      if (journal.status === 'complete') {
        throw new Error('目标文档已偏离上次迁移完成状态，请重新提取后再粘贴');
      }
      if (markers.length === 0) {
        throw new Error('目标迁移状态存在但画板占位符缺失，已停止以避免重复粘贴正文');
      }
    }
    if (markers.length !== 0 && markers.length !== bundle.transfer.boardCount) {
      throw new Error('目标文档只包含部分画板占位符，已停止以避免重复写入');
    }

    if (typeof this.client.canEditDocument !== 'function'
      || !await this.client.canEditDocument(String(document.document_id))) {
      throw new Error('目标文档当前 CLI 身份没有编辑权限；请为 '
        + new URL(targetUrl).hostname + ' 配置具有编辑权限的 lark-cli profile');
    }

    await this.client.updateDocument({
      documentUrl: canonicalTargetUrl,
      command: 'block_insert_after',
      blockId: '-1',
      revisionId: document.revision_id,
      content: buildOwnedWhiteboardXml(transfer.buildOwnershipMarker(
        bundle.id,
        bundle.transfer.slots[0].slotId,
        '0'.repeat(32)
      )),
      dryRun: true,
    });
    await runPool(bundle.boards, MAX_PARALLEL_PREFLIGHTS, async (board) => {
      try {
        await this.client.updateWhiteboard({
          boardToken: 'wbcn_feishu_helper_dry_run',
          nodes: buildDryRunNodes(board),
          idempotentToken: transfer.createIdempotentToken(
            bundle.id,
            String(document.document_id),
            board.slotId,
            'wbcn_feishu_helper_dry_run'
          ),
          dryRun: true,
          cwd: this.store.bundleDir(bundle.id),
        });
      } catch (error) {
        throw new Error(board.slotId + ' 画板预检失败：' + String(error && error.message || error));
      }
    });

    return {
      needsBodyPaste: markers.length === 0,
      alreadyComplete: false,
      boardCount: bundle.transfer.boardCount,
    };
  }

  async apply(bundleId, targetUrl) {
    if (!transfer.isSupportedDocumentUrl(targetUrl)) throw new Error('目标文档 URL 不受支持');
    this.store.cleanupExpired();
    const bundle = this.store.loadBundle(bundleId);
    const initialDocument = await this.client.fetchDocument(targetUrl);
    const targetDocumentId = String(initialDocument.document_id);
    return this.store.withTargetLock(bundleId, targetDocumentId, async () => {
      return this.applyLocked(bundle, targetUrl, targetDocumentId);
    });
  }

  async applyLocked(bundle, targetUrl, targetDocumentId) {
    const canonicalTargetUrl = buildCanonicalDocumentUrl(targetUrl, targetDocumentId);
    let document = await this.client.fetchDocument(targetUrl);
    let markers = transfer.findTransferMarkers(document.content, bundle.transfer);
    let journal = this.store.loadJournal(bundle.id, targetDocumentId);
    let existingBoards = transfer.listDocumentWhiteboards(document.content);

    if (journal && importedJournalBoardsPresent(journal, existingBoards, bundle.transfer.boardCount)) {
      return this.finalizeImportedJournal(
        bundle,
        targetUrl,
        targetDocumentId,
        journal,
        true
      );
    }
    if (journal && journal.status === 'complete') {
      throw new Error('目标文档已偏离上次迁移完成状态，请重新提取后再粘贴');
    }
    if (markers.length !== bundle.transfer.boardCount) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && markers.length !== bundle.transfer.boardCount) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        document = await this.client.fetchDocument(targetUrl);
        markers = transfer.findTransferMarkers(document.content, bundle.transfer);
      }
      existingBoards = transfer.listDocumentWhiteboards(document.content);
      if (journal && importedJournalBoardsPresent(journal, existingBoards, bundle.transfer.boardCount)) {
        return this.finalizeImportedJournal(
          bundle,
          targetUrl,
          targetDocumentId,
          journal,
          true
        );
      }
    }
    if (markers.length !== bundle.transfer.boardCount) {
      throw new Error('未找到完整画板占位符；正文尚未粘贴或目标内容已被修改');
    }

    if (journal && reconcileCompletedRollback(
      journal,
      bundle.transfer,
      markers,
      existingBoards,
      document.content
    )) {
      this.store.saveJournal(bundle.id, targetDocumentId, journal);
    }

    if (!journal) {
      journal = {
        schemaVersion: 1,
        bundleId: bundle.id,
        targetDocumentId: targetDocumentId,
        targetUrl: targetUrl,
        status: 'applying',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        boards: {},
      };
      this.store.saveJournal(bundle.id, targetDocumentId, journal);
    }

    const markerBySlot = new Map(markers.map((marker) => [marker.slotId, marker]));
    const assetById = new Map((bundle.assets || []).map((asset) => [asset.id, asset]));
    const applyOptions = {
      client: this.client,
      store: this.store,
      bundle: bundle,
      targetUrl: targetUrl,
      targetDocumentId: targetDocumentId,
      canonicalTargetUrl: canonicalTargetUrl,
      journal: journal,
      assetById: assetById,
    };

    try {
      for (const board of bundle.boards) {
        const marker = markerBySlot.get(board.slotId);
        if (!marker) throw new Error('画板占位符与迁移包不一致');
        const owned = await ensureOwnedBoard(Object.assign({}, applyOptions, {
          board: board,
          marker: marker,
          document: document,
        }));
        document = owned.document;
        await importBoard(Object.assign({}, applyOptions, {
          board: board,
          entry: owned.entry,
        }));
      }
    } catch (error) {
      if (error && error.skipRollback) {
        persistJournal(this.store, bundle.id, targetDocumentId, journal, 'conflict');
        throw error;
      }
      await rollbackCreatedBoards(applyOptions, error);
      throw error;
    }

    return this.finalizeImportedJournal(
      bundle,
      targetUrl,
      targetDocumentId,
      journal,
      false
    );
  }

  async finalizeImportedJournal(bundle, targetUrl, targetDocumentId, journal, alreadyComplete) {
    const canonicalTargetUrl = buildCanonicalDocumentUrl(targetUrl, targetDocumentId);
    let document = await this.client.fetchDocument(targetUrl);
    let existingBoards = transfer.listDocumentWhiteboards(document.content);
    if (!importedJournalBoardsPresent(journal, existingBoards, bundle.transfer.boardCount)) {
      throw new Error('迁移完成校验发现目标画板缺失');
    }
    persistJournal(this.store, bundle.id, targetDocumentId, journal, 'committing');
    try {
      const markers = transfer.findTransferMarkers(document.content, bundle.transfer);
      const ownershipBlockIds = collectOwnershipCleanupBlockIds(journal, document.content, false);
      const cleanupBlockIds = Array.from(new Set(
        markers.map((marker) => marker.markerBlockId).concat(ownershipBlockIds)
      ));
      if (cleanupBlockIds.length) {
        await this.client.updateDocument({
          documentUrl: canonicalTargetUrl,
          command: 'block_delete',
          blockId: cleanupBlockIds.join(','),
          revisionId: document.revision_id,
        });
      }
      document = await this.client.fetchDocument(targetUrl);
      if (transfer.findTransferMarkers(document.content, bundle.transfer).length) {
        throw new Error('占位符清理未完成');
      }
      const remainingOwnership = Object.values(journal.boards || {}).some(function (entry) {
        return entry && entry.ownershipMarker
          && transfer.findExactTextBlock(document.content, entry.ownershipMarker);
      });
      if (remainingOwnership) throw new Error('迁移所有权标识清理未完成');
      existingBoards = transfer.listDocumentWhiteboards(document.content);
      if (!importedJournalBoardsPresent(journal, existingBoards, bundle.transfer.boardCount)) {
        throw new Error('迁移完成校验发现目标画板缺失');
      }
    } catch (error) {
      persistJournal(
        this.store,
        bundle.id,
        targetDocumentId,
        journal,
        error && error.skipRollback ? 'conflict' : 'commitPending'
      );
      if (error && error.skipRollback) throw error;
      throw new Error('画板已写入，但占位符清理待重试：' + String(error.message || error));
    }

    journal.status = 'complete';
    journal.completedAt = Date.now();
    journal.updatedAt = journal.completedAt;
    this.store.saveJournal(bundle.id, targetDocumentId, journal);
    return {
      status: 'complete',
      alreadyComplete: !!alreadyComplete,
      boardCount: bundle.transfer.boardCount,
    };
  }

  async reconcileImages(images, targetUrl) {
    const bindings = Array.isArray(images) ? images : [];
    if (!bindings.length || bindings.length > 500) throw new Error('图片归位绑定无效');
    let document = await this.client.fetchDocument(targetUrl);
    const canonicalTargetUrl = buildCanonicalDocumentUrl(targetUrl, document.document_id);
    if (typeof this.client.canEditDocument !== 'function'
      || !await this.client.canEditDocument(String(document.document_id))) {
      throw new Error('目标文档当前 CLI 身份没有编辑权限');
    }
    bindings.forEach(function (binding) {
      if (!transfer.findExactTextBlock(document.content, binding.marker)) {
        throw new Error('目标文档缺少图片占位符');
      }
      if (!String(document.content || '').includes('id="' + binding.stagingBlockId + '"')) {
        throw new Error('目标文档缺少已注册的图片暂存块');
      }
    });

    for (const binding of bindings) {
      document = await this.client.fetchDocument(targetUrl);
      const marker = transfer.findExactTextBlock(document.content, binding.marker);
      if (!marker) throw new Error('图片归位过程中占位符消失');
      const tokenNeedle = 'token="' + binding.targetToken + '"';
      const beforeCount = String(document.content || '').split(tokenNeedle).length - 1;
      await this.client.updateDocument({
        documentUrl: canonicalTargetUrl,
        command: 'block_insert_after',
        blockId: marker.blockId,
        revisionId: document.revision_id,
        content: '<img token="' + binding.targetToken + '"/>',
      });
      document = await this.client.fetchDocument(targetUrl);
      const afterCount = String(document.content || '').split(tokenNeedle).length - 1;
      if (afterCount <= beforeCount) throw new Error('目标图片块插入后未通过读取校验');
      await this.client.updateDocument({
        documentUrl: canonicalTargetUrl,
        command: 'block_delete',
        blockId: marker.blockId + ',' + binding.stagingBlockId,
        revisionId: document.revision_id,
      });
    }

    document = await this.client.fetchDocument(targetUrl);
    bindings.forEach(function (binding) {
      if (transfer.findExactTextBlock(document.content, binding.marker)
        || String(document.content || '').includes('id="' + binding.stagingBlockId + '"')
        || !String(document.content || '').includes('token="' + binding.targetToken + '"')) {
        throw new Error('图片归位后的最终结构校验失败');
      }
    });
    return { status: 'complete', imageCount: bindings.length };
  }

}

module.exports = {
  TransferService,
  buildCanonicalDocumentUrl,
  buildDryRunNodes,
  collectOwnershipCleanupBlockIds,
  extractNewWhiteboardFromUpdate,
  reconcileCompletedRollback,
  waitForWhiteboardImport,
  whiteboardNodesMatch,
};
