const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadRuntime(overrides) {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/25-runtime-async.js'),
    'utf8'
  );
  const context = Object.assign({
    Promise,
    Error,
    Event: function Event(type) { this.type = type; },
    setTimeout,
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__asyncTestApi = {'
    + 'mapWithConcurrency: mapWithConcurrency,'
    + 'scanVirtualScroller: scanVirtualScroller'
    + '};', context, { filename: '25-runtime-async.js' });
  return context.__asyncTestApi;
}

test('bounded map preserves input order and never exceeds its concurrency', async () => {
  const api = loadRuntime();
  let active = 0;
  let maxActive = 0;
  const values = await api.mapWithConcurrency([4, 3, 2, 1], 2, async function (value) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(function (resolve) { setTimeout(resolve, value); });
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(Array.from(values), [40, 30, 20, 10]);
  assert.equal(maxActive, 2);
});

test('bounded map rejects falsy errors, stops queued work, and drains active workers', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    const api = loadRuntime();
    const started = [];
    let secondFinished = false;
    let rejected = false;
    try {
      await api.mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
        started.push(value);
        if (value === 0) throw reason;
        await new Promise((resolve) => setTimeout(resolve, 5));
        secondFinished = true;
      });
    } catch (error) {
      rejected = true;
      assert.equal(error, reason);
    }
    assert.equal(rejected, true);
    assert.equal(secondFinished, true);
    assert.deepEqual(started, [0, 1]);
  }
});

test('virtual scan can finish at the first viewport of an arbitrarily long document', async () => {
  const api = loadRuntime();
  let captures = 0;
  await api.scanVirtualScroller({
    scroller: { scrollTop: 0, dispatchEvent() {} },
    maxScrollTop: Number.MAX_SAFE_INTEGER,
    step: 1,
    passes: 2,
    captureMissing() { captures += 1; },
    isComplete() { return captures > 0; },
  });
  assert.equal(captures, 1);
});

test('virtual scan stops after the first sample that satisfies caller completeness', async () => {
  const delays = [];
  const scrollPositions = [];
  let captures = 0;
  const api = loadRuntime({
    setTimeout: function (callback, delay) {
      delays.push(delay);
      callback();
      return 1;
    },
  });
  const scroller = {
    scrollTop: 0,
    dispatchEvent: function () { scrollPositions.push(this.scrollTop); },
  };
  await api.scanVirtualScroller({
    scroller,
    maxScrollTop: 900,
    step: 300,
    passes: 3,
    firstDelayMs: 100,
    secondDelayMs: 220,
    captureMissing: function () { captures += 1; },
    isComplete: function () { return captures === 1; },
  });
  assert.equal(captures, 1);
  assert.deepEqual(scrollPositions, [0]);
  assert.deepEqual(delays, [100]);
});

test('virtual scan retains every configured pass and final endpoint while incomplete', async () => {
  let captures = 0;
  const api = loadRuntime({
    setTimeout: function (callback) { callback(); return 1; },
  });
  const positions = [];
  const scroller = {
    scrollTop: 0,
    dispatchEvent: function () { positions.push(this.scrollTop); },
  };
  await api.scanVirtualScroller({
    scroller,
    maxScrollTop: 750,
    step: 300,
    passes: 2,
    firstDelayMs: 120,
    secondDelayMs: 180,
    captureMissing: function () { captures += 1; },
    isComplete: function () { return false; },
  });
  assert.deepEqual(positions, [0, 300, 600, 0, 300, 600, 750]);
  assert.equal(captures, positions.length * 2);
});
