  // ── Image fetching & base64 conversion ─────────────────────────────────────

  function fetchImageAsBase64(url) {
    // 批量图片也统一走受控 content-script → service-worker 桥，避免页面 CORS、
    // 复制保护以及已移除的全局 fetch hook 影响提取。
    return fetchImageViaBackground(url)
      .catch(function () { return null; });
  }

  // docxRecord 图片记录是完整任务清单；HTML 只提供当前已渲染图片的首选 URL。
  // 深层表格或折叠区域里未出现在 HTML 片段中的图片也进入同一转换队列，
  // 因此进度总数与结构化图片统计始终使用同一口径。
  function convertImagesToBase64(html, imageEntries, preloadedTokenToBase64) {
    var sourceHtml = String(html || '');
    var tokenToBase64 = Object.create(null);
    var groupsByToken = Object.create(null);
    var workItems = [];
    (Array.isArray(imageEntries) ? imageEntries : []).forEach(function (entry) {
      var token = String(entry && entry.image ? entry.image.token || '' : entry && entry.token || '');
      if (!token) return;
      var group = groupsByToken[token];
      if (!group) {
        group = { token: token, count: 0, urls: new Set() };
        groupsByToken[token] = group;
        workItems.push(group);
      }
      group.count += 1;
    });
    if (!workItems.length) return Promise.resolve({ html: sourceHtml, tokenToBase64: {} });

    // URL 只给已有结构化记录提供下载地址，不能反向扩充图片清单。
    // 保存属性位置，下载结束后一次拼接 HTML，避免每张图重扫整篇文档。
    var htmlImages = [];
    var srcRegex = /(<img\b[^>]*?\s)src\s*=\s*(["'])(.*?)\2/gi;
    var match;
    while ((match = srcRegex.exec(sourceHtml)) !== null) {
      var url;
      try { url = new URL(match[3].replace(/&amp;/gi, '&'), location.origin); }
      catch (error) { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      var pathMatch = url.pathname.match(/\/space\/api\/box\/stream\/download\/(?:preview|v2\/cover)\/([A-Za-z0-9_.~-]+)/);
      var token = pathMatch ? pathMatch[1] : '';
      if (/\/space\/api\/box\/stream\/download\/all\/?$/.test(url.pathname)) {
        token = url.searchParams.get('token') || '';
      } else if (!token && /(^|\.)feishucdn\.com$/.test(url.hostname)) {
        pathMatch = url.pathname.match(/^\/static-resource\/v1\/([A-Za-z0-9_.~-]+)/);
        token = pathMatch ? pathMatch[1] : '';
      }
      var group = groupsByToken[token];
      if (!group) continue;
      group.urls.add(url.href);
      htmlImages.push({ token: token, start: match.index + match[1].length,
        end: match.index + match[0].length });
    }

    workItems.forEach(function (group) {
      group.urls.add(location.origin + '/space/api/box/stream/download/all/?token=' + encodeURIComponent(group.token));
      group.urls.add(location.origin + '/space/api/box/stream/download/preview/' + encodeURIComponent(group.token) + '/?preview_type=16');
      group.urls = Array.from(group.urls);
      var preloaded = preloadedTokenToBase64 && preloadedTokenToBase64[group.token];
      if (/^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(String(preloaded || ''))) {
        tokenToBase64[group.token] = preloaded;
      }
    });

    var done = 0;
    var total = workItems.reduce(function (sum, item) { return sum + item.count; }, 0);
    var embeddedChartTotal = workItems.reduce(function (sum, item) {
      return sum + (tokenToBase64[item.token] ? item.count : 0);
    }, 0);
    var imageTotal = Math.max(0, total - embeddedChartTotal);
    var progressLabel = embeddedChartTotal > 0
      ? '转换资源（' + imageTotal + ' 图片 + ' + embeddedChartTotal + ' 图表）'
      : '转换图片';
    showToast('📷 转换图片中 0/' + total);
    emitUiProgress({ phase: 'convert', done: 0, total: total, label: progressLabel });

    function convertOne(group) {
      function finish(base64) {
        done += group.count;
        showToast('📷 转换图片中 ' + done + '/' + total);
        emitUiProgress({ phase: 'convert', done: done, total: total, label: progressLabel });
        if (base64) tokenToBase64[group.token] = base64;
      }
      function tryFetch(index) {
        if (index >= group.urls.length) return Promise.resolve(null);
        return fetchImageAsBase64(group.urls[index]).then(function (base64) {
          return base64 || tryFetch(index + 1);
        });
      }
      if (tokenToBase64[group.token]) {
        finish(tokenToBase64[group.token]);
        return Promise.resolve();
      }
      return tryFetch(0).then(finish);
    }

    return mapWithConcurrency(workItems, 5, convertOne).then(function () {
      var parts = [];
      var position = 0;
      htmlImages.forEach(function (item) {
        if (!tokenToBase64[item.token]) return;
        parts.push(sourceHtml.slice(position, item.start), 'src="' + IMAGE_PLACEHOLDER_SRC + '"');
        position = item.end;
      });
      parts.push(sourceHtml.slice(position));
      return { html: parts.join(''), tokenToBase64: tokenToBase64 };
    });
  }

  function collectDocumentImageRecords(rootBlock) {
    var records = [];
    var pending = [rootBlock];
    var visited = new Set();
    while (pending.length) {
      var block = pending.pop();
      if (!block || typeof block !== 'object' || visited.has(block)) continue;
      visited.add(block);
      var record = block.record;
      var snapshot = record && record.snapshot;
      if (record && snapshot && snapshot.type === 'image' && snapshot.image) records.push(record);
      var children = block.children || [];
      for (var i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
    return records;
  }

  function buildImagePasteDescriptors(images) {
    var markerRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return (images || []).map(function (image, index) {
      var sourceToken = String((image && image.token) || '');
      if (!sourceToken || !(image && image.base64)) throw new Error('第 ' + (index + 1) + ' 张图片数据不完整');
      var dataUrl = String((image && image.base64) || '');
      var mimeMatch = /^data:(image\/[A-Za-z0-9.+-]+);base64,/.exec(dataUrl);
      return {
        marker: '[[FEISHU_HELPER_IMAGE:' + markerRunId + ':'
          + String(index + 1).padStart(4, '0') + ']]',
        sourceToken: sourceToken,
        base64: dataUrl,
        width: Number((image && image.width) || 0),
        height: Number((image && image.height) || 0),
        mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
        size: Math.max(0, Math.floor((dataUrl.split(',')[1] || '').length * 3 / 4)),
      };
    });
  }

  function buildImageMarkerSnapshot(sourceSnapshot, marker) {
    var source = sourceSnapshot || {};
    var text = String(marker || '');
    return {
      type: 'text', parent_id: source.parent_id,
      comments: source.comments || [], revisions: source.revisions || [],
      locked: !!source.locked, hidden: !!source.hidden, author: source.author,
      children: [], align: source.align || '', folded: false,
      text: {
        apool: { nextNum: 0, numToAttrib: null },
        initialAttributedTexts: {
          text: { 0: text }, attribs: { 0: '+' + text.length.toString(36) },
        },
      },
    };
  }

  function markerizeImagesInDocxRecord(docxRecordObj, descriptors) {
    var clone = JSON.parse(JSON.stringify(docxRecordObj || {}));
    var records = clone.recordMap || {};
    var index = 0;
    Object.keys(records).forEach(function (recordId) {
      var record = records[recordId];
      var snapshot = record && record.snapshot;
      if (!snapshot || snapshot.type !== 'image' || !snapshot.image) return;
      var descriptor = descriptors[index++];
      if (!descriptor) throw new Error('图片槽位数量与图片数据不一致');
      record.snapshot = buildImageMarkerSnapshot(snapshot, descriptor.marker);
    });
    if (index !== descriptors.length) throw new Error('图片槽位数量与图片数据不一致');
    return clone;
  }

  function markerizeImagesInClipboardHtml(html, descriptors) {
    var source = String(html || '');
    var expected = Array.isArray(descriptors) ? descriptors : [];
    if (!expected.length) return source;
    var remainingDescriptors = expected.slice();
    expected.forEach(function (descriptor) {
      var token = String((descriptor && descriptor.sourceToken) || '');
      if (!token) throw new Error('HTML 图片槽位缺少源 token');
    });
    var imageBlockCount = 0;
    var marked = source.replace(
      /<figure\b(?=[^>]*\bdata-block-type=(['"])image\1)[^>]*>[\s\S]*?<\/figure>/gi,
      function (imageBlockHtml) {
        imageBlockCount += 1;
        var matchingDescriptors = remainingDescriptors.filter(function (descriptor) {
          return imageBlockHtml.indexOf(String(descriptor.sourceToken || '')) !== -1;
        });
        // 飞书对重复图片可能给某个 HTML figure 写入别名 token，甚至完全省略
        // token；结构化 record 与 clipboard HTML 仍保持文档顺序。优先用
        // token 精确匹配，无法匹配时消费下一个剩余槽位，避免因别名中断整页。
        var descriptor = matchingDescriptors[0] || remainingDescriptors[0];
        if (!descriptor) throw new Error('HTML 图片槽位数量超过上传结果');
        remainingDescriptors.splice(remainingDescriptors.indexOf(descriptor), 1);
        return '<p>' + descriptor.marker + '</p>';
      }
    );
    if (imageBlockCount > expected.length) throw new Error('HTML 图片槽位数量超过上传结果');
    return marked;
  }

  function getStructuredRecordText(snapshot) {
    var textMap = snapshot && snapshot.text && snapshot.text.initialAttributedTexts
      && snapshot.text.initialAttributedTexts.text;
    if (!textMap || typeof textMap !== 'object') return '';
    return Object.keys(textMap).sort(function (a, b) { return Number(a) - Number(b); })
      .map(function (key) { return String(textMap[key] || ''); }).join('');
  }

  function findImageMarkerBlocks(rootBlock, descriptors) {
    var byMarker = {};
    (descriptors || []).forEach(function (descriptor) { byMarker[descriptor.marker] = descriptor; });
    var found = {};
    function visit(block) {
      if (!block || typeof block !== 'object') return;
      var marker = getStructuredRecordText(block.record && block.record.snapshot).trim();
      if (byMarker[marker]) {
        if (found[marker]) throw new Error('目标文档包含重复图片槽位');
        found[marker] = block;
      }
      (block.children || []).forEach(visit);
    }
    visit(rootBlock);
    return found;
  }

  function selectImageMarkerBlock(editorAPI, block, marker) {
    var layout = editorAPI.viewService && editorAPI.viewService.layoutManager;
    if (!layout) return Promise.reject(new Error('当前页面缺少文档布局服务'));
    return Promise.resolve(layout.scrollToSelection(block.id)).catch(function () {})
      .then(function () {
        try { layout.renderNodeByIdSync(block.id); } catch (error) {}
        var deadline = Date.now() + 4000;
        return new Promise(function (resolve, reject) {
          function check() {
            var entry = editorAPI.viewService.elements.get(block.id);
            var host = entry && entry.hostElementRef && entry.hostElementRef.current;
            var nodes = host ? host.querySelectorAll('[data-string="true"]') : [];
            var markerNode = null;
            for (var i = 0; i < nodes.length; i++) {
              if (String(nodes[i].textContent || '').trim() === marker) { markerNode = nodes[i]; break; }
            }
            var markerRange = markerNode
              ? (function () {
                  var exactRange = document.createRange();
                  exactRange.selectNodeContents(markerNode);
                  return exactRange;
                })()
              : buildTextRangeForMarker(host, marker);
            if (markerRange) {
              var zone = markerNode && markerNode.closest('[contenteditable]') || host;
              try { if (zone && typeof zone.focus === 'function') zone.focus({ preventScroll: true }); } catch (error) {}
              var selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(markerRange);
              if (String(selection.toString() || '').trim() !== marker) {
                reject(new Error('图片槽位文本未被完整选中'));
                return;
              }
              resolve();
              return;
            }
            if (Date.now() >= deadline) { reject(new Error('图片槽位未渲染')); return; }
            setTimeout(check, 80);
          }
          check();
        });
      });
  }

  function getDocumentScrollViewport() {
    var root = getValidationSurfaceElement();
    var candidates = [];
    var node = root;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 120) candidates.push(node);
      node = node.parentElement;
    }
    Array.prototype.slice.call(document.querySelectorAll('.bear-web-x-container, [class*="scroll"]'), 0, 40)
      .forEach(function (candidate) {
        if (candidate.scrollHeight > candidate.clientHeight + 120 && candidates.indexOf(candidate) === -1) {
          candidates.push(candidate);
        }
      });
    candidates.sort(function (a, b) {
      return (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight);
    });
    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function buildTextRangeForMarker(container, marker) {
    if (!container || String(container.textContent || '').indexOf(marker) === -1) return null;
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var text = '';
    var current = null;
    while ((current = walker.nextNode())) {
      nodes.push({ node: current, start: text.length, end: text.length + String(current.nodeValue || '').length });
      text += String(current.nodeValue || '');
    }
    var markerStart = text.indexOf(marker);
    if (markerStart === -1 || text.indexOf(marker, markerStart + marker.length) !== -1) return null;
    var markerEnd = markerStart + marker.length;
    var startEntry = nodes.find(function (entry) { return markerStart >= entry.start && markerStart < entry.end; });
    var endEntry = nodes.find(function (entry) { return markerEnd > entry.start && markerEnd <= entry.end; });
    if (!startEntry || !endEntry) return null;
    var range = document.createRange();
    range.setStart(startEntry.node, markerStart - startEntry.start);
    range.setEnd(endEntry.node, markerEnd - endEntry.start);
    return range;
  }

  function findRenderedImageMarker(marker) {
    var editors = document.querySelectorAll('.zone-container.text-editor[contenteditable="true"]');
    var match = null;
    for (var i = 0; i < editors.length; i++) {
      if (String(editors[i].textContent || '').indexOf(marker) === -1) continue;
      if (match) throw new Error('目标文档包含重复图片槽位');
      var range = buildTextRangeForMarker(editors[i], marker);
      if (range) match = { editor: editors[i], range: range };
    }
    return match;
  }

  function selectRenderedImageMarker(marker) {
    var match = findRenderedImageMarker(marker);
    if (!match) return false;
    try { match.editor.focus({ preventScroll: true }); } catch (error) { match.editor.focus(); }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(match.range);
    if (String(selection.toString() || '') !== marker) {
      selection.removeAllRanges();
      throw new Error('图片槽位文本未被完整选中');
    }
    return true;
  }

  function locateAndSelectRenderedImageMarker(marker, viewport, startTop) {
    var deadline = Date.now() + 30000;
    var step = Math.max(320, Math.floor(viewport.clientHeight * 0.72));
    var positions = [];
    var index = 0;
    function rebuildPositions() {
      var maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      var initialTop = Math.max(0, Math.min(maxTop, Number(startTop || 0)));
      positions = [];
      for (var top = initialTop; top <= maxTop; top += step) positions.push(top);
      if (!positions.length || positions[positions.length - 1] !== maxTop) positions.push(maxTop);
      for (var rewind = 0; rewind < initialTop; rewind += step) positions.push(rewind);
      index = 0;
    }
    rebuildPositions();
    return new Promise(function (resolve, reject) {
      function check() {
        try {
          if (selectRenderedImageMarker(marker)) {
            resolve({ scrollTop: viewport.scrollTop });
            return;
          }
        } catch (error) { reject(error); return; }
        if (index >= positions.length) {
          if (Date.now() >= deadline) {
            reject(new Error('图片槽位未渲染'));
            return;
          }
          rebuildPositions();
          setTimeout(check, 400);
          return;
        }
        viewport.scrollTop = positions[index++];
        try { viewport.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (error) {}
        setTimeout(check, 140);
      }
      check();
    });
  }

  function selectRegisteredImageMarker(marker, viewport, startTop) {
    var editorAPI = getEditorAPI();
    var rootBlock = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    var block = rootBlock && findImageMarkerBlocks(rootBlock, [{ marker: marker }])[marker];
    if (!editorAPI || !block) {
      return locateAndSelectRenderedImageMarker(marker, viewport, startTop);
    }
    // Data Service 已确认 marker 存在时，直接让编辑器布局服务渲染对应 block。
    // 这不依赖当前滚动窗口，能覆盖长文档和多图文档的虚拟化区域；旧的
    // viewport 扫描只作为布局服务暂不可用时的兼容兜底。
    return selectImageMarkerBlock(editorAPI, block, marker).then(function () {
      return { scrollTop: viewport.scrollTop };
    }).catch(function () {
      return locateAndSelectRenderedImageMarker(marker, viewport, startTop);
    });
  }

  function snapshotRegisteredImageIds() {
    var editorAPI = getEditorAPI();
    var recordMap = editorAPI && editorAPI.dataService && editorAPI.dataService.getRecordMap();
    if (!recordMap) throw new Error('当前页面未加载可编辑文档数据服务');
    var ids = new Set();
    recordMap.forEach(function (record) {
      if (record && record.snapshot && record.snapshot.type === 'image') ids.add(String(record.id));
    });
    return ids;
  }

  function waitForRegisteredImageInsertion(previousIds, timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs || 60000));
    return new Promise(function (resolve, reject) {
      function check() {
        try {
          var editorAPI = getEditorAPI();
          var recordMap = editorAPI && editorAPI.dataService && editorAPI.dataService.getRecordMap();
          var inserted = null;
          if (recordMap) recordMap.forEach(function (record) {
            var snapshot = record && record.snapshot;
            var token = snapshot && snapshot.type === 'image' && snapshot.image && snapshot.image.token;
            if (!inserted && record && record.id && !previousIds.has(String(record.id)) && token) {
              inserted = { recordId: String(record.id), token: String(token) };
            }
          });
          if (inserted) { resolve(inserted); return; }
          if (Date.now() >= deadline) { reject(new Error('图片原生粘贴未注册目标图片资源')); return; }
          setTimeout(check, 120);
        } catch (error) { reject(error); }
      }
      check();
    });
  }

  function placeCaretAfterRenderedImageMarker(marker) {
    var match = findRenderedImageMarker(marker);
    if (!match) throw new Error('图片暂存锚点未渲染');
    try { match.editor.focus({ preventScroll: true }); } catch (error) { match.editor.focus(); }
    var range = match.range.cloneRange();
    range.collapse(false);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function indexRegisteredImageMarkers(recordMap, mappings) {
    var expectedMarkers = {};
    mappings.forEach(function (mapping) { expectedMarkers[mapping.marker] = true; });
    var markerRecords = {};
    recordMap.forEach(function (record) {
      var marker = getStructuredRecordText(record && record.snapshot).trim();
      if (!expectedMarkers[marker]) return;
      if (markerRecords[marker]) throw new Error('目标文档包含重复图片槽位');
      markerRecords[marker] = record;
    });
    return markerRecords;
  }

  function waitForExpectedImageMarkers(mappings, timeoutMs, stableMs) {
    var startedAt = Date.now();
    var stableSince = 0;
    var lastSignature = '';
    var requiredStableMs = stableMs === undefined ? 1200 : Math.max(0, Number(stableMs || 0));
    return new Promise(function (resolve, reject) {
      function check() {
        var editorAPI = getEditorAPI();
        var recordMap = editorAPI && editorAPI.dataService && editorAPI.dataService.getRecordMap();
        try {
          var markerRecords = recordMap ? indexRegisteredImageMarkers(recordMap, mappings) : {};
          var signature = mappings.map(function (mapping) {
            var record = markerRecords[mapping.marker];
            return record && record.id || '';
          }).join('|');
          var complete = mappings.every(function (mapping) { return markerRecords[mapping.marker]; });
          if (complete && signature === lastSignature) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= requiredStableMs) { resolve(true); return; }
          } else {
            lastSignature = signature;
            stableSince = complete && requiredStableMs === 0 ? Date.now() - 1 : 0;
          }
        } catch (error) {
          reject(error);
          return;
        }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          reject(new Error('粘贴后的图片槽位结构加载超时'));
          return;
        }
        setTimeout(check, 180);
      }
      check();
    });
  }

  function reconcileRegisteredImagesInEditor(mappings) {
    var editorAPI = getEditorAPI();
    if (!editorAPI || !editorAPI.dataService || !editorAPI.structService) {
      return Promise.reject(new Error('当前页面未加载可编辑文档数据服务'));
    }
    var recordMap = editorAPI.dataService.getRecordMap();
    var markerRecords = indexRegisteredImageMarkers(recordMap, mappings);
    var bindings = mappings.map(function (mapping) {
      var markerRecord = markerRecords[mapping.marker];
      var stagingRecord = recordMap.get(mapping.stagingBlockId);
      if (!markerRecord) throw new Error('目标文档缺少图片槽位');
      if (!stagingRecord || !stagingRecord.snapshot || stagingRecord.snapshot.type !== 'image'
        || String(stagingRecord.snapshot.image && stagingRecord.snapshot.image.token || '') !== mapping.targetToken) {
        throw new Error('目标文档图片暂存块与资源 token 不一致');
      }
      return {
        markerId: markerRecord.id,
        markerParentId: String(markerRecord.snapshot && markerRecord.snapshot.parent_id || ''),
        stagingId: mapping.stagingBlockId,
        stagingParentId: String(stagingRecord.snapshot.parent_id || ''),
      };
    });

    var stagingIds = {};
    var markerTargets = {};
    var removableEmptyIds = {};
    var affectedParents = {};
    bindings.forEach(function (binding) {
      stagingIds[binding.stagingId] = true;
      markerTargets[binding.markerId] = binding.stagingId;
      affectedParents[binding.stagingParentId] = true;
      affectedParents[binding.markerParentId] = true;
    });
    bindings.forEach(function (binding) {
      var parent = recordMap.get(binding.stagingParentId);
      var children = parent && parent.snapshot && parent.snapshot.children || [];
      var imageId = binding.stagingId;
        var index = children.indexOf(imageId);
        var nextId = index >= 0 ? children[index + 1] : '';
        var nextRecord = nextId && recordMap.get(nextId);
        if (nextRecord && nextRecord.snapshot && nextRecord.snapshot.type === 'text'
          && !getStructuredRecordText(nextRecord.snapshot).trim()) removableEmptyIds[nextId] = true;
    });

    var nextChildrenByParent = {};
    Object.keys(affectedParents).forEach(function (parentId) {
      var parent = recordMap.get(parentId);
      if (!parent || !parent.snapshot || !Array.isArray(parent.snapshot.children)) {
        throw new Error('图片归位目标父块不存在');
      }
      nextChildrenByParent[parentId] = parent.snapshot.children.reduce(function (next, childId) {
        if (stagingIds[childId] || removableEmptyIds[childId]) return next;
        next.push(markerTargets[childId] || childId);
        return next;
      }, []);
    });

    editorAPI.dataService.applyTransaction('feishu-helper-reconcile-images', function (tx) {
      Object.keys(nextChildrenByParent).forEach(function (parentId) {
        tx.replaceChildren(parentId, nextChildrenByParent[parentId]);
      });
      bindings.forEach(function (binding) {
        tx.replace(binding.stagingId, ['parent_id'], binding.markerParentId);
      });
    });
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + 12000;
      function check() {
        var currentMap = editorAPI.dataService.getRecordMap();
        var remaining = 0;
        var tokens = {};
        var rootRecord = null;
        currentMap.forEach(function (record) {
          if (record && record.snapshot && record.snapshot.type === 'page') rootRecord = record;
        });
        var pendingIds = rootRecord ? [rootRecord.id] : [];
        var visited = {};
        while (pendingIds.length) {
          var recordId = pendingIds.pop();
          if (visited[recordId]) continue;
          visited[recordId] = true;
          var record = currentMap.get(recordId);
          var snapshot = record && record.snapshot;
          if (getStructuredRecordText(snapshot).indexOf('[[FEISHU_HELPER_IMAGE:') !== -1) remaining += 1;
          if (snapshot && snapshot.type === 'image' && snapshot.image && snapshot.image.token) {
            tokens[String(snapshot.image.token)] = true;
          }
          (snapshot && snapshot.children || []).forEach(function (childId) { pendingIds.push(childId); });
        }
        var complete = mappings.every(function (mapping) { return tokens[mapping.targetToken]; });
        if (!remaining && complete) { resolve({ imageCount: mappings.length }); return; }
        if (Date.now() >= deadline) { reject(new Error('图片归位后的数据结构校验失败')); return; }
        setTimeout(check, 120);
      }
      check();
    });
  }

  function waitForRegisteredImageRecords(mappings, timeoutMs) {
    var startedAt = Date.now();
    return new Promise(function (resolve, reject) {
      function check() {
        var editorAPI = getEditorAPI();
        var recordMap = editorAPI && editorAPI.dataService && editorAPI.dataService.getRecordMap();
        var markers = {};
        var stagingIds = {};
        if (recordMap && typeof recordMap.forEach === 'function') {
          recordMap.forEach(function (record) {
            var marker = getStructuredRecordText(record && record.snapshot).trim();
            if (marker) markers[marker] = true;
            if (record && record.id) stagingIds[record.id] = true;
          });
        }
        var complete = mappings.every(function (mapping) {
          return markers[mapping.marker] && stagingIds[mapping.stagingBlockId];
        });
        if (complete) { resolve(true); return; }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          reject(new Error('图片归位前的完整文档结构加载超时'));
          return;
        }
        setTimeout(check, 180);
      }
      check();
    });
  }

  function replaceImageMarkersWithNativePaste(descriptors, whiteboardTransfer) {
    var expected = Array.isArray(descriptors) ? descriptors : [];
    if (!expected.length) return Promise.resolve({ imageCount: 0, nativePastedCount: 0 });
    var viewport = getDocumentScrollViewport();
    var originalScrollTop = viewport.scrollTop;
    var anchorMarker = expected[expected.length - 1].marker;
    var nextScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    var mappings = [];
    // 大文档粘贴是异步事务。必须等全部目标 marker 进入 Data Service 且稳定后，
    // 才能开始原生图片粘贴，否则后续剪贴板操作可能覆盖尚未提交的正文。
    var chain = waitForExpectedImageMarkers(expected, 90000);
    expected.forEach(function (descriptor, index) {
      chain = chain.then(function () {
        emitUiProgress({ phase: 'image-native-paste', done: index, total: expected.length, label: '重建图片' });
        return selectRegisteredImageMarker(anchorMarker, viewport, nextScrollTop).then(function (location) {
          nextScrollTop = location.scrollTop;
          placeCaretAfterRenderedImageMarker(anchorMarker);
          var previousImageIds = snapshotRegisteredImageIds();
          return writeClipboardPayloadWithExtension({ imageDataUrl: descriptor.base64 }, true).then(function (result) {
            result.previousImageIds = previousImageIds;
            return result;
          });
        }).then(function (clipboardResult) {
          if (!(clipboardResult && clipboardResult.pasted)) {
            var pasted = false;
            try { pasted = document.execCommand('paste') === true; } catch (error) {}
            if (!pasted) throw new Error('浏览器未接受第 ' + (index + 1) + ' 张图片的原生粘贴');
          }
          return waitForRegisteredImageInsertion(clipboardResult.previousImageIds, 60000).then(function (inserted) {
            mappings.push({ marker: descriptor.marker, targetToken: inserted.token, stagingBlockId: inserted.recordId,
              width: descriptor.width, height: descriptor.height });
          });
        }).then(function () {
          emitUiProgress({ phase: 'image-native-paste', done: index + 1, total: expected.length, label: '重建图片' });
        });
      });
    });
    return chain.then(function () {
      emitUiProgress({ phase: 'image-native-apply', done: 0, total: expected.length, label: '归位图片' });
      return waitForRegisteredImageRecords(mappings, 20000)
        .then(function () { return reconcileRegisteredImagesInEditor(mappings); })
        .then(function () {
          viewport.scrollTop = Math.min(originalScrollTop, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
          emitUiProgress({ phase: 'image-native-apply', done: expected.length,
            total: expected.length, label: '归位图片' });
          return { imageCount: expected.length, nativePastedCount: expected.length,
            recordIds: mappings.map(function (mapping) { return mapping.stagingBlockId; }) };
        });
    }).catch(function (error) {
      viewport.scrollTop = Math.min(originalScrollTop, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
      throw error;
    });
  }
