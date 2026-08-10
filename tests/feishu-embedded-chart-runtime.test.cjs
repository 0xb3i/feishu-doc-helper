const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docxRecord = require('../lib/feishu-docx-record.cjs');
const ROOT = path.resolve(__dirname, '..');

function loadRuntime() {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/28-embedded-chart-transfer.js'),
    'utf8'
  );
  const context = {
    Promise,
    URL,
    WHITEBOARD_TRANSFER_MAX_BLOCK_DEPTH: 64,
    docxRecord,
    location: {
      href: 'https://tenant.feishu.cn/docx/source',
      origin: 'https://tenant.feishu.cn',
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__chartTestApi = {'
    + 'cloneBlockTreeWithEmbeddedChartImages: cloneBlockTreeWithEmbeddedChartImages,'
    + 'collectEmbeddedChartBlocks: collectEmbeddedChartBlocks,'
    + 'getEmbeddedChartPreloadedImages: getEmbeddedChartPreloadedImages,'
    + 'normalizeEmbeddedChartImageUrl: normalizeEmbeddedChartImageUrl'
    + '};', context, { filename: '28-embedded-chart-transfer.js' });
  return context.__chartTestApi;
}

function chartTree() {
  return {
    id: 1,
    record: { id: 'root', snapshot: { type: 'page' } },
    children: [{
      id: 2,
      record: { id: 'grid', snapshot: { type: 'grid' } },
      children: [{
        id: 3,
        record: { id: 'column', snapshot: { type: 'grid_column' } },
        children: [{
          id: 4,
          record: {
            id: 'chart_record',
            snapshot: {
              type: 'chart_embedded',
              parent_id: 'column',
              token: 'source_chart_token',
              width: 398,
              height: 272,
              align: 'left',
              comments: [],
              revisions: [],
            },
          },
          children: [],
        }],
      }],
    }],
  };
}

test('embedded chart fallback becomes a structured image and leaves the source immutable', () => {
  const api = loadRuntime();
  const source = chartTree();
  const fallbacks = {
    count: 1,
    byRecordId: {
      chart_record: {
        token: 'feishu_helper_chart_chart_record',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        width: 398,
        height: 272,
        align: 'left',
      },
    },
  };

  const cloned = api.cloneBlockTreeWithEmbeddedChartImages(source, fallbacks);
  const converted = cloned.children[0].children[0].children[0].record.snapshot;
  assert.equal(converted.type, 'image');
  assert.deepEqual(JSON.parse(JSON.stringify(converted.image)), {
    token: 'feishu_helper_chart_chart_record', width: 398, height: 272,
  });
  assert.equal(source.children[0].children[0].children[0].record.snapshot.type, 'chart_embedded');
  assert.deepEqual(JSON.parse(JSON.stringify(api.getEmbeddedChartPreloadedImages(fallbacks))), {
    feishu_helper_chart_chart_record: 'data:image/png;base64,iVBORw0KGgo=',
  });
});

test('embedded chart image URL is restricted to the exact same-origin chart endpoint', () => {
  const api = loadRuntime();
  const accepted = api.normalizeEmbeddedChartImageUrl(
    'https://tenant.feishu.cn/space/api/file/f/cdp-chart-token_1~noop/?query=width%3D398'
  );
  assert.match(accepted, /^https:\/\/tenant\.feishu\.cn\/space\/api\/file\/f\/cdp-chart-/);
  assert.equal(api.normalizeEmbeddedChartImageUrl(
    'https://evil.example/space/api/file/f/cdp-chart-token_1~noop/'
  ), '');
  assert.equal(api.normalizeEmbeddedChartImageUrl(
    'https://tenant.feishu.cn/space/api/file/f/other-token/'
  ), '');
});
