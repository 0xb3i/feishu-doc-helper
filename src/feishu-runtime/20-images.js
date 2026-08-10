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
    var imgUrls = [];
    var tokenToBase64 = {};
    Object.keys(preloadedTokenToBase64 || {}).forEach(function (token) {
      var dataUrl = preloadedTokenToBase64[token];
      if (/^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(String(dataUrl || ''))) {
        tokenToBase64[token] = dataUrl;
      }
    });
    var urlRegex = /src="(https?:\/\/[^"]+?(?:\/space\/api\/box\/stream\/download\/(?:preview\/|v2\/cover\/|all\/)|(?:feishucdn\.com\/static-resource\/v1\/))([A-Za-z0-9_.~-]+)[^"]*)"/g;
    var match;
    while ((match = urlRegex.exec(html)) !== null) {
      imgUrls.push({ url: match[1], full: match[0], token: match[2] });
    }
    var htmlItemsByToken = Object.create(null);
    imgUrls.forEach(function (item) {
      if (!htmlItemsByToken[item.token]) htmlItemsByToken[item.token] = [];
      htmlItemsByToken[item.token].push(item);
    });

    var groupsByToken = Object.create(null);
    var workItems = [];
    function addWorkItem(token) {
      var cleanToken = String(token || '');
      if (!cleanToken) return;
      var group = groupsByToken[cleanToken];
      if (!group) {
        group = { token: cleanToken, count: 0, urls: [], htmlItems: htmlItemsByToken[cleanToken] || [] };
        groupsByToken[cleanToken] = group;
        workItems.push(group);
      }
      group.count += 1;
    }

    var structuredEntries = Array.isArray(imageEntries) ? imageEntries : [];
    structuredEntries.forEach(function (entry) {
      addWorkItem(entry && entry.image ? entry.image.token : entry && entry.token);
    });
    if (!workItems.length) imgUrls.forEach(function (item) { addWorkItem(item.token); });
    if (!workItems.length) return Promise.resolve({ html: html, tokenToBase64: {} });

    workItems.forEach(function (group) {
      group.htmlItems.forEach(function (item) {
        if (group.urls.indexOf(item.url) === -1) group.urls.push(item.url);
      });
      [
        location.origin + '/space/api/box/stream/download/all/?token=' + encodeURIComponent(group.token),
        location.origin + '/space/api/box/stream/download/preview/' + encodeURIComponent(group.token) + '/?preview_type=16',
      ].forEach(function (url) {
        if (group.urls.indexOf(url) === -1) group.urls.push(url);
      });
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
    var nextIndex = 0;
    var concurrency = Math.min(5, workItems.length);
    showToast('📷 转换图片中 0/' + total);
    emitUiProgress({ phase: 'convert', done: 0, total: total, label: progressLabel });

    function convertOne(group) {
      function finish(base64) {
        done += group.count;
        showToast('📷 转换图片中 ' + done + '/' + total);
        emitUiProgress({ phase: 'convert', done: done, total: total, label: progressLabel });
        if (base64) {
          group.htmlItems.forEach(function (item) {
            html = html.replace(item.full, 'src="' + IMAGE_PLACEHOLDER_SRC + '"');
          });
          tokenToBase64[group.token] = base64;
        }
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

    function worker() {
      if (nextIndex >= workItems.length) return Promise.resolve();
      var item = workItems[nextIndex];
      nextIndex += 1;
      return convertOne(item).then(worker);
    }

    var workers = [];
    for (var i = 0; i < concurrency; i++) workers.push(worker());

    return Promise.all(workers).then(function () { return { html: html, tokenToBase64: tokenToBase64 }; });
  }

  // ── Image upload via Feishu internal API ───────────────────────────────────

  function discoverWikiObjToken(docToken) {
    return pageFetch(
      '/space/api/wiki/v2/tree/get_node/?wiki_token=' + encodeURIComponent(docToken)
        + '&expand_shortcut=true&with_deleted=true',
      { credentials: 'include' }
    )
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var node = (data && data.data && data.data.node) || (data && data.data) || {};
        return node.obj_token || '';
      })
      .catch(function () { return ''; });
  }

  function resolveTargetDocToken() {
    var docToken = '';
    var isWiki = false;
    try {
      var match = location.pathname.match(/\/(docx|wiki|doc)\/([A-Za-z0-9]+)/);
      if (match) {
        isWiki = match[1] === 'wiki';
        docToken = match[2];
      }
    } catch (e) {}
    if (isWiki && docToken) {
      return discoverWikiObjToken(docToken).then(function (objToken) {
        return objToken || docToken;
      });
    }
    return Promise.resolve(docToken);
  }

  function uploadBase64ImageViaApi(base64Data, objToken) {
    var dataUrl = String(base64Data || '').indexOf('data:') === 0
      ? base64Data
      : 'data:image/png;base64,' + base64Data;
    var base64Part = dataUrl.split(',')[1] || '';
    var mimeMatch = dataUrl.match(/data:(image\/\w+);/);
    var mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    var ext = mimeType.split('/')[1] || 'png';

    var byteString = atob(base64Part);
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    for (var i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    var blob = new Blob([ab], { type: mimeType });
    var fileName = 'image.' + ext;
    var fileSize = blob.size;

    var url = '/space/api/box/stream/upload/all/?name=' + encodeURIComponent(fileName)
      + '&size=' + fileSize
      + '&mount_point=docx_image'
      + '&mount_node_token=' + encodeURIComponent(objToken || '')
      + '&push_open_history_record=0';

    var formData = new FormData();
    formData.append('file', blob, fileName);

    return pageFetch(url, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: { 'biz-ua-type': 'Web', 'biz-scene': 'file_upload' },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var token = '';
        if (data && data.data) token = data.data.token || data.data.file_token || data.data.image_key || '';
        if (!token && data && data.result) token = data.result.token || data.result.file_token || data.result.image_key || '';
        return { token: token };
      })
      .catch(function (err) { return { token: '', error: stringifyError(err) }; });
  }

  function uploadAllImages(orderedImageBase64List) {
    var images = orderedImageBase64List || [];
    if (!images.length) {
      return Promise.resolve({ tokenMap: {}, attemptedCount: 0, uploadedCount: 0, failedCount: 0 });
    }

    return resolveTargetDocToken().then(function (objToken) {
      var tokenMap = {};
      var uploadedCount = 0;
      var failedCount = 0;
      var processedCount = 0;
      var nextIndex = 0;
      var concurrency = Math.min(4, images.length);

      emitUiProgress({ phase: 'upload', done: 0, total: images.length, label: '上传图片' });

      function uploadOne(img) {
        return Promise.resolve().then(function () {
          if (!img.base64) return { token: '', error: 'no base64 data' };
          return uploadBase64ImageViaApi(img.base64, objToken);
        }).then(function (result) {
          if (result && result.token) {
            tokenMap[img.token] = result.token;
            uploadedCount += 1;
          } else {
            failedCount += 1;
          }
        }).catch(function () { failedCount += 1; }).then(function () {
          processedCount += 1;
          emitUiProgress({ phase: 'upload', done: processedCount, total: images.length, label: '上传图片' });
        });

      }

      function worker() {
        if (nextIndex >= images.length) return Promise.resolve();
        var img = images[nextIndex];
        nextIndex += 1;
        return uploadOne(img).then(worker);
      }

      var workers = [];
      for (var i = 0; i < concurrency; i++) workers.push(worker());

      return Promise.all(workers).then(function () {
        return {
          tokenMap: tokenMap,
          attemptedCount: images.length,
          uploadedCount: uploadedCount,
          failedCount: failedCount,
        };
      });
    });
  }

  function collectDocumentImageRecords(rootBlock) {
    var records = [];
    function visit(block) {
      if (!block || typeof block !== 'object') return;
      var record = block.record;
      var snapshot = record && record.snapshot;
      if (record && snapshot && snapshot.type === 'image' && snapshot.image) {
        records.push({
          viewId: block.id,
          recordId: String(record.id || ''),
          snapshot: snapshot,
        });
      }
      (block.children || []).forEach(visit);
    }
    visit(rootBlock);
    return records;
  }

  function snapshotDocumentImageRecordIds() {
    var editorAPI = getEditorAPI();
    var rootBlock = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    var ids = {};
    collectDocumentImageRecords(rootBlock).forEach(function (record) {
      if (record.recordId) ids[record.recordId] = true;
    });
    return ids;
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
    var descriptorsBySourceToken = {};
    expected.forEach(function (descriptor) {
      var token = String((descriptor && descriptor.sourceToken) || '');
      if (!token) throw new Error('HTML 图片槽位缺少源 token');
      if (!descriptorsBySourceToken[token]) descriptorsBySourceToken[token] = [];
      descriptorsBySourceToken[token].push(descriptor);
    });
    var imageBlockCount = 0;
    var marked = source.replace(
      /<figure\b(?=[^>]*\bdata-block-type=(['"])image\1)[^>]*>[\s\S]*?<\/figure>/gi,
      function (imageBlockHtml) {
        imageBlockCount += 1;
        var matchingTokens = Object.keys(descriptorsBySourceToken).filter(function (token) {
          return imageBlockHtml.indexOf(token) !== -1 && descriptorsBySourceToken[token].length > 0;
        });
        if (matchingTokens.length !== 1) {
          throw new Error('HTML 图片槽位无法唯一匹配源图片');
        }
        var descriptor = descriptorsBySourceToken[matchingTokens[0]].shift();
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
            if (markerNode) {
              var zone = markerNode.closest('[contenteditable]') || host;
              try { if (zone && typeof zone.focus === 'function') zone.focus({ preventScroll: true }); } catch (error) {}
              var range = document.createRange();
              range.selectNodeContents(markerNode);
              var selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
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

  function waitForNativeImagePaste(editorAPI, marker, previousImageIds, timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs || 15000));
    return new Promise(function (resolve, reject) {
      function check() {
        var markerStillExists = !!findImageMarkerBlocks(editorAPI.structService.rootBlock, [{ marker: marker }])[marker];
        var images = collectDocumentImageRecords(editorAPI.structService.rootBlock).filter(function (record) {
          return !previousImageIds[record.recordId];
        });
        var ready = images.find(function (record) {
          return !!String(record.snapshot.image && record.snapshot.image.token || '');
        });
        if (!markerStillExists && ready) { resolve(ready); return; }
        if (Date.now() >= deadline) { reject(new Error('图片槽位原生粘贴未完成')); return; }
        setTimeout(check, 120);
      }
      check();
    });
  }

  function waitForCompleteImageMarkers(editorAPI, descriptors, timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs || 10000));
    return new Promise(function (resolve, reject) {
      function check() {
        try {
          var markers = findImageMarkerBlocks(editorAPI.structService.rootBlock, descriptors);
          if (Object.keys(markers).length === descriptors.length) { resolve(markers); return; }
        } catch (error) { reject(error); return; }
        if (Date.now() >= deadline) { reject(new Error('目标文档图片槽位数量不完整')); return; }
        setTimeout(check, 120);
      }
      check();
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

  function waitForRenderedImageMarkerRemoval(marker, timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs || 12000));
    return new Promise(function (resolve, reject) {
      function check() {
        if (!findRenderedImageMarker(marker)) { resolve(); return; }
        if (Date.now() >= deadline) { reject(new Error('图片槽位原生粘贴未完成')); return; }
        setTimeout(check, 120);
      }
      check();
    });
  }

  function snapshotRenderedImageIds() {
    var ids = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-block-type="image"]'), function (block) {
      var id = String(block.getAttribute('data-record-id') || block.getAttribute('data-block-id') || '');
      if (id) ids[id] = true;
    });
    return ids;
  }

  function waitForRenderedImageInsertion(previousIds, timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs || 12000));
    return new Promise(function (resolve, reject) {
      function check() {
        var blocks = document.querySelectorAll('[data-block-type="image"]');
        for (var i = 0; i < blocks.length; i++) {
          var id = String(blocks[i].getAttribute('data-record-id') || blocks[i].getAttribute('data-block-id') || '');
          if (id && !previousIds[id]) { resolve(id); return; }
        }
        if (Date.now() >= deadline) { reject(new Error('图片原生粘贴未生成图片块')); return; }
        setTimeout(check, 120);
      }
      check();
    });
  }

  function waitForRenderedImageToken(recordId, timeoutMs) {
    var deadline = Date.now() + Math.max(2000, Number(timeoutMs || 12000));
    return new Promise(function (resolve, reject) {
      function check() {
        var block = document.querySelector('[data-block-type="image"][data-record-id="' + recordId + '"]');
        var tokenNode = block && block.querySelector('[image-token]');
        var token = String(tokenNode && tokenNode.getAttribute('image-token') || '');
        if (token) { resolve(token); return; }
        if (Date.now() >= deadline) { reject(new Error('图片资源注册未返回目标 token')); return; }
        setTimeout(check, 120);
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

  function removeRenderedImageMarker(marker) {
    if (!selectRenderedImageMarker(marker)) return Promise.resolve(false);
    var deleted = false;
    try { deleted = document.execCommand('delete') === true; } catch (error) {}
    if (!deleted) {
      try { deleted = document.execCommand('insertText', false, '') === true; } catch (error) {}
    }
    if (!deleted) throw new Error('图片槽位清理失败');
    return waitForRenderedImageMarkerRemoval(marker, 5000).then(function () { return true; });
  }

  function cleanupRemainingRenderedImageMarkers(descriptors, viewport) {
    var step = Math.max(320, Math.floor(viewport.clientHeight * 0.72));
    var top = 0;
    return new Promise(function (resolve, reject) {
      function check() {
        try {
          for (var i = 0; i < descriptors.length; i++) {
            if (!selectRenderedImageMarker(descriptors[i].marker)) continue;
            var deleted = document.execCommand('delete') === true;
            if (!deleted) throw new Error('图片槽位清理失败');
            setTimeout(check, 100);
            return;
          }
        } catch (error) { reject(error); return; }
        var maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        if (top >= maxTop) { resolve(); return; }
        top = Math.min(maxTop, top + step);
        viewport.scrollTop = top;
        try { viewport.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (error) {}
        setTimeout(check, 140);
      }
      viewport.scrollTop = 0;
      setTimeout(check, 200);
    });
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
        return locateAndSelectRenderedImageMarker(anchorMarker, viewport, nextScrollTop).then(function (location) {
          nextScrollTop = location.scrollTop;
          placeCaretAfterRenderedImageMarker(anchorMarker);
          var previousImageIds = snapshotRenderedImageIds();
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
          return waitForRenderedImageInsertion(clipboardResult.previousImageIds, 20000).then(function (recordId) {
            return waitForRenderedImageToken(recordId, 60000).then(function (targetToken) {
              mappings.push({ marker: descriptor.marker, targetToken: targetToken, stagingBlockId: recordId,
                width: descriptor.width, height: descriptor.height });
            });
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

  // ── Image injection observer (for paste flows that leave img placeholders) ─

  function injectBase64ImagesIntoEditor(orderedImageBase64List) {
    var list = orderedImageBase64List || [];
    if (!list.length) return 0;
    var editable = getContentRootElement();
    if (!editable) return 0;
    var imageBlocks = editable.querySelectorAll('[data-block-type="image"]');
    if (!imageBlocks.length) return 0;

    var injected = 0;
    imageBlocks.forEach(function (block, index) {
      if (index >= list.length) return;
      var imageData = list[index];
      if (!imageData || !imageData.base64) return;
      var dataUrl = imageData.base64.indexOf('data:') === 0
        ? imageData.base64
        : 'data:image/png;base64,' + imageData.base64;

      var img = block.querySelector('img');
      if (img) {
        if (img.src !== dataUrl) img.src = dataUrl;
        if (imageData.width) img.setAttribute('width', imageData.width);
        if (imageData.height) img.setAttribute('height', imageData.height);
        injected++;
        return;
      }

      var container = block.querySelector(
        '.img, [class*="image-content"], [class*="img-container"], [class*="ImgContainer"], [class*="image-wrap"]'
      );
      if (container) {
        var newImg = document.createElement('img');
        newImg.src = dataUrl;
        newImg.style.cssText = 'max-width:100%;height:auto;display:block;';
        if (imageData.width) newImg.setAttribute('width', imageData.width);
        if (imageData.height) newImg.setAttribute('height', imageData.height);
        container.appendChild(newImg);
        injected++;
      }
    });

    return injected;
  }

  var imageInjectionObserver = null;
  var imageInjectionRetryCount = 0;
  var MAX_IMAGE_INJECTION_RETRIES = 8;

  function stopImageInjectionObserver() {
    if (imageInjectionObserver) {
      clearTimeout(imageInjectionObserver._timer);
      imageInjectionObserver.disconnect();
      imageInjectionObserver = null;
    }
    imageInjectionRetryCount = 0;
  }

  function startImageInjectionObserver() {
    if (imageInjectionObserver) return;
    var target = getContentRootElement() || document.body;
    if (!target) return;
    imageInjectionObserver = new MutationObserver(function () {
      clearTimeout(imageInjectionObserver._timer);
      imageInjectionObserver._timer = setTimeout(function () {
        getPendingPaste().then(function (pending) {
          var list = (pending && pending.orderedImageBase64List) || [];
          if (!list.length) {
            // 没有待注入数据时不应继续常驻监听，避免误改页面图片。
            stopImageInjectionObserver();
            return;
          }
          var count = injectBase64ImagesIntoEditor(list);
          if (count >= list.length) {
            // 全部注入完成，立即停止监听，防止后续持续覆盖导致图片抖动/错位。
            stopImageInjectionObserver();
          } else if (count > 0 && imageInjectionRetryCount < MAX_IMAGE_INJECTION_RETRIES) {
            imageInjectionRetryCount++;
            setTimeout(function () {
              getPendingPaste().then(function (next) {
                if (next && next.orderedImageBase64List) {
                  injectBase64ImagesIntoEditor(next.orderedImageBase64List);
                }
              });
            }, 1500);
          }
        });
      }, 500);
    });
    imageInjectionObserver.observe(target, { childList: true, subtree: true });
    registerDisposer(function () {
      if (imageInjectionObserver) {
        imageInjectionObserver.disconnect();
        imageInjectionObserver = null;
      }
    });

    // 兜底：粘贴后 20 秒内若仍未完成注入，强制停止，避免观察器长期常驻。
    setTimeout(stopImageInjectionObserver, 20000);
  }
