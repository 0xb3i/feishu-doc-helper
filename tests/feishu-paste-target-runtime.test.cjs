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

function loadPasteTargetRuntime(editorAPI, validationSnapshot = { blockCount: 0 }) {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/35-paste-target.js'),
    'utf8'
  );
  const context = {
    attribs,
    getEditorAPI: () => editorAPI,
    captureValidationSnapshot: () => validationSnapshot,
    setTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    source + '\nthis.__pasteTargetTestApi = {'
      + 'captureEmptyBodyRecordsBeforePaste: captureEmptyBodyRecordsBeforePaste,'
      + 'waitForEmptyBodyRecordsCapture: waitForEmptyBodyRecordsCapture,'
      + 'removePreservedEmptyBodyRecords: removePreservedEmptyBodyRecords,'
      + 'waitForPreservedEmptyBodyRecordsRemoval: waitForPreservedEmptyBodyRecordsRemoval,'
      + 'schedulePreservedEmptyBodyRecordsCleanup: schedulePreservedEmptyBodyRecordsCleanup };',
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

test('paste cleanup removes a captured placeholder after Feishu mutates it into an empty list or heading', () => {
  for (const mutatedType of ['bullet', 'ordered', 'todo', 'heading2']) {
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

    records.get('empty').snapshot.type = mutatedType;
    records.set('body', { id: 'body', snapshot: textSnapshot('正文') });
    records.get('root').snapshot.children = ['body', 'empty'];

    assert.equal(api.removePreservedEmptyBodyRecords(captured), true, mutatedType);
    assert.deepEqual(replacedChildren, ['body'], mutatedType);
  }
});

test('paste cleanup captures an empty list placeholder left by a previously cleared document', () => {
  const emptyBullet = { ...textSnapshot(''), type: 'bullet' };
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty'] } }],
    ['empty', { id: 'empty', snapshot: emptyBullet }],
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

  records.set('body', { id: 'body', snapshot: textSnapshot('正文') });
  records.get('root').snapshot.children = ['empty', 'body'];

  assert.equal(captured.rootRecordId, 'root');
  assert.deepEqual(Array.from(captured.recordIds), ['empty']);
  assert.equal(api.removePreservedEmptyBodyRecords(captured), true);
  assert.deepEqual(replacedChildren, ['body']);
});

test('paste cleanup ignores internal helper records when the visible body is empty', () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty', 'helper'] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
    ['helper', { id: 'helper', snapshot: { type: 'internal_helper', children: [] } }],
  ]);
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [
          { record: records.get('empty') },
          { record: records.get('helper') },
        ],
      },
    },
  };

  const captured = loadPasteTargetRuntime(editorAPI).captureEmptyBodyRecordsBeforePaste();

  assert.equal(captured.rootRecordId, 'root');
  assert.deepEqual(Array.from(captured.recordIds), ['empty']);
});

test('paste cleanup never captures an empty paragraph from a non-empty document', () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty', 'body'] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
    ['body', { id: 'body', snapshot: textSnapshot('正文') }],
  ]);
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [
          { record: records.get('empty') },
          { record: records.get('body') },
        ],
      },
    },
  };

  const captured = loadPasteTargetRuntime(editorAPI, { blockCount: 1 })
    .captureEmptyBodyRecordsBeforePaste();

  assert.equal(captured, null);
});

test('paste cleanup waits for Feishu to publish the focused empty anchor record', async () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: [] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
  ]);
  const rootBlock = {
    record: records.get('root'),
    children: [],
  };
  const editorAPI = { structService: { rootBlock } };
  setTimeout(() => {
    rootBlock.children = [{ record: records.get('empty') }];
    records.get('root').snapshot.children = ['empty'];
  }, 20);

  const captured = await loadPasteTargetRuntime(editorAPI)
    .waitForEmptyBodyRecordsCapture(300);

  assert.equal(captured.rootRecordId, 'root');
  assert.deepEqual(Array.from(captured.recordIds), ['empty']);
});

test('paste cleanup removes an empty anchor whose record id changed during native paste', () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: [] } }],
  ]);
  let replacedChildren = null;
  const rootBlock = { record: records.get('root'), children: [] };
  const editorAPI = {
    structService: { rootBlock },
    dataService: {
      getRecordMap: () => records,
      applyTransaction(_name, callback) {
        callback({ replaceChildren(_rootId, children) { replacedChildren = children; } });
      },
    },
  };
  const api = loadPasteTargetRuntime(editorAPI);
  const captured = api.captureEmptyBodyRecordsBeforePaste();

  records.set('body', { id: 'body', snapshot: textSnapshot('正文') });
  records.set('replacement-empty', {
    id: 'replacement-empty',
    snapshot: { ...textSnapshot(''), type: 'bullet' },
  });
  records.get('root').snapshot.children = ['body', 'replacement-empty'];

  assert.equal(api.removePreservedEmptyBodyRecords(captured), true);
  assert.deepEqual(replacedChildren, ['body']);
});

test('paste cleanup keeps the pre-focus empty state after Feishu exposes the anchor as a block', async () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty'] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
  ]);
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [{ record: records.get('empty') }],
      },
    },
  };

  const captured = await loadPasteTargetRuntime(editorAPI, { blockCount: 1 })
    .waitForEmptyBodyRecordsCapture(100, true);

  assert.equal(captured.rootRecordId, 'root');
  assert.deepEqual(Array.from(captured.recordIds), ['empty']);
});

test('paste cleanup does not wait for anchors in a non-empty document', async () => {
  const editorAPI = {
    structService: {
      rootBlock: {
        record: { id: 'root', snapshot: { type: 'page', children: [] } },
        children: [],
      },
    },
  };
  const startedAt = Date.now();

  const captured = await loadPasteTargetRuntime(editorAPI, { blockCount: 1 })
    .waitForEmptyBodyRecordsCapture(300);

  assert.equal(captured, null);
  assert.ok(Date.now() - startedAt < 100);
});

test('paste cleanup preserves a captured paragraph that gained nested content', () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: ['empty'] } }],
    ['empty', { id: 'empty', snapshot: textSnapshot('') }],
  ]);
  let transactions = 0;
  const editorAPI = {
    structService: {
      rootBlock: {
        record: records.get('root'),
        children: [{ record: records.get('empty') }],
      },
    },
    dataService: {
      getRecordMap: () => records,
      applyTransaction() { transactions += 1; },
    },
  };
  const api = loadPasteTargetRuntime(editorAPI);
  const captured = api.captureEmptyBodyRecordsBeforePaste();

  records.get('empty').snapshot = { ...textSnapshot(''), type: 'bullet', children: ['nested'] };
  records.get('root').snapshot.children = ['empty', 'nested'];

  assert.equal(api.removePreservedEmptyBodyRecords(captured), false);
  assert.equal(transactions, 0);
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
  const api = loadPasteTargetRuntime(editorAPI, { blockCount: 1 });

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

test('paste cleanup observer removes an anchor committed after the paste promise resolves', async () => {
  const records = new Map([
    ['root', { id: 'root', snapshot: { type: 'page', children: [] } }],
  ]);
  const editorAPI = {
    structService: {
      rootBlock: { record: records.get('root'), children: [] },
    },
    dataService: {
      getRecordMap: () => records,
      applyTransaction(_name, callback) {
        callback({
          replaceChildren(_rootId, children) {
            records.get('root').snapshot.children = children;
          },
        });
      },
    },
  };
  const api = loadPasteTargetRuntime(editorAPI);
  const captured = api.captureEmptyBodyRecordsBeforePaste();
  api.schedulePreservedEmptyBodyRecordsCleanup(captured, 1000);

  setTimeout(() => {
    records.set('body', { id: 'body', snapshot: textSnapshot('正文') });
    records.set('late-empty', {
      id: 'late-empty',
      snapshot: { ...textSnapshot(''), type: 'bullet' },
    });
    records.get('root').snapshot.children = ['body', 'late-empty'];
  }, 150);
  setTimeout(() => {
    records.set('later-empty-heading', {
      id: 'later-empty-heading',
      snapshot: { ...textSnapshot(''), type: 'heading2' },
    });
    records.get('root').snapshot.children.push('later-empty-heading');
  }, 300);

  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.deepEqual(records.get('root').snapshot.children, ['body']);
});
