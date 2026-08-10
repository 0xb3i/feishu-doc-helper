  // ── Embedded chart visual transfer ────────────────────────────────────────

  // 飞书内嵌图表（chart_embedded）依赖源租户的 chart token。跨租户粘贴时，
  // 飞书会静默丢弃该块。提取阶段读取飞书自己生成的 SSR 图，并把图表块转换成
  // 结构化图片块；真正的 whiteboard 仍由 29-whiteboard-transfer 以可编辑方式迁移。

  var EMBEDDED_CHART_TOKEN_PREFIX = 'feishu_helper_chart_';
  var EMBEDDED_CHART_URL_PATH_RE = /^\/space\/api\/file\/f\/cdp-chart-[A-Za-z0-9_-]+~noop\/$/;

  function collectEmbeddedChartBlocks(rootBlock) {
    var charts = [];
    function visit(block, depth) {
      if (!block || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return;
      var record = block.record;
      var snapshot = record && record.snapshot;
      if (record && record.id && snapshot && snapshot.type === 'chart_embedded') {
        charts.push({
          viewId: block.id,
          recordId: String(record.id),
          width: Math.max(0, Number(snapshot.width || 0)),
          height: Math.max(0, Number(snapshot.height || 0)),
          align: String(snapshot.align || 'left'),
        });
      }
      (block.children || []).forEach(function (child) { visit(child, depth + 1); });
    }
    visit(rootBlock, 0);
    return charts;
  }

  function normalizeEmbeddedChartImageUrl(value) {
    try {
      var url = new URL(String(value || ''), location.href);
      if (url.protocol !== 'https:' || url.origin !== location.origin
        || !EMBEDDED_CHART_URL_PATH_RE.test(url.pathname)) return '';
      url.hash = '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function createEmbeddedChartSyntheticToken(recordId) {
    return EMBEDDED_CHART_TOKEN_PREFIX + String(recordId || '');
  }

  function captureEmbeddedChartFallbacks() {
    var editorAPI = getEditorAPI();
    var rootBlock = editorAPI && editorAPI.structService && editorAPI.structService.rootBlock;
    var charts = collectEmbeddedChartBlocks(rootBlock);
    if (!charts.length) return Promise.resolve({ count: 0, byRecordId: {} });
    if (!editorAPI || !editorAPI.viewService || !editorAPI.modelService) {
      return Promise.reject(new Error('当前页面未加载内嵌图表 API'));
    }
    var scroller = editorAPI.viewService.layoutManager
      && editorAPI.viewService.layoutManager.getScroller();
    if (!scroller) return Promise.reject(new Error('无法访问源文档滚动容器'));

    var originalScrollTop = scroller.scrollTop;
    var maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    var step = Math.max(320, Math.floor((scroller.clientHeight || 600) * 0.7));
    var imageUrlByRecordId = {};

    function captureLoadedCharts() {
      charts.forEach(function (chart) {
        if (imageUrlByRecordId[chart.recordId]) return;
        var viewEntry = editorAPI.viewService.elements.get(chart.viewId);
        var view = viewEntry && viewEntry.view;
        if (view && view.state && view.state.isRecycle && typeof view.setState === 'function') {
          view.setState({ isRecycle: false });
        }
        var imageUrl = normalizeEmbeddedChartImageUrl(view && view.props && view.props.chartImgUrl);
        if (!imageUrl && view && typeof view.getSSRImgUrl === 'function') {
          try { imageUrl = normalizeEmbeddedChartImageUrl(view.getSSRImgUrl()); }
          catch (error) {}
        }
        if (imageUrl) imageUrlByRecordId[chart.recordId] = imageUrl;
      });
    }

    function scanAt(scrollTop) {
      if (Object.keys(imageUrlByRecordId).length === charts.length) return Promise.resolve();
      scroller.scrollTop = Math.min(maxScrollTop, scrollTop);
      try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
      return new Promise(function (resolve) { setTimeout(resolve, 120); })
        .then(captureLoadedCharts)
        .then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 180); });
        })
        .then(captureLoadedCharts);
    }

    captureLoadedCharts();
    var scan = Promise.resolve();
    for (var pass = 0; pass < 2; pass++) {
      for (var y = 0; y <= maxScrollTop; y += step) {
        (function (scrollTop) { scan = scan.then(function () { return scanAt(scrollTop); }); })(y);
      }
    }
    scan = scan.then(function () { return scanAt(maxScrollTop); });

    return scan.then(function () {
      var missing = charts.filter(function (chart) { return !imageUrlByRecordId[chart.recordId]; });
      if (missing.length) throw new Error('源文档仍有内嵌图表未完成加载');

      var dataUrlByImageUrl = {};
      var imageUrls = [];
      charts.forEach(function (chart) {
        var imageUrl = imageUrlByRecordId[chart.recordId];
        if (imageUrls.indexOf(imageUrl) === -1) imageUrls.push(imageUrl);
      });
      var nextIndex = 0;
      function worker() {
        if (nextIndex >= imageUrls.length) return Promise.resolve();
        var imageUrl = imageUrls[nextIndex++];
        return fetchImageViaBackground(imageUrl).then(function (dataUrl) {
          dataUrlByImageUrl[imageUrl] = dataUrl;
        }).then(worker);
      }
      var workers = [];
      for (var i = 0; i < Math.min(3, imageUrls.length); i++) workers.push(worker());
      return Promise.all(workers).then(function () {
        var byRecordId = {};
        charts.forEach(function (chart) {
          var dataUrl = dataUrlByImageUrl[imageUrlByRecordId[chart.recordId]];
          if (!dataUrl) throw new Error('内嵌图表图片下载不完整');
          byRecordId[chart.recordId] = {
            token: createEmbeddedChartSyntheticToken(chart.recordId),
            dataUrl: dataUrl,
            width: chart.width,
            height: chart.height,
            align: chart.align,
          };
        });
        return { count: charts.length, byRecordId: byRecordId };
      });
    }).finally(function () {
      scroller.scrollTop = originalScrollTop;
      try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
    });
  }

  function cloneBlockTreeWithEmbeddedChartImages(rootBlock, fallbacks) {
    var byRecordId = fallbacks && fallbacks.byRecordId;
    if (!rootBlock || !fallbacks || !fallbacks.count || !byRecordId) return rootBlock;

    function visit(block, depth) {
      if (!block || depth > WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH) return null;
      var sourceRecord = block.record && typeof block.record === 'object' ? block.record : null;
      var record = null;
      if (sourceRecord) {
        var cleanSnapshot = docxRecord.sanitizeSnapshotForRecord(sourceRecord.snapshot);
        var fallback = byRecordId[String(sourceRecord.id || '')];
        if (fallback && cleanSnapshot && cleanSnapshot.type === 'chart_embedded') {
          cleanSnapshot = {
            type: 'image',
            parent_id: cleanSnapshot.parent_id,
            comments: cleanSnapshot.comments || [],
            revisions: cleanSnapshot.revisions || [],
            locked: !!cleanSnapshot.locked,
            hidden: !!cleanSnapshot.hidden,
            author: cleanSnapshot.author,
            align: fallback.align || cleanSnapshot.align || 'left',
            image: {
              token: fallback.token,
              width: fallback.width,
              height: fallback.height,
            },
          };
        }
        record = { id: String(sourceRecord.id || ''), snapshot: cleanSnapshot };
      }
      return {
        id: block.id,
        record: record,
        children: Array.isArray(block.children) ? block.children.map(function (child) {
          return visit(child, depth + 1);
        }).filter(Boolean) : [],
      };
    }

    return visit(rootBlock, 0);
  }

  function getEmbeddedChartPreloadedImages(fallbacks) {
    var result = {};
    var byRecordId = fallbacks && fallbacks.byRecordId;
    Object.keys(byRecordId || {}).forEach(function (recordId) {
      var fallback = byRecordId[recordId];
      if (fallback && fallback.token && fallback.dataUrl) {
        result[fallback.token] = fallback.dataUrl;
      }
    });
    return result;
  }
