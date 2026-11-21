const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCommitPaste(overrides) {
  const context = Object.assign({
    clonePendingPasteData: (content) => JSON.parse(JSON.stringify(content)),
    resolvePastePayload: async (content) => content,
    payloadRequiresPasteParsing: () => false,
    shouldAutoDispatchPastePayload: () => true,
    payloadHasFeishuStructuredHtml: () => false,
    payloadHasDowngradedImages: () => false,
    writeClipboardPayload: async () => ({ written: true, pasted: false }),
    showPasteResultToast() {},
    runPasteAttempt: () => ({ autoInserted: true }),
  }, overrides);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/feishu-runtime/36-document-workflows.js'), 'utf8'), context);
  return context.commitPaste;
}

test('clipboard-only preparation never pastes when clipboard writing fails', async () => {
  let attempts = 0;
  const error = new Error('Clipboard denied');
  const commitPaste = loadCommitPaste({
    writeClipboardPayload: async () => { throw error; },
    runPasteAttempt: () => { attempts += 1; },
  });
  await assert.rejects(commitPaste({ text: 'Body' }, { dispatch: false }), error);
  assert.equal(attempts, 0);
});

test('a failure after clipboard write does not repeat a partially executed paste', async () => {
  let attempts = 0;
  const error = new Error('Editor rejected paste');
  const commitPaste = loadCommitPaste({
    runPasteAttempt: () => { attempts += 1; throw error; },
  });
  await assert.rejects(commitPaste({ text: 'Body' }, {}), error);
  assert.equal(attempts, 1);
});

test('normal paste retains its direct fallback when clipboard writing fails', async () => {
  let attempts = 0;
  const commitPaste = loadCommitPaste({
    writeClipboardPayload: async () => { throw new Error('Clipboard denied'); },
    runPasteAttempt: (_payload, options) => {
      attempts += 1;
      assert.equal(options.allowNativePaste, false);
      return { autoInserted: true };
    },
  });
  const result = await commitPaste({ text: 'Body' }, {});
  assert.equal(result.written, false);
  assert.equal(result.status.autoInserted, true);
  assert.equal(attempts, 1);
});
