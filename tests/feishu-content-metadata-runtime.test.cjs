const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const attribs = require('../lib/feishu-attribs.cjs');

const ROOT = path.resolve(__dirname, '..');

function textSnapshot(text) {
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

function loadContentMetadataRuntime() {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/30-content-metadata.js'),
    'utf8'
  );
  const context = { attribs, location: { origin: 'https://example.feishu.cn' } };
  vm.createContext(context);
  vm.runInContext(
    source + '\nthis.__contentMetadataTestApi = { stripTitleFromContent: stripTitleFromContent };',
    context,
    { filename: '30-content-metadata.js' }
  );
  return context.__contentMetadataTestApi;
}

test('title stripping keeps docx blockIds aligned with selection ids', () => {
  const api = loadContentMetadataRuntime();
  const record = {
    rootId: 'root',
    parentId: 'root',
    recordIds: ['title', 'body'],
    blockIds: [2, 3],
    recordMap: {
      root: { id: 'root', snapshot: { type: 'page' } },
      title: { id: 'title', snapshot: textSnapshot('Source title') },
      body: { id: 'body', snapshot: { type: 'callout' } },
    },
    payloadMap: { title: { level: 1 }, body: { level: 1 } },
    selection: [
      { id: 2, type: 'block', recordId: 'title' },
      { id: 3, type: 'block', recordId: 'body' },
    ],
  };

  const stripped = api.stripTitleFromContent({
    text: '# Source title\n\nBody',
    html: '<h1>Source title</h1><p>Body</p>',
    clipboardHtml: '<h1>Source title</h1><p>Body</p>',
    blockCount: 2,
    docxRecord: JSON.stringify(record),
  }, 'Source title');
  const strippedRecord = JSON.parse(stripped.docxRecord);

  assert.deepEqual(strippedRecord.recordIds, ['body']);
  assert.deepEqual(strippedRecord.blockIds, [2]);
  assert.deepEqual(strippedRecord.selection, [{ id: 2, type: 'block', recordId: 'body' }]);
  assert.equal(strippedRecord.recordMap.title, undefined);
  assert.deepEqual(strippedRecord.recordMap.body, record.recordMap.body);
});
