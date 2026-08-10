const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadImageRuntime(overrides) {
  const source = fs.readFileSync(path.join(ROOT, 'src/feishu-runtime/20-images.js'), 'utf8');
  const progress = [];
  const fetchedUrls = [];
  const context = {
    Promise,
    Date,
    setTimeout,
    IMAGE_PLACEHOLDER_SRC: 'data:image/gif;base64,placeholder',
    location: { origin: 'https://tenant.feishu.cn' },
    showToast() {},
    emitUiProgress(detail) { progress.push(Object.assign({}, detail)); },
    fetchImageViaBackground(url) {
      fetchedUrls.push(url);
      return Promise.resolve('data:image/png;base64,iVBORw0KGgo=');
    },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__imageTestApi = {'
    + 'convertImagesToBase64: convertImagesToBase64,'
    + 'buildImagePasteDescriptors: buildImagePasteDescriptors,'
    + 'collectDocumentImageRecords: collectDocumentImageRecords,'
    + 'markerizeImagesInDocxRecord: markerizeImagesInDocxRecord,'
    + 'markerizeImagesInClipboardHtml: markerizeImagesInClipboardHtml,'
    + 'findImageMarkerBlocks: findImageMarkerBlocks,'
    + 'indexRegisteredImageMarkers: indexRegisteredImageMarkers,'
    + 'waitForExpectedImageMarkers: waitForExpectedImageMarkers,'
    + 'waitForRegisteredImageRecords: waitForRegisteredImageRecords'
    + '};', context, { filename: '20-images.js' });
  return { api: context.__imageTestApi, progress, fetchedUrls };
}

test('registered images are reconciled in the current editor session without a reload', async () => {
  const records = new Map([
    ['slot-a', { id: 'slot-a', snapshot: { type: 'text', text: {
      initialAttributedTexts: { text: { 0: 'marker-a' } },
    } } }],
    ['staging-a', { id: 'staging-a', snapshot: { type: 'image' } }],
  ]);
  const runtime = loadImageRuntime({
    getEditorAPI() { return { dataService: { getRecordMap() { return records; } } }; },
  });

  assert.equal(await runtime.api.waitForRegisteredImageRecords([
    { marker: 'marker-a', stagingBlockId: 'staging-a' },
  ], 100), true);

  const source = fs.readFileSync(path.join(ROOT, 'src/feishu-runtime/20-images.js'), 'utf8');
  assert.doesNotMatch(source, /location\.reload|image-reconciliation-resume/);
  assert.match(source, /tx\.replaceChildren\(parentId, nextChildrenByParent\[parentId\]\)/);
  assert.match(source, /tx\.replace\(binding\.stagingId, \['parent_id'\], binding\.markerParentId\)/);
  assert.doesNotMatch(source, /tx\.replace\(replacement\.recordId, \[\], replacement\.snapshot\)/);
});

test('image reconciliation ignores repeated ordinary document text', () => {
  const textSnapshot = function (value) {
    return { type: 'text', text: { initialAttributedTexts: { text: { 0: value } } } };
  };
  const records = new Map([
    ['ordinary-a', { id: 'ordinary-a', snapshot: textSnapshot('重复正文') }],
    ['ordinary-b', { id: 'ordinary-b', snapshot: textSnapshot('重复正文') }],
    ['slot-a', { id: 'slot-a', snapshot: textSnapshot('marker-a') }],
  ]);
  const runtime = loadImageRuntime();

  const indexed = runtime.api.indexRegisteredImageMarkers(records, [{ marker: 'marker-a' }]);

  assert.equal(Object.keys(indexed).length, 1);
  assert.equal(indexed['marker-a'].id, 'slot-a');
});

test('native image paste waits for every structured marker before it starts', async () => {
  const textSnapshot = function (value) {
    return { type: 'text', text: { initialAttributedTexts: { text: { 0: value } } } };
  };
  const records = new Map([
    ['slot-a', { id: 'slot-a', snapshot: textSnapshot('marker-a') }],
    ['slot-b', { id: 'slot-b', snapshot: textSnapshot('marker-b') }],
  ]);
  const runtime = loadImageRuntime({
    getEditorAPI() { return { dataService: { getRecordMap() { return records; } } }; },
  });

  assert.equal(await runtime.api.waitForExpectedImageMarkers([
    { marker: 'marker-a' }, { marker: 'marker-b' },
  ], 100, 0), true);
});

function imageBlock(id, token) {
  return {
    id: 'view-' + id,
    record: {
      id,
      snapshot: {
        type: 'image',
        image: { token: token || '', width: 10, height: 20 },
      },
    },
    children: [],
  };
}

test('image conversion progress covers every structured image including record-only entries', async () => {
  const runtime = loadImageRuntime();
  const html = '<p><img src="https://tenant.feishu.cn/space/api/box/stream/download/preview/token-a/?preview_type=16"></p>';
  const imageEntries = [
    { image: { token: 'token-a' } },
    { image: { token: 'token-a' } },
    { image: { token: 'token-b' } },
    { image: { token: 'token-c' } },
  ];

  const result = await runtime.api.convertImagesToBase64(html, imageEntries);

  assert.deepEqual(Object.keys(result.tokenToBase64).sort(), ['token-a', 'token-b', 'token-c']);
  assert.match(result.html, /data:image\/gif;base64,placeholder/);
  assert.equal(runtime.fetchedUrls.length, 3, 'duplicate record tokens should reuse one download');
  assert.deepEqual(runtime.progress[0], {
    phase: 'convert', done: 0, total: 4, label: '转换图片',
  });
  assert.deepEqual(runtime.progress.at(-1), {
    phase: 'convert', done: 4, total: 4, label: '转换图片',
  });
  assert.ok(runtime.fetchedUrls.some(function (url) {
    return url.includes('/download/all/?token=token-b');
  }), 'record-only images should use the absolute token download URL');
});

test('preloaded embedded-chart images reuse trusted bytes without a source-token fetch', async () => {
  const runtime = loadImageRuntime();
  const chartToken = 'feishu_helper_chart_record_1';
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const html = '<img src="https://tenant.feishu.cn/space/api/box/stream/download/preview/'
    + chartToken + '/?preview_type=16">';

  const result = await runtime.api.convertImagesToBase64(
    html,
    [{ image: { token: chartToken } }],
    { [chartToken]: dataUrl }
  );

  assert.equal(result.tokenToBase64[chartToken], dataUrl);
  assert.equal(runtime.fetchedUrls.length, 0);
  assert.match(result.html, /data:image\/gif;base64,placeholder/);
  assert.deepEqual(runtime.progress[0], {
    phase: 'convert', done: 0, total: 1, label: '转换资源（0 图片 + 1 图表）',
  });
  assert.deepEqual(runtime.progress.at(-1), {
    phase: 'convert', done: 1, total: 1, label: '转换资源（0 图片 + 1 图表）',
  });
});

test('image paste descriptors reject incomplete source image data', () => {
  const runtime = loadImageRuntime();
  assert.throws(function () {
    runtime.api.buildImagePasteDescriptors([
      { token: 'source-a', base64: 'data:image/png;base64,AAAA' },
      { token: 'source-b', base64: '' },
    ]);
  }, /第 2 张图片数据不完整/);
});

test('docx image records become exact text slots before target paste', () => {
  const runtime = loadImageRuntime();
  const descriptors = [
    { marker: 'marker-first' },
    { marker: 'marker-second' },
  ];
  const source = {
    recordMap: {
      first: imageBlock('first', 'source-first').record,
      second: imageBlock('second', 'source-second').record,
    },
  };
  const marked = runtime.api.markerizeImagesInDocxRecord(source, descriptors);

  assert.equal(marked.recordMap.first.snapshot.type, 'text');
  assert.equal(marked.recordMap.first.snapshot.text.initialAttributedTexts.text[0], 'marker-first');
  assert.equal(source.recordMap.first.snapshot.type, 'image');
});

test('image marker lookup rejects duplicate slots', () => {
  const runtime = loadImageRuntime();
  function marker(id, value) {
    return { id: 'view-' + id, record: { id, snapshot: {
      type: 'text', text: { initialAttributedTexts: { text: { 0: value } } },
    } }, children: [] };
  }
  const root = { children: [marker('a', 'same-marker'), marker('b', 'same-marker')] };
  assert.throws(function () {
    runtime.api.findImageMarkerBlocks(root, [{ marker: 'same-marker' }]);
  }, /重复图片槽位/);
});

test('clipboard HTML image resources become matching text slots before target paste', () => {
  const runtime = loadImageRuntime();
  const descriptors = [
    { sourceToken: 'source-token-a', marker: 'marker-a' },
    { sourceToken: 'source-token-b', marker: 'marker-b' },
    { sourceToken: 'source-token-c', marker: 'record-only' },
  ];
  const html = '<section>'
    + '<figure class="block" data-block-type="image" data-lark-record-data="source-token-a">'
    + '<img src="https://source.example/source-token-a"><figcaption>caption</figcaption></figure>'
    + '<div><figure data-record-id="b" data-block-type=\'image\' data-meta-block-props="source-token-b">'
    + '<img src="https://source.example/source-token-b"></figure></div>'
    + '</section>';

  const marked = runtime.api.markerizeImagesInClipboardHtml(html, descriptors);

  assert.match(marked, /<p>marker-a<\/p>/);
  assert.match(marked, /<p>marker-b<\/p>/);
  assert.doesNotMatch(marked, /data-lark-record-data|data-meta-block-props|source-token-[ab]/);
});

test('clipboard HTML markerization fails closed when a resource has no source-token match', () => {
  const runtime = loadImageRuntime();
  assert.throws(function () {
    runtime.api.markerizeImagesInClipboardHtml(
      '<figure data-block-type="image" data-lark-record-data="unknown"><img></figure>',
      [{ sourceToken: 'source-token-a', marker: 'marker-a' }]
    );
  }, /HTML 图片槽位无法唯一匹配源图片/);
});
