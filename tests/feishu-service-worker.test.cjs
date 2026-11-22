const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const protocol = require('../extension/shared/protocol.js');

const SOURCE_URL = 'https://example.feishu.cn/docx/Abc123';
const KEY = 'feishu-pending-paste';
const source = fs.readFileSync(path.join(__dirname, '../extension/background/service-worker.js'), 'utf8');
const event = () => ({ addListener() {} });

function loadWorker(local, overrides = {}) {
  let listener;
  const context = vm.createContext({
    FeishuExtensionProtocol: protocol,
    importScripts() {}, console, URL, Blob, Uint8Array, AbortController,
    setTimeout, clearTimeout, crypto: webcrypto,
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
          this.onloadend();
        }).catch(() => this.onerror());
      }
    },
    chrome: {
      runtime: {
        id: 'test-extension',
        onMessage: { addListener(fn) { listener = fn; } },
        onStartup: event(), onInstalled: event(),
      },
      storage: { local },
      tabs: { onRemoved: event(), onUpdated: event() },
      alarms: { onAlarm: event(), create() {}, clear() {} },
      contextMenus: { onClicked: event() },
      commands: { onCommand: event() },
    },
    ...overrides,
  });
  vm.runInContext(source, context);
  return {
    context,
    send(message, sender) {
      return new Promise(resolve => listener(message, sender, resolve));
    },
    request(op, value) {
      return new Promise(resolve => listener({
        source: protocol.MESSAGES.PENDING_PASTE,
        actionRequestId: 'request-1234', action: op === 'set' ? 'extract' : 'paste', op, value,
      }, { id: 'test-extension', tab: { id: 1, url: SOURCE_URL }, frameId: 0, url: SOURCE_URL }, resolve));
    },
  };
}

test('expiry cleanup cannot remove a newly queued extraction', async () => {
  let releaseRead;
  let stored = { schemaVersion: 1, ts: Date.now() - protocol.LIMITS.PENDING_TTL_MS - 1000, text: 'old' };
  const calls = [];
  const local = {
    get() {
      calls.push('get');
      const snapshot = stored;
      return new Promise(resolve => { releaseRead = () => resolve({ [KEY]: snapshot }); });
    },
    async remove() { calls.push('remove'); stored = null; },
    async set(items) { calls.push('set'); stored = items[KEY]; },
  };
  const worker = loadWorker(local);
  const cleanup = worker.context.cleanupExpiredPendingPaste();
  await Promise.resolve();
  const saving = worker.request('set', { schemaVersion: 1, ts: Date.now(), text: 'new' });
  await Promise.resolve();
  assert.deepEqual(calls, ['get']);
  releaseRead();
  await cleanup;
  assert.equal((await saving).ok, true);
  assert.deepEqual(calls, ['get', 'remove', 'set']);
  assert.equal(stored.text, 'new');
});

test('pending reads wait for writes and failed writes do not poison the queue', async () => {
  let stored;
  let fail = true;
  const worker = loadWorker({
    async get() { return { [KEY]: stored }; },
    async set(items) {
      if (fail) { fail = false; throw new Error('disk unavailable'); }
      stored = items[KEY];
    },
    async remove() { stored = null; },
  });
  assert.equal((await worker.request('set', { schemaVersion: 1, ts: Date.now(), text: 'first' })).ok, false);
  const saving = worker.request('set', { schemaVersion: 1, ts: Date.now(), text: 'second' });
  const reading = worker.request('get');
  assert.equal((await saving).ok, true);
  assert.equal((await reading).value.text, 'second');
});

test('image stream enforces byte limits before consuming an unbounded response', async () => {
  let reads = 0;
  let cancelled = false;
  let released = false;
  const worker = loadWorker({});
  const reader = {
    async read() { reads += 1; return { done: false, value: new Uint8Array(protocol.LIMITS.MAX_IMAGE_BYTES / 2) }; },
    async cancel() { cancelled = true; },
    releaseLock() { released = true; },
  };
  await assert.rejects(worker.context.readValidatedImageResponse({ response: { body: { getReader: () => reader } } }), /size limit/);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('image stream recognizes a signature split across chunks and rejects non-images', async () => {
  const worker = loadWorker({});
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');
  function responseFor(value) {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(value.subarray(0, 3)));
        controller.enqueue(new Uint8Array(value.subarray(3)));
        controller.close();
      },
    }));
  }
  const result = await worker.context.readValidatedImageResponse({ response: responseFor(bytes) });
  assert.equal(result, `data:image/png;base64,${bytes.toString('base64')}`);
  await assert.rejects(worker.context.readValidatedImageResponse({ response: responseFor(Buffer.from('<html>not an image')) }), /approved image format/);
});

test('rejected image headers cancel the response body without downloading it', async () => {
  const worker = loadWorker({});
  for (const patch of [
    { ok: false, status: 403 },
    { url: 'https://unapproved.example/image.png' },
    { headers: new Headers({ 'content-type': 'text/html' }) },
    { headers: new Headers({ 'content-type': 'image/png', 'content-length': String(protocol.LIMITS.MAX_IMAGE_BYTES + 1) }) },
  ]) {
    let cancelled = false;
    const response = {
      ok: true, url: 'https://img.feishucdn.com/image.png',
      headers: new Headers({ 'content-type': 'image/png' }),
      body: { async cancel() { cancelled = true; } }, ...patch,
    };
    assert.throws(() => worker.context.validateImageResponse(response, SOURCE_URL));
    assert.equal(cancelled, true);
  }
});

test('retired pending delete and native image reconciliation operations fail closed', () => {
  assert.equal(protocol.isPendingOp('delete'), false);
  assert.equal(protocol.validateNativeMessagingRequest({
    type: protocol.NATIVE_MESSAGING.REQUEST_TYPE, host: protocol.NATIVE_MESSAGING.HOST_NAME,
    op: 'reconcileImages', action: 'paste', targetUrl: SOURCE_URL,
  }).ok, false);
  assert.equal(protocol.validateNativeMessagingRequest({
    type: protocol.NATIVE_MESSAGING.REQUEST_TYPE, host: protocol.NATIVE_MESSAGING.HOST_NAME,
    op: 'inspect', action: 'scan', sourceUrl: SOURCE_URL, images: [],
  }).ok, false);
});

test('popup pending query and clear accept extension UI senders only and return lightweight metadata', async () => {
  let stored = null;
  const local = {
    async get() { return { [KEY]: stored }; },
    async set(items) { stored = items[KEY]; },
    async remove() { stored = null; },
  };
  const worker = loadWorker(local);
  const saved = await worker.request('set', {
    schemaVersion: 1,
    ts: Date.now(),
    title: '源文档标题',
    text: '正文内容',
    semanticSnapshot: { blockCount: 12, imageCount: 2, whiteboardCount: 1 },
  });
  assert.equal(saved.ok, true);

  // Content script / document tab sender must be rejected.
  const tabSender = { id: 'test-extension', tab: { id: 1, url: SOURCE_URL }, frameId: 0, url: SOURCE_URL };
  assert.equal((await worker.send({ source: protocol.MESSAGES.PENDING_PASTE_QUERY }, tabSender)).ok, false);
  assert.equal((await worker.send({ source: protocol.MESSAGES.PENDING_PASTE_CLEAR }, tabSender)).ok, false);

  // Extension UI sender (no sender.tab) receives metadata without raw body/html payload.
  const uiSender = { id: 'test-extension', url: 'chrome-extension://test-extension/ui/popup.html' };
  const queried = await worker.send({ source: protocol.MESSAGES.PENDING_PASTE_QUERY }, uiSender);
  assert.equal(queried.ok, true);
  assert.equal(queried.pending.title, '源文档标题');
  assert.equal(queried.pending.savedFromHost, 'example.feishu.cn');
  assert.equal(queried.pending.summary.blockCount, 12);
  assert.equal(queried.pending.summary.imageCount, 2);
  assert.equal(queried.pending.summary.whiteboardCount, 1);
  assert.equal('text' in queried.pending, false);

  const documentCache = {
    schemaVersion: 2,
    pendingId: 'pending-source',
    ts: Date.now(),
    text: '正文内容',
    semanticSnapshot: { blockCount: 0 },
  };
  assert.equal((await worker.request('set', { ...documentCache, blockCount: -1 })).ok, false);
  for (const blockCount of [205, 0]) {
    assert.equal((await worker.request('set', { ...documentCache, blockCount })).ok, true);
    const response = await worker.send({ source: protocol.MESSAGES.PENDING_PASTE_QUERY }, uiSender);
    assert.equal(response.pending.summary.blockCount, blockCount);
  }

  const cleared = await worker.send({ source: protocol.MESSAGES.PENDING_PASTE_CLEAR }, uiSender);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, true);
  assert.equal((await worker.send({ source: protocol.MESSAGES.PENDING_PASTE_QUERY }, uiSender)).pending, null);
});
