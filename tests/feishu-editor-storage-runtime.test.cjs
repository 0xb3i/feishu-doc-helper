const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRuntime(file, overrides) {
  const context = Object.assign({
    setInterval() {}, registerDisposer() {},
    EDITABLE_SELECTOR: '[contenteditable]',
    document: { activeElement: null, readyState: 'complete', querySelector: () => null },
    window: { getSelection: () => null },
    location: { href: 'https://example.feishu.cn/docx/source', host: 'example.feishu.cn' },
    setDocAttr() {},
    crypto: require('node:crypto').webcrypto,
  }, overrides);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/feishu-runtime', file), 'utf8'), context);
  return context;
}

test('editor readiness discovers the content root once and sees replacement editor APIs', () => {
  const context = loadRuntime('10-editor-storage.js');
  const firstAPI = { structService: { rootBlock: { children: [] } } };
  const root = {
    nodeType: 1, tagName: 'DIV', innerHTML: '<p>Body</p>', querySelectorAll: () => [],
    __reactFiber$test: { memoizedProps: { editorAPI: firstAPI } },
  };
  let rootLookups = 0;
  context.getContentRootElement = () => { rootLookups += 1; return root; };

  assert.equal(context.getEditorReadyState().rootChildCount, 0);
  assert.equal(rootLookups, 1);
  root.__reactFiber$test.memoizedProps.editorAPI = { structService: { rootBlock: { children: [{}, {}] } } };
  assert.equal(context.getEditorReadyState().rootChildCount, 2);
  assert.equal(rootLookups, 2);
});

test('editor discovery evaluates shared React ancestors once per lookup without keeping stale caches', () => {
  const context = loadRuntime('10-editor-storage.js');
  const sharedFiber = { memoizedProps: { shared: true } };
  const child = { nodeType: 1, __reactFiber$test: { memoizedProps: {}, return: sharedFiber } };
  const root = {
    nodeType: 1, __reactFiber$test: sharedFiber,
    querySelectorAll: () => [child], contains: () => true,
  };
  child.parentElement = root;
  context.getContentRootElement = () => root;
  let visits = 0;
  context.findEditorApiValue(() => { visits += 1; return null; });
  assert.equal(visits, 2);
  context.findEditorApiValue(() => { visits += 1; return null; });
  assert.equal(visits, 4);
});

test('pending storage snapshots caller data once and returns the trusted stored envelope', async () => {
  const context = loadRuntime('15-pending-storage.js');
  let sent;
  let stored;
  context.requestExtensionPendingPaste = async (op, value) => {
    assert.equal(op, 'set');
    sent = value;
    stored = { ...value, pendingId: 'trusted-id', ts: value.ts + 1 };
    return stored;
  };
  const input = { text: 'Body', orderedImageBase64List: [{ token: 'image', base64: 'data:image/png;base64,eA==' }] };
  const operation = context.setPendingPaste(input);
  input.orderedImageBase64List[0].token = 'changed';
  const result = await operation;
  assert.equal(sent.orderedImageBase64List[0].token, 'image');
  assert.equal(input.pendingId, undefined);
  assert.equal(result, stored);
  assert.equal(result.pendingId, 'trusted-id');
});

test('pending storage rejects malformed success responses instead of claiming the local input was saved', async () => {
  const context = loadRuntime('15-pending-storage.js');
  context.requestExtensionPendingPaste = async () => null;
  assert.equal(await context.getPendingPaste(), null);
  await assert.rejects(context.setPendingPaste({ text: 'Body' }), /缓存数据格式无效/);
  context.requestExtensionPendingPaste = async () => [];
  await assert.rejects(context.getPendingPaste(), /缓存数据格式无效/);
});
