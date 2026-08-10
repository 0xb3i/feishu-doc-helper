  // ── Shared bounded async work & virtualized viewport scanning ──────────────

  function mapWithConcurrency(items, concurrency, worker) {
    var source = Array.isArray(items) ? items : [];
    if (!source.length) return Promise.resolve([]);
    var limit = Math.min(Math.max(1, Number(concurrency) || 1), source.length);
    var values = new Array(source.length);
    var nextIndex = 0;
    var firstError = null;

    function runNext() {
      if (firstError) return Promise.resolve();
      var index = nextIndex++;
      if (index >= source.length) return Promise.resolve();
      return Promise.resolve().then(function () {
        return worker(source[index], index);
      }).then(function (value) {
        values[index] = value;
      }).catch(function (error) {
        if (!firstError) firstError = error;
      }).then(runNext);
    }

    var workers = [];
    for (var i = 0; i < limit; i++) workers.push(runNext());
    return Promise.all(workers).then(function () {
      if (firstError) throw firstError;
      return values;
    });
  }

  function scanVirtualScroller(options) {
    var opts = options || {};
    var scroller = opts.scroller;
    var captureMissing = opts.captureMissing;
    var isComplete = opts.isComplete;
    if (!scroller || typeof captureMissing !== 'function' || typeof isComplete !== 'function') {
      return Promise.reject(new Error('虚拟滚动扫描参数无效'));
    }

    var passes = Math.max(1, Number(opts.passes) || 1);
    var firstDelayMs = Math.max(0, Number(opts.firstDelayMs) || 0);
    var secondDelayMs = Math.max(0, Number(opts.secondDelayMs) || 0);
    var maxScrollTop = Math.max(0, Number(opts.maxScrollTop) || 0);
    var step = Math.max(1, Number(opts.step) || 1);
    var positions = [];
    for (var y = 0; y <= maxScrollTop; y += step) positions.push(y);
    if (!positions.length) positions.push(0);

    function wait(delayMs) {
      return delayMs > 0
        ? new Promise(function (resolve) { setTimeout(resolve, delayMs); })
        : Promise.resolve();
    }

    function capture() {
      if (isComplete()) return Promise.resolve();
      return Promise.resolve().then(captureMissing);
    }

    function scanAt(scrollTop) {
      if (isComplete()) return Promise.resolve();
      scroller.scrollTop = Math.min(maxScrollTop, scrollTop);
      try { scroller.dispatchEvent(new Event('scroll')); } catch (error) {}
      return wait(firstDelayMs).then(capture).then(function () {
        if (isComplete()) return undefined;
        return wait(secondDelayMs).then(capture);
      });
    }

    var scan = opts.captureInitially ? capture() : Promise.resolve();
    for (var pass = 0; pass < passes; pass++) {
      positions.forEach(function (scrollTop) {
        scan = scan.then(function () { return scanAt(scrollTop); });
      });
    }
    if (opts.scanEndAfterPasses !== false) {
      scan = scan.then(function () { return scanAt(maxScrollTop); });
    }
    return scan;
  }
