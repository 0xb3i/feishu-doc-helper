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

function loadPasteTargetRuntime(editorAPI) {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/35-paste-target.js'),
    'utf8'
  );
  const context = {
    attribs,
    getEditorAPI: () => editorAPI,
    setTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    source + '\nthis.__pasteTargetTestApi = {'
      + 'captureEmptyBodyRecordsBeforePaste: captureEmptyBodyRecordsBeforePaste,'
      + 'removePreservedEmptyBodyRecords: removePreservedEmptyBodyRecords,'
      + 'waitForPreservedEmptyBodyRecordsRemoval: waitForPreservedEmptyBodyRecordsRemoval };',
    context,
    { filename: '35-paste-target.js' }
  );
  return context.__pasteTargetTestApi;
}

test('paste cleanup removes only the empty target block that existed before paste', () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty'] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
  ]);
  let replacedChildren = null;
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [{ record: records.get('empty') }],
      },
    },
    dataService: {
      getRecordMap: () => records,
      applyTransaction(_name, callback) {
        callback({ replaceChildren(_rootId, children) { replacedChildren = children; } });
      },
    },
  };
  const api = loadPasteTargetRuntime(editorAPI);
  const captured = api.captureEmptyBodyRecordsBeforePaste();

  records.set('body', { id: 'body', snapshot: { type: 'callout' } });
  records.get('root').snapshot.children = ['empty', 'body'];

  assert.equal(api.removePreservedEmptyBodyRecords(captured), true);
  assert.deepEqual(replacedChildren, ['body']);
});

test('paste cleanup preserves non-empty or source-created blank blocks', () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['existing', 'source-blank'] } }],
    ['existing', { id: 'existing', snapshot: textSnapshot('kept') }],
    ['source-blank', { id: 'source-blank', snapshot: textSnapshot('') }],
  ]);
  let transactions = 0;
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [{ record: records.get('existing') }],
      },
    },
    dataService: {
      getRecordMap: () => records,
      applyTransaction() { transactions += 1; },
    },
  };
  const api = loadPasteTargetRuntime(editorAPI);

  assert.equal(api.captureEmptyBodyRecordsBeforePaste(), null);
  assert.equal(api.removePreservedEmptyBodyRecords(null), false);
  assert.equal(transactions, 0);
});

test('paste cleanup removes the target placeholder as soon as new body content appears', async () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty'] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
  ]);
  let removedAt = 0;
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [{ record: records.get('empty') }],
      },
    },
    dataService: {
      getRecordMap: () => records,
      applyTransaction(_name, callback) {
        callback({
          replaceChildren(_rootId, children) {
            records.get('root').snapshot.children = children;
            removedAt = Date.now();
          },
        });
      },
    },
  };
  const api = loadPasteTargetRuntime(editorAPI);
  const captured = api.captureEmptyBodyRecordsBeforePaste();
  const startedAt = Date.now();
  const removal = api.waitForPreservedEmptyBodyRecordsRemoval(captured, 500);

  setTimeout(() => {
    records.set('body', { id: 'body', snapshot: { type: 'callout' } });
    records.get('root').snapshot.children = ['empty', 'body'];
  }, 20);

  assert.equal(await removal, true);
  assert.deepEqual(records.get('root').snapshot.children, ['body']);
  assert.ok(removedAt - startedAt < 300);
});
