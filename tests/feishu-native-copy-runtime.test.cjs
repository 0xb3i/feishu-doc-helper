const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docxRecord = require('../lib/feishu-docx-record.cjs');
const nativeClipboardTransform = require('../lib/feishu-native-clipboard-transform.cjs');
const ROOT = path.resolve(__dirname, '..');

function makeRecord(ids) {
  const recordMap = {};
  ids.forEach(function (id) {
    recordMap[id] = { id, snapshot: { type: 'text' } };
  });
  return JSON.stringify({
    recordMap,
    recordIds: ids,
    blockIds: ids.map(function (_id, index) { return index + 2; }),
    selection: ids.map(function (id, index) {
      return { id: index + 2, type: 'block', recordId: id };
    }),
    payloadMap: {},
  });
}

function loadApi() {
  const source = fs.readFileSync(path.join(ROOT, 'src/feishu-runtime/26-native-copy.js'), 'utf8');
  const context = {
    Promise,
    TextEncoder,
    FeishuHelperLibs: { nativeClipboardTransform },
    docxRecord,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__api = {'
    + 'getNativeSelectionService: getNativeSelectionService,'
    + 'parseCompleteNativeRecord: parseCompleteNativeRecord,'
    + 'validateNativeClipboardCompleteness: validateNativeClipboardCompleteness'
    + '};', context, { filename: '26-native-copy.js' });
  return context.__api;
}

test('native selection service resolves by capability instead of minified identity', () => {
  const api = loadApi();
  const wrong = { selectAll() {}, getSelection() {}, setSelection() {} };
  const expected = {
    selectAll() {}, getSelection() {}, setSelection() {},
    removeAllSelection() {}, copySelectedBlocks() {},
  };
  const caches = new Map([['minified-a', wrong], ['minified-b', expected]]);
  assert.equal(api.getNativeSelectionService({ modular: { caches } }), expected);
});

test('native copy completeness accepts all expected offscreen records', () => {
  const api = loadApi();
  const raw = makeRecord(['visible', 'offscreen']);
  const result = api.validateNativeClipboardCompleteness({
    text: 'visible\noffscreen',
    html: '<p>visible</p><p>offscreen</p>',
    docxRecord: raw,
  }, { docxRecord: raw });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    text: 'visible\noffscreen',
    html: '<p>visible</p><p>offscreen</p>',
    docxRecord: raw,
  });
});

test('native copy completeness rejects a virtualized partial selection', () => {
  const api = loadApi();
  assert.throws(function () {
    api.validateNativeClipboardCompleteness({
      text: 'visible',
      html: '<p>visible</p>',
      docxRecord: makeRecord(['visible']),
    }, { docxRecord: makeRecord(['visible', 'offscreen']) });
  }, /未覆盖完整文档结构/);
});

test('native copy completeness rejects text-only permission fallbacks', () => {
  const api = loadApi();
  assert.throws(function () {
    api.validateNativeClipboardCompleteness({ text: 'plain only' }, {
      docxRecord: makeRecord(['one']),
    });
  }, /部分剪贴板格式/);
});
