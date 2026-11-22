'use strict';

const transfer = require('../lib/feishu-whiteboard-transfer.cjs');
const { BundleStore } = require('./bundle-store.cjs');

const MAX_PARALLEL_EXPORTS = 3;

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
    }).then(runOne);
  }

  return Promise.all(Array.from({ length: count }, runOne)).then(function () {
    if (firstError) throw firstError;
    return values;
  });
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
    const metadata = transfer.createTransferMetadata(bundleId, sourceBoards);
    let totalNodeBytes = 0;
    const nodeCounts = await runPool(sourceBoards, MAX_PARALLEL_EXPORTS, async (board) => {
      const stats = {};
      const nodes = transfer.sanitizeRawNodesForTransfer(
        await this.client.exportWhiteboard(board.token),
        stats
      );
      totalNodeBytes += stats.byteLength;
      if (totalNodeBytes > transfer.MAX_BUNDLE_NODE_JSON_BYTES) {
        throw new Error('画板节点总量超过 64MiB 安全上限');
      }
      return nodes.length;
    });

    metadata.slots.forEach(function (slot, index) {
      slot.nodeCount = nodeCounts[index];
    });

    return {
      whiteboardTransfer: metadata,
      boardCount: metadata.boardCount,
      sourceSummary: sourceSummary,
    };
  }
}

module.exports = { TransferService };
