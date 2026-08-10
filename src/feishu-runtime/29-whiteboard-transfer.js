  // ── Whiteboard transfer markers & Native Messaging bridge ────────────────

  var WHITEBOARD_NATIVE_EVENT = 'feishu-helper:whiteboard-native';
  var WHITEBOARD_NATIVE_RESULT_EVENT = 'feishu-helper:whiteboard-native-result';
  var WHITEBOARD_MARKER_PREFIX = '[[FEISHU_HELPER_WHITEBOARD:';
  var WHITEBOARD_BUNDLE_ID_RE = /^[a-f0-9]{64}$/;
  var WHITEBOARD_SLOT_ID_RE = /^board-[0-9]{4}$/;
  var WHITEBOARD_BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
  var WHITEBOARD_RESOURCE_KEY_RE = /^[A-Za-z0-9_.~-]{1,1024}$/;
  var WHITEBOARD_PAGE_DETAIL_MAX_BYTES = 4 * 1024 * 1024;
  var WHITEBOARD_PAGE_DETAIL_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
  var WHITEBOARD_PAGE_DETAIL_MAX_NODES = 20000;
  var WHITEBOARD_PAGE_DETAIL_MAX_DEPTH = 64;
  var WHITEBOARD_ASSET_MAX_COUNT = 500;

  function jsonByteLength(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch (error) { return -1; }
  }

  function countWhiteboardPageDetailNodes(nodes, depth, state) {
    if (!Array.isArray(nodes) || depth > WHITEBOARD_PAGE_DETAIL_MAX_DEPTH) return false;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || typeof node !== 'object' || Array.isArray(node)
        || typeof node.id !== 'string' || !node.id || node.id.length > 256
        || !node.info || typeof node.info !== 'object' || Array.isArray(node.info)
        || !Array.isArray(node.children)) return false;
      state.count += 1;
      if (state.count > WHITEBOARD_PAGE_DETAIL_MAX_NODES
        || !countWhiteboardPageDetailNodes(node.children, depth + 1, state)) return false;
    }
    return true;
  }

  function validateWhiteboardPageDetail(value, expectedNodeCount) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var allowed = { nodes: true, meta: true, comments: true, resources: true, ops: true };
    var keys = Object.keys(value);
    if (keys.some(function (key) { return !allowed[key]; })
      || !Array.isArray(value.nodes) || !value.comments || typeof value.comments !== 'object'
      || Array.isArray(value.comments)
      || !Array.isArray(value.resources) || !Array.isArray(value.ops)
      || !value.meta || typeof value.meta !== 'object' || Array.isArray(value.meta)) return false;
    var state = { count: 0 };
    if (!countWhiteboardPageDetailNodes(value.nodes, 0, state)
      || (Number.isInteger(expectedNodeCount) && state.count !== expectedNodeCount)) return false;
    var bytes = jsonByteLength(value);
    return bytes > 0 && bytes <= WHITEBOARD_PAGE_DETAIL_MAX_BYTES;
  }

  function isValidBrowserWhiteboardBoards(value, transfer) {
    if (!Array.isArray(value) || value.length !== transfer.boardCount) return false;
    var slotById = {};
    transfer.slots.forEach(function (slot) { slotById[slot.slotId] = slot; });
    var seen = {};
    var totalBytes = 0;
    var totalAssets = 0;
    for (var i = 0; i < value.length; i++) {
      var board = value[i] || {};
      var allowed = {
        slotId: true, sourceBlockId: true, sourceWhiteboardToken: true,
        pageDetail: true, assets: true,
      };
      if (Object.keys(board).some(function (key) { return !allowed[key]; })) return false;
      var slot = slotById[String(board.slotId || '')];
      if (!slot || seen[board.slotId] || board.sourceBlockId !== slot.sourceBlockId
        || !WHITEBOARD_BLOCK_ID_RE.test(String(board.sourceWhiteboardToken || ''))
        || !validateWhiteboardPageDetail(board.pageDetail, slot.nodeCount)
        || !Array.isArray(board.assets)) return false;
      seen[board.slotId] = true;
      totalBytes += jsonByteLength(board.pageDetail);
      if (totalBytes > WHITEBOARD_PAGE_DETAIL_TOTAL_MAX_BYTES) return false;
      var assetKeys = {};
      for (var j = 0; j < board.assets.length; j++) {
        var asset = board.assets[j] || {};
        if (Object.keys(asset).some(function (key) { return key !== 'sourceKey' && key !== 'dataUrl'; })
          || !WHITEBOARD_RESOURCE_KEY_RE.test(String(asset.sourceKey || ''))
          || assetKeys[asset.sourceKey]
          || typeof asset.dataUrl !== 'string'
          || !/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|heic|heif|tiff|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.dataUrl)) return false;
        assetKeys[asset.sourceKey] = true;
        totalAssets += 1;
        if (totalAssets > WHITEBOARD_ASSET_MAX_COUNT) return false;
      }
    }
    return Object.keys(seen).length === transfer.boardCount;
  }

  function isValidWhiteboardTransfer(value) {
    if (!value || value.schemaVersion !== 1 || !WHITEBOARD_BUNDLE_ID_RE.test(String(value.bundleId || ''))
      || !Number.isInteger(value.boardCount) || value.boardCount < 1 || value.boardCount > 100
      || !Array.isArray(value.slots) || value.slots.length !== value.boardCount) return false;
    var slotIds = {};
    var blockIds = {};
    for (var i = 0; i < value.slots.length; i++) {
      var slot = value.slots[i] || {};
      var slotId = String(slot.slotId || '');
      var sourceBlockId = String(slot.sourceBlockId || '');
      var expectedMarker = WHITEBOARD_MARKER_PREFIX + value.bundleId + ':' + slotId + ']]';
      if (!WHITEBOARD_SLOT_ID_RE.test(slotId) || !WHITEBOARD_BLOCK_ID_RE.test(sourceBlockId)
        || (slot.nodeCount !== undefined && (!Number.isInteger(slot.nodeCount)
          || slot.nodeCount < 0 || slot.nodeCount > WHITEBOARD_PAGE_DETAIL_MAX_NODES))
        || String(slot.marker || '') !== expectedMarker || slotIds[slotId] || blockIds[sourceBlockId]) return false;
      slotIds[slotId] = true;
      blockIds[sourceBlockId] = true;
    }
    return value.browserBoards === undefined || isValidBrowserWhiteboardBoards(value.browserBoards, value);
  }

  function getWhiteboardRecordText(snapshot) {
    var textMap = snapshot && snapshot.text && snapshot.text.initialAttributedTexts
      && snapshot.text.initialAttributedTexts.text;
    if (!textMap || typeof textMap !== 'object') return '';
    return Object.keys(textMap).sort(function (a, b) { return Number(a) - Number(b); })
      .map(function (key) { return String(textMap[key] || ''); }).join('');
  }

  function collectWhiteboardResourceUrls(pageDetail) {
    var resources = {};
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && value.resource && typeof value.resource === 'object'
        && Number(value.resource.type) === 1
        && WHITEBOARD_RESOURCE_KEY_RE.test(String(value.resource.key || ''))
        && typeof value.imageUrl === 'string' && /^https:\/\//.test(value.imageUrl)) {
        resources[value.resource.key] = value.imageUrl;
      }
      if (Array.isArray(value)) value.forEach(visit);
      else Object.keys(value).forEach(function (key) { visit(value[key]); });
    }
    visit(pageDetail);
    return resources;
  }

  function captureBrowserWhiteboards(transfer) {
    if (!isValidWhiteboardTransfer(transfer)) return Promise.reject(new Error('画板迁移元数据无效'));
    var editorAPI = getEditorAPI();
    var rootBlock = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    var slotByBlockId = {};
    transfer.slots.forEach(function (slot) { slotByBlockId[slot.sourceBlockId] = slot; });
    var sourceBoards = [];
    function visit(block, depth) {
      if (!block || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return;
      var recordId = getWhiteboardSourceBlockId(block);
      var slot = slotByBlockId[recordId];
      if (slot) {
        sourceBoards.push({
          slot: slot,
          viewId: block.id,
          sourceBlockId: recordId,
          sourceWhiteboardToken: String(block.record && block.record.snapshot
            && block.record.snapshot.token || ''),
        });
      }
      (block.children || []).forEach(function (child) { visit(child, depth + 1); });
    }
    visit(rootBlock, 0);
    if (sourceBoards.length !== transfer.boardCount) {
      return Promise.reject(new Error('当前页面未加载完整的源画板结构'));
    }

    var scroller = editorAPI && editorAPI.viewService && editorAPI.viewService.layoutManager
      && editorAPI.viewService.layoutManager.getScroller();
    if (!scroller) return Promise.reject(new Error('无法访问源文档滚动容器'));
    var originalScrollTop = scroller.scrollTop;
    var found = {};
    var pendingCandidates = {};
    var step = Math.max(320, Math.floor((scroller.clientHeight || 600) * 0.7));
    var maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    function captureLoadedBoards() {
      sourceBoards.forEach(function (board) {
        if (found[board.slot.slotId]) return;
        var model = editorAPI.modelService.getBlockModelByBlockId(board.viewId);
        var viewEntry = editorAPI.viewService.elements.get(board.viewId);
        var view = viewEntry && viewEntry.view;
        if (view && view.state && view.state.isRecycle && typeof view.setState === 'function') {
          view.setState({ isRecycle: false });
        }
        if (view && view.ratioAppLoaded === false) return;
        var whiteboardBlock = (model && model.whiteboardBlock) || (view && view.whiteboardBlock);
        var app = whiteboardBlock && whiteboardBlock.appProxy && whiteboardBlock.appProxy.app;
        if (!app || !app.api || typeof app.api.exportPageDetail !== 'function') return;
        var pageDetail = JSON.parse(JSON.stringify(app.api.exportPageDetail()));
        if (!validateWhiteboardPageDetail(pageDetail, board.slot.nodeCount)) {
          // 白板 app 会先挂载空 PageDetail，再异步重放 IO action。继续滚动轮询，
          // 只有节点数达到 Native Host 独立导出的契约值后才收录。
          return;
        }
        // 权限回退无法从官方接口取得 nodeCount。此时至少等待两个相同的
        // PageDetail，避免把白板 app 刚挂载的空壳误当成最终内容。
        if (board.slot.nodeCount === undefined) {
          var signature = JSON.stringify(pageDetail);
          var candidate = pendingCandidates[board.slot.slotId];
          if (!candidate || candidate.signature !== signature) {
            pendingCandidates[board.slot.slotId] = { signature: signature, stableReads: 1 };
            return;
          }
          candidate.stableReads += 1;
          if (candidate.stableReads < 2) return;
        }
        found[board.slot.slotId] = {
          slotId: board.slot.slotId,
          sourceBlockId: board.sourceBlockId,
          sourceWhiteboardToken: board.sourceWhiteboardToken,
          pageDetail: pageDetail,
          resourceUrls: collectWhiteboardResourceUrls(pageDetail),
        };
      });
    }

    function scanAt(scrollTop) {
      if (Object.keys(found).length === transfer.boardCount) return Promise.resolve();
      scroller.scrollTop = Math.min(maxScrollTop, scrollTop);
      try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
      return new Promise(function (resolve) { setTimeout(resolve, 100); })
        .then(captureLoadedBoards)
        .then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 220); });
        })
        .then(captureLoadedBoards);
    }

    var scan = Promise.resolve();
    for (var pass = 0; pass < 3; pass++) {
      for (var y = 0; y <= maxScrollTop; y += step) {
        (function (scrollTop) { scan = scan.then(function () { return scanAt(scrollTop); }); })(y);
      }
    }
    scan = scan.then(function () { return scanAt(maxScrollTop); });

    return scan.then(function () {
      if (Object.keys(found).length !== transfer.boardCount) {
        var missing = transfer.slots.filter(function (slot) { return !found[slot.slotId]; })
          .map(function (slot) { return slot.slotId; }).join('、');
        throw new Error('源文档仍有画板未完成加载：' + missing);
      }
      var uniqueUrls = {};
      Object.keys(found).forEach(function (slotId) {
        Object.keys(found[slotId].resourceUrls).forEach(function (key) {
          uniqueUrls[key] = found[slotId].resourceUrls[key];
        });
      });
      var keys = Object.keys(uniqueUrls);
      var dataUrls = {};
      var nextIndex = 0;
      function worker() {
        if (nextIndex >= keys.length) return Promise.resolve();
        var key = keys[nextIndex++];
        return fetchImageViaBackground(uniqueUrls[key]).then(function (dataUrl) {
          dataUrls[key] = dataUrl;
        }).then(worker);
      }
      var workers = [];
      for (var i = 0; i < Math.min(3, keys.length); i++) workers.push(worker());
      return Promise.all(workers).then(function () {
        var cloned = JSON.parse(JSON.stringify(transfer));
        cloned.browserBoards = cloned.slots.map(function (slot) {
          var board = found[slot.slotId];
          return {
            slotId: board.slotId,
            sourceBlockId: board.sourceBlockId,
            sourceWhiteboardToken: board.sourceWhiteboardToken,
            pageDetail: board.pageDetail,
            assets: Object.keys(board.resourceUrls).map(function (key) {
              if (!dataUrls[key]) throw new Error('画板图片资源下载不完整');
              return { sourceKey: key, dataUrl: dataUrls[key] };
            }),
          };
        });
        if (!isValidWhiteboardTransfer(cloned)) throw new Error('浏览器画板迁移包校验失败');
        return cloned;
      });
    }).finally(function () {
      scroller.scrollTop = originalScrollTop;
      try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
    });
  }

  function buildWhiteboardMarkerSnapshot(marker) {
    var text = String(marker || '');
    return {
      type: 'text',
      text: {
        initialAttributedTexts: {
          text: { 0: text },
          attribs: { 0: '+' + text.length.toString(36) },
        },
        apool: { numToAttrib: {} },
      },
    };
  }

  function getWhiteboardSourceBlockId(block) {
    var record = block && block.record;
    var snapshot = record && record.snapshot;
    return String((record && record.id)
      || (snapshot && (snapshot.block_id || snapshot.blockId)) || '');
  }

  function inspectWhiteboardSlotMatches(rootBlock, transfer) {
    var matchedSlotIds = {};
    var duplicateSlotIds = {};
    var slotByBlockId = {};
    if (!rootBlock || !isValidWhiteboardTransfer(transfer)) {
      return { matchedCount: 0, unmatchedSlots: [], duplicateSlots: [], maxMatchedDepth: 0 };
    }
    transfer.slots.forEach(function (slot) { slotByBlockId[slot.sourceBlockId] = slot; });
    var maxMatchedDepth = 0;
    function visit(block, depth) {
      if (!block || typeof block !== 'object' || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return;
      var slot = slotByBlockId[getWhiteboardSourceBlockId(block)];
      if (slot) {
        if (matchedSlotIds[slot.slotId]) duplicateSlotIds[slot.slotId] = true;
        else {
          matchedSlotIds[slot.slotId] = true;
          maxMatchedDepth = Math.max(maxMatchedDepth, depth);
        }
      }
      if (Array.isArray(block.children)) {
        block.children.forEach(function (child) { visit(child, depth + 1); });
      }
    }
    visit(rootBlock, 0);
    return {
      matchedCount: Object.keys(matchedSlotIds).length,
      unmatchedSlots: transfer.slots.filter(function (slot) { return !matchedSlotIds[slot.slotId]; }),
      duplicateSlots: transfer.slots.filter(function (slot) { return duplicateSlotIds[slot.slotId]; }),
      maxMatchedDepth: maxMatchedDepth,
    };
  }

  function waitForWhiteboardSourceTree(transfer, timeoutMs) {
    if (!isValidWhiteboardTransfer(transfer)) return Promise.reject(new Error('画板迁移元数据无效'));
    var deadline = Date.now() + Math.max(0, Math.min(10000, Number(timeoutMs || 6000)));
    return new Promise(function (resolve, reject) {
      function check() {
        var service = getStructService();
        var matches = inspectWhiteboardSlotMatches(service && service.rootBlock, transfer);
        if (matches.matchedCount === transfer.boardCount && !matches.duplicateSlots.length) {
          resolve(matches);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('官方 API 返回的画板槽位未在当前文档结构中完整加载，请刷新源文档后重试'));
          return;
        }
        setTimeout(check, 120);
      }
      check();
    });
  }

  function cloneBlockTreeWithWhiteboardMarkers(rootBlock, transfer) {
    if (!rootBlock || !isValidWhiteboardTransfer(transfer)) {
      return {
        rootBlock: rootBlock || null,
        matchedCount: 0,
        unmatchedSlots: [],
        duplicateSlots: [],
        maxMatchedDepth: 0,
      };
    }
    var slotByBlockId = {};
    var matchedSlotIds = {};
    var duplicateSlotIds = {};
    var maxMatchedDepth = 0;
    transfer.slots.forEach(function (slot) { slotByBlockId[slot.sourceBlockId] = slot; });

    function visit(block, depth) {
      if (!block || typeof block !== 'object' || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return null;
      var sourceRecord = block.record && typeof block.record === 'object' ? block.record : null;
      var sourceSnapshot = sourceRecord && sourceRecord.snapshot;
      var record = null;
      if (sourceRecord) {
        record = {
          id: String(sourceRecord.id || ''),
          snapshot: docxRecord.sanitizeSnapshotForRecord(sourceSnapshot),
        };
      }
      // 官方 API 的 sourceBlockId 是画板身份真源；Struct Service 的 type 可能局部缺失或陈旧。
      if (record) {
        var sourceBlockId = getWhiteboardSourceBlockId(block);
        var slot = slotByBlockId[sourceBlockId];
        if (slot) {
          if (matchedSlotIds[slot.slotId]) {
            duplicateSlotIds[slot.slotId] = true;
          } else {
            matchedSlotIds[slot.slotId] = true;
            maxMatchedDepth = Math.max(maxMatchedDepth, depth);
            record.snapshot = buildWhiteboardMarkerSnapshot(slot.marker);
          }
        }
      }
      return {
        record: record,
        children: Array.isArray(block.children) ? block.children.map(function (child) {
          return visit(child, depth + 1);
        }).filter(Boolean) : [],
      };
    }

    var clonedRoot = visit(rootBlock, 0);
    var unmatchedSlots = transfer.slots.filter(function (slot) { return !matchedSlotIds[slot.slotId]; });
    var duplicateSlots = transfer.slots.filter(function (slot) { return duplicateSlotIds[slot.slotId]; });
    return {
      rootBlock: clonedRoot,
      matchedCount: transfer.slots.length - unmatchedSlots.length,
      unmatchedSlots: unmatchedSlots,
      duplicateSlots: duplicateSlots,
      maxMatchedDepth: maxMatchedDepth,
    };
  }

  function countLiteralOccurrences(value, needle) {
    var source = String(value || '');
    var target = String(needle || '');
    if (!target) return 0;
    var count = 0;
    var offset = 0;
    while (offset <= source.length - target.length) {
      var index = source.indexOf(target, offset);
      if (index < 0) break;
      count += 1;
      offset = index + target.length;
    }
    return count;
  }

  function assertWhiteboardMarkersInExtractedContent(content, transfer) {
    if (!isValidWhiteboardTransfer(transfer)) throw new Error('画板迁移元数据无效');
    var fields = [
      { name: 'HTML', value: content && content.html },
      { name: '文本', value: content && content.text },
      { name: 'docxRecord', value: content && content.docxRecord },
    ];
    fields.forEach(function (field) {
      var total = countLiteralOccurrences(field.value, WHITEBOARD_MARKER_PREFIX);
      if (total !== transfer.boardCount) {
        throw new Error(field.name + ' 中的画板占位符数量不完整');
      }
      transfer.slots.forEach(function (slot) {
        if (countLiteralOccurrences(field.value, slot.marker) !== 1) {
          throw new Error(field.name + ' 中的画板占位符缺失或重复');
        }
      });
    });
    return true;
  }

  function requestWhiteboardNative(op, fields, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var requestId = 'whiteboard-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, new Error('画板迁移 Host 响应超时'));
      }, Math.max(1000, Number(timeoutMs || 120000)));

      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener(WHITEBOARD_NATIVE_RESULT_EVENT, onResult, true);
      }
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        if (!detail.ok) {
          finish(reject, new Error(String(detail.error || '画板迁移 Host 请求失败')));
          return;
        }
        finish(resolve, detail.data || {});
      }

      document.addEventListener(WHITEBOARD_NATIVE_RESULT_EVENT, onResult, true);
      try {
        document.dispatchEvent(new CustomEvent(WHITEBOARD_NATIVE_EVENT, {
          detail: Object.assign({ requestId: requestId, op: String(op || '') }, fields || {}),
        }));
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function createBrowserWhiteboardBundleId() {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      throw new Error('当前页面无法生成安全的画板迁移标识');
    }
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }

  function buildBrowserWhiteboardTransfer() {
    var editorAPI = getEditorAPI();
    var rootBlock = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    if (!rootBlock) throw new Error('当前页面未加载完整的源画板结构');
    var boards = [];
    var seenBlockIds = {};
    function visit(block, depth) {
      if (!block || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return;
      var snapshot = block.record && block.record.snapshot;
      if (snapshot && snapshot.type === 'whiteboard') {
        var sourceBlockId = getWhiteboardSourceBlockId(block);
        var token = String(snapshot.token || '');
        if (!WHITEBOARD_BLOCK_ID_RE.test(sourceBlockId)
          || !WHITEBOARD_BLOCK_ID_RE.test(token) || seenBlockIds[sourceBlockId]) {
          throw new Error('当前页面的源画板身份无效或重复');
        }
        seenBlockIds[sourceBlockId] = true;
        boards.push({ sourceBlockId: sourceBlockId });
      }
      (block.children || []).forEach(function (child) { visit(child, depth + 1); });
    }
    visit(rootBlock, 0);
    if (!boards.length) return null;
    if (boards.length > 100) throw new Error('当前页面画板数量超过迁移上限');
    var bundleId = createBrowserWhiteboardBundleId();
    var transfer = {
      schemaVersion: 1,
      bundleId: bundleId,
      boardCount: boards.length,
      slots: boards.map(function (board, index) {
        var slotId = 'board-' + String(index + 1).padStart(4, '0');
        return {
          slotId: slotId,
          sourceBlockId: board.sourceBlockId,
          marker: WHITEBOARD_MARKER_PREFIX + bundleId + ':' + slotId + ']]',
        };
      }),
    };
    if (!isValidWhiteboardTransfer(transfer)) throw new Error('浏览器画板迁移元数据无效');
    return transfer;
  }

  function requestBrowserWhiteboardExportAfterAccessDenied(nativeError) {
    return waitForDocumentSnapshotReady(5000).then(function (ready) {
      if (!ready) throw nativeError;
      return waitForStableBrowserDocumentSummary(5000);
    }).then(function (sourceSummary) {
      if (!sourceSummary || isEmptyDocumentSummary(sourceSummary)) throw nativeError;
      var transfer = buildBrowserWhiteboardTransfer();
      var browserBoardCount = transfer ? transfer.boardCount : 0;
      if (browserBoardCount !== sourceSummary.whiteboardCount) {
        throw new Error('当前页面未加载完整的源画板结构');
      }
      if (!transfer) return { whiteboardTransfer: null, sourceSummary: sourceSummary };
      return captureBrowserWhiteboards(transfer).then(function (browserTransfer) {
        return { whiteboardTransfer: browserTransfer, sourceSummary: sourceSummary };
      });
    });
  }

  function requestWhiteboardExport() {
    return requestWhiteboardNative('export', { sourceUrl: location.href }, 180000).then(function (data) {
      var transfer = data && data.whiteboardTransfer;
      var boardCount = data && data.boardCount;
      var sourceSummary = validateOfficialDocumentSummary(data && data.sourceSummary);
      if (!Number.isInteger(boardCount) || boardCount < 0 || boardCount > 100) {
        throw new Error('画板迁移 Host 未返回有效的画板数量');
      }
      if (boardCount === 0) {
        if (transfer !== null && transfer !== undefined) {
          throw new Error('画板迁移 Host 返回了不一致的空画板结果');
        }
        if (sourceSummary.whiteboardCount !== 0) {
          throw new Error('画板迁移 Host 返回的文档统计与画板数量不一致');
        }
        return { whiteboardTransfer: null, sourceSummary: sourceSummary };
      }
      if (!transfer || !isValidWhiteboardTransfer(transfer) || transfer.boardCount !== boardCount) {
        throw new Error('画板迁移 Host 未返回有效的画板槽位');
      }
      if (sourceSummary.whiteboardCount !== boardCount) {
        throw new Error('画板迁移 Host 返回的文档统计与画板数量不一致');
      }
      return captureBrowserWhiteboards(transfer).then(function (browserTransfer) {
        return { whiteboardTransfer: browserTransfer, sourceSummary: sourceSummary };
      });
    }).catch(function (error) {
      if (!isNativeDocumentAccessDenied(error)) throw error;
      return requestBrowserWhiteboardExportAfterAccessDenied(error);
    });
  }

  function validateOfficialDocumentSummary(data) {
    var fields = ['blockCount', 'equationCount', 'imageCount', 'whiteboardCount'];
    var summary = {};
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var value = data && data[field];
      if (!Number.isInteger(value) || value < 0 || value > 1000000) {
        throw new Error('画板迁移 Host 未返回有效的文档统计');
      }
      summary[field] = value;
    }
    return summary;
  }

  function isEmptyDocumentSummary(summary) {
    return !!summary
      && summary.blockCount === 0
      && summary.equationCount === 0
      && summary.imageCount === 0
      && summary.whiteboardCount === 0;
  }

  function isNativeDocumentAccessDenied(error) {
    var message = String(error && error.message || error || '');
    return /no permission|permission denied|forbidden|lacks?\s+(?:view|edit)\s+access|无权|没有权限|权限不足/i.test(message);
  }

  function isDocumentSnapshotReady() {
    if (typeof getEditorReadyState !== 'function') return true;
    var state = getEditorReadyState();
    return !!state
      && state.readyState === 'complete'
      && state.hasContentRoot === true
      && state.hasStructService === true
      && state.hasRootBlock === true
      && state.hasContentLoaded === true;
  }

  function buildBrowserDocumentSummary() {
    if (typeof captureValidationSnapshot !== 'function') return null;
    var snapshot = captureValidationSnapshot();
    if (!snapshot) return null;
    var componentCounts = snapshot.semanticSnapshot && snapshot.semanticSnapshot.componentCounts || {};
    var renderedWhiteboards = Math.max(
      Number(snapshot.whiteboardCount || 0),
      Number(componentCounts.whiteboard || 0)
    );
    // 图片只能来自结构化正文记录；DOM 语义扫描会把头像、图标和模板缩略图混入统计。
    var renderedImages = Number(snapshot.imageCount || 0);
    var renderedEquations = Math.max(
      Number(snapshot.equationCount || 0),
      Number(componentCounts.equation || 0)
    );

    return validateOfficialDocumentSummary({
      // blockCount 沿用 renderer 的正文口径；语义快照只补齐各自独立统计的富媒体，
      // 不把画板再叠加进正文块数，避免重复计数。
      blockCount: Number(snapshot.blockCount || 0),
      equationCount: renderedEquations,
      imageCount: renderedImages,
      whiteboardCount: renderedWhiteboards,
    });
  }

  function waitForDocumentSnapshotReady(timeoutMs) {
    var startedAt = Date.now();
    var timeout = Math.max(0, Number(timeoutMs || 0));
    return new Promise(function (resolve) {
      function check() {
        if (isDocumentSnapshotReady()) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          resolve(false);
          return;
        }
        setTimeout(check, 120);
      }
      check();
    });
  }

  function waitForStableBrowserDocumentSummary(timeoutMs) {
    var startedAt = Date.now();
    var timeout = Math.max(600, Number(timeoutMs || 0));
    var lastSignature = '';
    var stableReads = 0;
    var lastSummary = null;
    return new Promise(function (resolve) {
      function check() {
        if (isDocumentSnapshotReady()
          && !(typeof isVisibleDocumentBodyEmpty === 'function' && isVisibleDocumentBodyEmpty())) {
          var summary = buildBrowserDocumentSummary();
          var signature = summary ? JSON.stringify(summary) : '';
          if (signature && signature === lastSignature) stableReads += 1;
          else stableReads = signature ? 1 : 0;
          lastSignature = signature;
          lastSummary = summary || lastSummary;
          if (stableReads >= 3 && Date.now() - startedAt >= 600) {
            resolve(lastSummary);
            return;
          }
        }
        if (Date.now() - startedAt >= timeout) {
          resolve(lastSummary);
          return;
        }
        setTimeout(check, 240);
      }
      check();
    });
  }

  function requestDocumentInspect() {
    // popup 可能比飞书正文 hydration 更早打开；此时“未知”不能被发布为四个 0。
    return waitForDocumentSnapshotReady(5000).then(function (ready) {
      if (!ready) throw new Error('页面正文仍在加载，请稍后重试');
      return requestWhiteboardNative('inspect', { sourceUrl: location.href }, 90000);
    }).then(function (data) {
      var officialSummary = validateOfficialDocumentSummary(data);
      if (!isEmptyDocumentSummary(officialSummary)) return officialSummary;

      // 个人租户无法由 Native Host 使用企业 profile 读取文档 XML，接口会返回假空文档。
      // 只有页面已明确渲染出非空正文时才启用稳定浏览器快照；真正空文档仍保留官方 0。
      if (typeof isVisibleDocumentBodyEmpty === 'function' && isVisibleDocumentBodyEmpty()) {
        return officialSummary;
      }
      return waitForStableBrowserDocumentSummary(5000).then(function (browserSummary) {
        return browserSummary && !isEmptyDocumentSummary(browserSummary)
          ? browserSummary
          : officialSummary;
      });
    }).catch(function (error) {
      // 页面已拥有完整 Struct Service 时，Native Host 的企业身份仍可能无权读取
      // 用户当前可见的跨租户/只读文档。只对明确的权限错误回退，避免把 Host
      // 不可用、协议异常等真实故障静默降级成可能不完整的浏览器统计。
      if (!isNativeDocumentAccessDenied(error)
        || (typeof isVisibleDocumentBodyEmpty === 'function' && isVisibleDocumentBodyEmpty())) {
        throw error;
      }
      return waitForStableBrowserDocumentSummary(5000).then(function (browserSummary) {
        if (browserSummary && !isEmptyDocumentSummary(browserSummary)) return browserSummary;
        throw error;
      });
    });
  }

  function requestWhiteboardPreflight(transfer) {
    if (!isValidWhiteboardTransfer(transfer)) return Promise.reject(new Error('画板迁移元数据无效'));
    return requestWhiteboardNative('preflight', {
      bundleId: transfer.bundleId,
      targetUrl: location.href,
    }, 90000);
  }

  function requestWhiteboardApply(transfer) {
    if (!isValidWhiteboardTransfer(transfer)) return Promise.reject(new Error('画板迁移元数据无效'));
    return requestWhiteboardNative('apply', {
      bundleId: transfer.bundleId,
      targetUrl: location.href,
    }, 300000);
  }

  function replaceWhiteboardResourceKeys(pageDetail, uploadedAssets) {
    var clone = JSON.parse(JSON.stringify(pageDetail));
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && value.resource && typeof value.resource === 'object') {
        var uploaded = uploadedAssets[value.resource.key];
        if (Number(value.resource.type) === 1 && uploaded) {
          value.resource.key = uploaded.key;
          if (typeof value.imageUrl === 'string') value.imageUrl = uploaded.url;
        }
      }
      if (Array.isArray(value)) value.forEach(visit);
      else Object.keys(value).forEach(function (key) { visit(value[key]); });
    }
    visit(clone);
    return clone;
  }

  function dataUrlToWhiteboardFile(dataUrl, name) {
    var match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
    if (!match) throw new Error('画板图片 data URL 无效');
    var binary = atob(match[2]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var extension = String(match[1]).split('/')[1] || 'png';
    return new File([bytes], String(name || 'whiteboard-image') + '.' + extension, { type: match[1] });
  }

  function findWhiteboardMarkerBlocks(editorAPI, transfer) {
    var slotByMarker = {};
    transfer.slots.forEach(function (slot) { slotByMarker[slot.marker] = slot; });
    var found = {};
    function visit(block, depth) {
      if (!block || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return;
      var snapshot = block.record && block.record.snapshot;
      var marker = getWhiteboardRecordText(snapshot).trim();
      var slot = slotByMarker[marker];
      if (slot) {
        if (found[slot.slotId]) throw new Error('目标文档包含重复的画板占位符');
        found[slot.slotId] = { slot: slot, block: block };
      }
      (block.children || []).forEach(function (child) { visit(child, depth + 1); });
    }
    visit(editorAPI.structService && editorAPI.structService.rootBlock, 0);
    return found;
  }

  function requestBrowserWhiteboardPreflight(transfer) {
    if (!isValidWhiteboardTransfer(transfer) || !Array.isArray(transfer.browserBoards)) {
      return Promise.reject(new Error('浏览器画板迁移包无效'));
    }
    var editorAPI = getEditorAPI();
    if (!editorAPI || !editorAPI.structService) {
      return Promise.reject(new Error('当前页面未加载可编辑文档 API'));
    }
    var markerCount = Object.keys(findWhiteboardMarkerBlocks(editorAPI, transfer)).length;
    if (markerCount !== 0 && markerCount !== transfer.boardCount) {
      return Promise.reject(new Error('目标文档只包含部分画板占位符，已停止以避免重复写入'));
    }
    return Promise.resolve({
      needsBodyPaste: markerCount === 0,
      alreadyComplete: false,
      browserFallback: true,
    });
  }

  function ensureWhiteboardBlockModule(editorAPI) {
    var moduleService = editorAPI && editorAPI.moduleService;
    if (!moduleService || typeof moduleService.loadBlockModule !== 'function') {
      return Promise.reject(new Error('当前飞书版本未提供白板模块加载服务'));
    }
    return Promise.resolve(moduleService.loadBlockModule('whiteboard', {
      immediately: true,
      autoRetry: true,
    })).then(function () {
      var module = window['whiteboard/'] && window['whiteboard/'].WhiteboardBlockModule;
      if (!module || !module.service || typeof module.service.create !== 'function') {
        throw new Error('飞书白板模块加载后仍缺少创建服务');
      }
      return module;
    });
  }

  function createTargetWhiteboardFromMarker(editorAPI, markerRecord, board) {
    var whiteboardModule = window['whiteboard/'] && window['whiteboard/'].WhiteboardBlockModule;
    var service = whiteboardModule && whiteboardModule.service;
    var rootRecord = editorAPI.structService && editorAPI.structService.rootBlock
      && editorAPI.structService.rootBlock.record;
    if (!service || typeof service.create !== 'function' || !rootRecord || !rootRecord.id) {
      return Promise.reject(new Error('当前飞书版本未提供白板创建服务'));
    }
    var recordId = String(markerRecord.block.record.id || '');
    var oldSnapshot = markerRecord.block.record.snapshot || {};
    return Promise.resolve(service.create({
      docToken: String(rootRecord.id),
      blockToken: recordId,
      baseTokenType: 22,
    })).then(function (response) {
      var token = String(response && response.data && response.data.blockToken || '');
      if (!WHITEBOARD_BLOCK_ID_RE.test(token)) throw new Error(board.slotId + ' 创建白板失败');
      editorAPI.dataService.applyTransaction('feishu-helper-whiteboard-replace', function (tx) {
        tx.replace(recordId, [], {
          type: 'whiteboard',
          comments: oldSnapshot.comments || [],
          revisions: oldSnapshot.revisions || [],
          locked: !!oldSnapshot.locked,
          width: 0,
          height: 0,
          parent_id: oldSnapshot.parent_id,
          hidden: !!oldSnapshot.hidden,
          author: oldSnapshot.author,
          token: token,
          caption: {
            text: {
              apool: { numToAttrib: null, nextNum: 0 },
              initialAttributedTexts: { text: null, attribs: null },
            },
          },
        });
      });
      return {
        slotId: board.slotId,
        viewId: markerRecord.block.id,
        recordId: recordId,
        targetWhiteboardToken: token,
        board: board,
      };
    });
  }

  function importIntoTargetWhiteboard(app, target) {
    var assets = target.board.assets || [];
    var uploaded = {};
    var upload = Promise.resolve();
    assets.forEach(function (asset, index) {
      upload = upload.then(function () {
        var file = dataUrlToWhiteboardFile(asset.dataUrl, target.slotId + '-' + (index + 1));
        return app.imageUploadPlugin.uploadImage(file).then(function (result) {
          if (!result || !WHITEBOARD_RESOURCE_KEY_RE.test(String(result.key || ''))
            || typeof result.url !== 'string' || !/^https:\/\//.test(result.url)) {
            throw new Error(target.slotId + ' 的画板图片上传失败');
          }
          uploaded[asset.sourceKey] = { key: String(result.key), url: result.url };
        });
      });
    });
    return upload.then(function () {
      var pageDetail = replaceWhiteboardResourceKeys(target.board.pageDetail, uploaded);
      app.commandManager.execute('InsertPage', {
        page: pageDetail,
        // PageDetail 已完成目标租户资源重键；后续命令只能绑定刚创建的目标画板，
        // 不能再携带源画板 token，否则白板运行时会跨租户读取资源并触发 ACL 错误。
        token: target.targetWhiteboardToken,
        updateResource: false,
      });
      var expected = target.board.pageDetail;
      var deadline = Date.now() + 20000;
      return new Promise(function (resolve, reject) {
        function check() {
          try {
            var actual = app.api.exportPageDetail();
            var expectedState = { count: 0 };
            var countState = { count: 0 };
            countWhiteboardPageDetailNodes(expected.nodes, 0, expectedState);
            countWhiteboardPageDetailNodes(actual.nodes, 0, countState);
            if (countState.count === expectedState.count) {
              resolve({ slotId: target.slotId, nodeCount: countState.count });
              return;
            }
          } catch (error) {}
          if (Date.now() >= deadline) {
            reject(new Error(target.slotId + ' 的画板节点未完整写入'));
            return;
          }
          setTimeout(check, 150);
        }
        check();
      });
    });
  }

  function applyBrowserWhiteboards(transfer) {
    if (!isValidWhiteboardTransfer(transfer) || !Array.isArray(transfer.browserBoards)) {
      return Promise.reject(new Error('浏览器画板迁移包无效'));
    }
    var editorAPI = getEditorAPI();
    if (!editorAPI || !editorAPI.dataService || !editorAPI.viewService) {
      return Promise.reject(new Error('当前页面未加载可编辑文档 API'));
    }
    return ensureWhiteboardBlockModule(editorAPI).then(function () {
      return applyBrowserWhiteboardsReady(transfer, editorAPI);
    });
  }

  function applyBrowserWhiteboardsReady(transfer, editorAPI) {
    var markers = findWhiteboardMarkerBlocks(editorAPI, transfer);
    if (Object.keys(markers).length !== transfer.boardCount) {
      return Promise.reject(new Error('目标文档画板占位符数量不完整'));
    }
    var boardBySlot = {};
    transfer.browserBoards.forEach(function (board) { boardBySlot[board.slotId] = board; });
    var targets = [];
    var creation = Promise.resolve();
    transfer.slots.forEach(function (slot) {
      creation = creation.then(function () {
        return createTargetWhiteboardFromMarker(editorAPI, markers[slot.slotId], boardBySlot[slot.slotId])
          .then(function (target) { targets.push(target); });
      });
    });
    return creation.then(function () {
      var scroller = editorAPI.viewService.layoutManager.getScroller();
      if (!scroller) throw new Error('无法访问目标文档滚动容器');
      var originalScrollTop = scroller.scrollTop;
      var appBySlot = {};
      var maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      var step = Math.max(320, Math.floor((scroller.clientHeight || 600) * 0.7));
      var scan = Promise.resolve();
      function captureApps() {
        targets.forEach(function (target) {
          if (appBySlot[target.slotId]) return;
          var model = editorAPI.modelService.getBlockModelByBlockId(target.viewId);
          var viewEntry = editorAPI.viewService.elements.get(target.viewId);
          var view = viewEntry && viewEntry.view;
          if (view && view.state && view.state.isRecycle && typeof view.setState === 'function') {
            view.setState({ isRecycle: false });
          }
          if (view && view.ratioAppLoaded === false) return;
          var wb = (model && model.whiteboardBlock) || (view && view.whiteboardBlock);
          var app = wb && wb.appProxy && wb.appProxy.app;
          if (app) appBySlot[target.slotId] = app;
        });
      }
      function scanAt(scrollTop) {
        if (Object.keys(appBySlot).length === transfer.boardCount) return Promise.resolve();
        scroller.scrollTop = Math.min(maxScrollTop, scrollTop);
        try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
        return new Promise(function (resolve) { setTimeout(resolve, 110); })
          .then(captureApps)
          .then(function () {
            return new Promise(function (resolve) { setTimeout(resolve, 220); });
          })
          .then(captureApps);
      }
      for (var pass = 0; pass < 2; pass++) {
        for (var y = 0; y <= maxScrollTop; y += step) {
          (function (scrollTop) { scan = scan.then(function () { return scanAt(scrollTop); }); })(y);
        }
      }
      return scan.then(function () { return scanAt(maxScrollTop); }).then(function () {
        if (Object.keys(appBySlot).length !== transfer.boardCount) {
          throw new Error('目标画板未全部完成加载');
        }
        var imported = [];
        var chain = Promise.resolve();
        targets.forEach(function (target) {
          chain = chain.then(function () {
            emitUiProgress({
              phase: 'whiteboard-apply', done: imported.length,
              total: targets.length, label: '重建画板',
            });
            return importIntoTargetWhiteboard(appBySlot[target.slotId], target).then(function (result) {
              imported.push(result);
            });
          });
        });
        return chain.then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 1800); }).then(function () {
            return { status: 'complete', boardCount: imported.length, boards: imported, browserFallback: true };
          });
        });
      }).finally(function () {
        scroller.scrollTop = originalScrollTop;
        try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
      });
    });
  }

  function requestWhiteboardDiscard(transfer, action) {
    if (!isValidWhiteboardTransfer(transfer)) return Promise.resolve(false);
    return requestWhiteboardNative('discard', {
      bundleId: transfer.bundleId,
      action: String(action || 'extract'),
    }, 30000).then(function () { return true; }).catch(function () { return false; });
  }
