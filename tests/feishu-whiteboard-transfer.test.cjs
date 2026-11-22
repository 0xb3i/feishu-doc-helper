'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const transfer = require('../lib/feishu-whiteboard-transfer.cjs');
const { BundleStore, writeJsonAtomic } = require('../native-host/bundle-store.cjs');
const { TransferService } = require('../native-host/transfer-service.cjs');
const {
  computeExtensionId,
  discoverLarkCli,
  discoverStableNodePath,
  installNativeManifests,
  parseArgs,
  parseMap,
  validateConfiguredProfiles,
} = require('../native-host/install.cjs');
const { LarkClient } = require('../native-host/lark-client.cjs');
const { resolveProfile, validateRequest } = require('../native-host/host.cjs');
const identity = require('../extension/extension-identity.json');

const BUNDLE_ID = 'a'.repeat(64);

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-whiteboard-test-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function makeTransfer() {
  return transfer.createTransferMetadata(BUNDLE_ID, [{ blockId: 'source_board_1' }]);
}

function saveSimpleBundle(store) {
  const metadata = makeTransfer();
  store.create(BUNDLE_ID);
  store.saveBundle({
    schemaVersion: 1,
    id: BUNDLE_ID,
    createdAt: Date.now(),
    expiresAt: Date.now() + transfer.BUNDLE_TTL_MS,
    source: { url: 'https://source.feishu.cn/docx/Source1', documentId: 'Source1', revisionId: 1 },
    transfer: metadata,
    boards: [{
      slotId: metadata.slots[0].slotId,
      sourceBlockId: metadata.slots[0].sourceBlockId,
      nodeCount: 1,
      nodes: [{ id: 'node-1', type: 'shape', x: 1, y: 2 }],
      bindings: [],
    }],
    assets: [],
  });
  return metadata;
}

test('bundle expiry and discard preserve an active transfer until its lock is released', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  const bundleDir = store.bundleDir(BUNDLE_ID);
  await store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async function () {
    const bundle = store.loadBundle(BUNDLE_ID);
    bundle.expiresAt = Date.now() - 1;
    store.saveBundle(bundle);
    store.cleanupExpired();
    assert.throws(() => store.loadBundle(BUNDLE_ID), /已过期/);
    assert.throws(() => store.discard(BUNDLE_ID), /迁移正在执行/);
    assert.ok(fs.existsSync(path.join(bundleDir, 'bundle.json')));
    store.saveJournal(BUNDLE_ID, 'TargetDoc1', { status: 'complete' });
    assert.equal(store.loadJournal(BUNDLE_ID, 'TargetDoc1').status, 'complete');
  });
  store.cleanupExpired();
  assert.equal(fs.existsSync(bundleDir), false);
});

test('target locks reject overlapping work and release after callback failure', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  await assert.rejects(store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async function () {
    assert.throws(() => store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async function () {}), /正在执行/);
    throw new Error('transfer interrupted');
  }), /transfer interrupted/);
  assert.equal(await store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async () => 'retried'), 'retried');
  assert.deepEqual(fs.readdirSync(path.join(store.bundleDir(BUNDLE_ID), 'targets')), []);
});

test('expired cleanup shares the same stale-owner and incomplete-lock rules as acquisition', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  const bundle = store.loadBundle(BUNDLE_ID);
  bundle.expiresAt = Date.now() - 1;
  store.saveBundle(bundle);
  const lockDir = path.join(store.bundleDir(BUNDLE_ID), 'targets', store.targetKey(BUNDLE_ID, 'TargetDoc1') + '.lock');
  fs.mkdirSync(lockDir);
  store.cleanupExpired();
  assert.ok(fs.existsSync(lockDir), 'a newly created lock without its owner record must survive cleanup');
  const oldTime = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockDir, oldTime, oldTime);
  await store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async function () {
    store.cleanupExpired();
    assert.ok(fs.existsSync(lockDir), 'reclaimed lock protects the ongoing transfer');
  });
  fs.mkdirSync(lockDir);
  writeJsonAtomic(path.join(lockDir, 'owner'), { pid: 0, heartbeatAt: oldTime.getTime() });
  store.cleanupExpired();
  assert.equal(fs.existsSync(store.bundleDir(BUNDLE_ID)), false);
});

test('failed atomic bundle writes leave no temporary file or replaced target', (t) => {
  const dir = makeTempDir(t);
  const target = path.join(dir, 'bundle.json');
  fs.mkdirSync(target);
  assert.throws(() => writeJsonAtomic(target, { secret: 'asset-token' }));
  assert.deepEqual(fs.readdirSync(dir), ['bundle.json']);
  assert.ok(fs.statSync(target).isDirectory());
});

test('lifecycle gate excludes another Host between lock inspection and bundle deletion', async (t) => {
  for (const operation of ['discard', 'cleanupExpired']) {
    await t.test(operation, (t) => {
      const dataDir = makeTempDir(t);
      const store = new BundleStore({ dataDir });
      saveSimpleBundle(store);
      const bundle = store.loadBundle(BUNDLE_ID);
      bundle.expiresAt = Date.now() - 1;
      store.saveBundle(bundle);
      const inspect = store.hasActiveTargetLock.bind(store);
      let inspected = false;
      store.hasActiveTargetLock = function (bundleId, now) {
        const active = inspect(bundleId, now);
        if (!inspected) {
          inspected = true;
          const result = spawnSync(process.execPath, ['-e', `
            const { BundleStore } = require(process.argv[1]);
            const store = new BundleStore({ dataDir: process.argv[2] });
            try {
              store.withTargetLock(process.argv[3], 'TargetDoc1', async () => {
                process.stdout.write('acquired');
              }).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
            } catch (error) { process.stdout.write(error.code || error.message); }
          `, require.resolve('../native-host/bundle-store.cjs'), dataDir, BUNDLE_ID], { encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout, 'FEISHU_BUNDLE_BUSY');
        }
        return active;
      };
      if (operation === 'discard') store.discard(BUNDLE_ID);
      else store.cleanupExpired();
      assert.equal(inspected, true);
      assert.deepEqual(fs.readdirSync(store.bundleRoot), []);
      assert.throws(() => store.saveJournal(BUNDLE_ID, 'TargetDoc1', { status: 'late' }), /ENOENT/);
      assert.equal(fs.existsSync(store.bundleDir(BUNDLE_ID)), false, 'late journal writes cannot resurrect discarded data');
    });
  }
});

test('target lock acquisition excludes cleanup before publishing its owner and releases a failed gate', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  const bundleDir = store.bundleDir(BUNDLE_ID);
  const lockPath = path.join(bundleDir, 'targets', store.targetKey(BUNDLE_ID, 'TargetDoc1') + '.lock');
  const originalMkdir = fs.mkdirSync;
  let fail = true;
  t.mock.method(fs, 'mkdirSync', function (dir, options) {
    if (dir === lockPath && fail) {
      fail = false;
      assert.throws(() => store.discard(BUNDLE_ID), { code: 'FEISHU_BUNDLE_BUSY' });
      const error = new Error('simulated lock publication failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalMkdir(dir, options);
  });
  assert.throws(() => store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async () => {}), /publication failure/);
  assert.equal(fs.existsSync(bundleDir), true);
  assert.deepEqual(fs.readdirSync(bundleDir).sort(), ['assets', 'bundle.json', 'targets']);
  assert.equal(await store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async () => 'retried'), 'retried');
});

test('a crashed lifecycle owner protects ongoing work and is then discarded without admitting new writes', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  const bundleDir = store.bundleDir(BUNDLE_ID);
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(exited.status, 0);
  await store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async function () {
    fs.symlinkSync(exited.pid + '-' + 'f'.repeat(32), path.join(bundleDir, '.lifecycle.lock'));
    assert.throws(() => store.discard(BUNDLE_ID), { code: 'FEISHU_BUNDLE_BUSY' });
    assert.ok(fs.existsSync(path.join(bundleDir, 'bundle.json')));
  });
  assert.throws(() => store.withTargetLock(BUNDLE_ID, 'TargetDoc1', async () => {}), { code: 'FEISHU_BUNDLE_BUSY' });
  store.discard(BUNDLE_ID);
  assert.deepEqual(fs.readdirSync(store.bundleRoot), []);
});

test('cleanup finishes a bundle deletion interrupted after atomic retirement', (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  saveSimpleBundle(store);
  const originalRm = fs.rmSync;
  t.mock.method(fs, 'rmSync', function (file, options) {
    if (path.basename(file).startsWith('.discarded-')) throw new Error('simulated interrupted removal');
    return originalRm(file, options);
  });
  assert.throws(() => store.discard(BUNDLE_ID), /interrupted removal/);
  assert.equal(fs.existsSync(store.bundleDir(BUNDLE_ID)), false);
  assert.equal(fs.readdirSync(store.bundleRoot).length, 1);
  t.mock.restoreAll();
  store.cleanupExpired();
  assert.deepEqual(fs.readdirSync(store.bundleRoot), []);
});

test('document XML parser preserves board order and locates exact marker blocks', () => {
  const metadata = makeTransfer();
  const xml = '<title>示例</title>'
    + '<whiteboard id="source_board_1" token="source_board_token_1"></whiteboard>'
    + '<p id="target_marker_1"><span>' + metadata.slots[0].marker + '</span></p>'
    + '<whiteboard id="target_board_1" token="target_board_token_1"></whiteboard>';
  assert.deepEqual(transfer.listDocumentWhiteboards(xml), [
    { blockId: 'source_board_1', token: 'source_board_token_1' },
    { blockId: 'target_board_1', token: 'target_board_token_1' },
  ]);
  assert.deepEqual(transfer.findTransferMarkers(xml, metadata), [{
    slotId: 'board-0001',
    marker: metadata.slots[0].marker,
    markerBlockId: 'target_marker_1',
    followingBoard: { blockId: 'target_board_1', token: 'target_board_token_1' },
  }]);

  const nested = '<callout id="container_1"><p id="deep_marker_1"><span>'
    + metadata.slots[0].marker + '</span></p></callout>';
  assert.deepEqual(transfer.findTransferMarkers(nested, metadata), [{
    slotId: 'board-0001',
    marker: metadata.slots[0].marker,
    markerBlockId: 'deep_marker_1',
    followingBoard: null,
  }]);

});

test('official document summary counts stable block IDs and structured media', () => {
  const xml = '<title id="title_block">标题</title>'
    + '<p id="paragraph_1">正文</p>'
    + '<table id="table_1"><tbody><tr><td><p id="cell_text_1">单元格</p></td></tr></tbody></table>'
    + '<img id="image_1" token="image_token_1"/>'
    + '<equation id="equation_1">x</equation>'
    + '<whiteboard id="board_1" token="board_token_1"></whiteboard>';
  assert.deepEqual(transfer.summarizeDocumentStructure(xml), {
    blockCount: 4,
    equationCount: 1,
    imageCount: 1,
    whiteboardCount: 1,
  });
});

test('raw transfer strips tenant identity and rejects SVG external resources', () => {
  const nodes = [
    {
      id: 'sticky-1',
      type: 'sticky_note',
      sticky_note: { text: '保留正文', user_id: 'ou_source_tenant_user' },
    },
    {
      id: 'svg-1',
      type: 'svg',
      svg: {
        key: 'local-shape-key',
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
          + '<defs><path id="shape" d="M0 0h10v10z"/></defs><use href="#shape"/></svg>',
      },
    },
  ];
  const sanitized = transfer.sanitizeRawNodesForTransfer(nodes);
  assert.equal(sanitized[0].sticky_note.user_id, undefined);
  assert.equal(sanitized[0].sticky_note.text, '保留正文');
  assert.equal(sanitized[1].svg.key, 'local-shape-key');
  assert.equal(nodes[0].sticky_note.user_id, 'ou_source_tenant_user');

  assert.throws(function () {
    transfer.sanitizeRawNodesForTransfer([{
      type: 'svg',
      svg: {
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/a.png"/></svg>',
      },
    }]);
  }, /SVG.*外部/);
  assert.throws(function () {
    transfer.sanitizeRawNodesForTransfer([{
      type: 'svg',
      svg: {
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/a.svg#x"/></svg>',
      },
    }]);
  }, /SVG.*外部/);
  assert.throws(function () {
    transfer.sanitizeRawNodesForTransfer([{
      type: 'svg',
      svg: {
        svg_code: '<svg xmlns="http://www.w3.org/2000/svg">'
          + '<rect style="fill:&#x75;rl(h&#116;tp:&#47;&#47;evil.example/a.svg)"/></svg>',
      },
    }]);
  }, /SVG.*外部/);
});

test('source export returns official board node counts without persisting raw data or downloading assets', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  let downloadCount = 0;
  const client = {
    async fetchDocument() {
      return {
        document_id: 'SourceDoc1',
        revision_id: 7,
        content: '<whiteboard id="source_board_1" token="source_board_token_1"></whiteboard>'
          + '<whiteboard id="source_board_2" token="source_board_token_2"></whiteboard>',
      };
    },
    async exportWhiteboard() {
      return [
        { id: 'image-node-1', type: 'image', image: { token: 'source_shared_image_token' } },
        { id: 'sticky-node-1', type: 'sticky_note', sticky_note: { text: '保留', user_id: 'ou_source_tenant_user' } },
      ];
    },
    async downloadMedia() { downloadCount += 1; },
  };
  const service = new TransferService({ client: client, store: store });
  const result = await service.exportSource('https://source.feishu.cn/docx/SourceDoc1');
  assert.equal(result.boardCount, 2);
  assert.deepEqual(result.whiteboardTransfer.slots.map((slot) => slot.nodeCount), [2, 2]);
  assert.equal(result.sourceSummary.whiteboardCount, 2);
  assert.equal(downloadCount, 0);
  assert.deepEqual(fs.readdirSync(store.bundleRoot), []);
});

test('source inspection counts official document whiteboards without creating a bundle', async (t) => {
  const store = new BundleStore({ dataDir: makeTempDir(t) });
  const client = {
    async fetchDocument() {
      return {
        document_id: 'SourceDoc1',
        revision_id: 7,
        content: '<whiteboard id="source_board_1" token="source_token_1"></whiteboard>'
          + '<p>正文</p>'
          + '<whiteboard id="source_board_2" token="source_token_2"></whiteboard>',
      };
    },
  };
  const service = new TransferService({ client: client, store: store });
  assert.deepEqual(await service.inspectSource('https://source.feishu.cn/docx/SourceDoc1'), {
    blockCount: 1,
    equationCount: 0,
    imageCount: 0,
    whiteboardCount: 2,
  });
  assert.deepEqual(fs.readdirSync(store.bundleRoot), []);
});

test('native installer identity and selector parsing are deterministic', () => {
  assert.equal(computeExtensionId(identity.publicKey), identity.extensionId);
  assert.deepEqual(parseMap('*.feishu.cn/wiki/=personal'), {
    hostSuffix: 'feishu.cn',
    pathPrefix: '/wiki/',
    profile: 'personal',
  });
  assert.throws(function () { parseMap('feishu.cn=bad profile'); });
  assert.deepEqual(
    parseArgs(['--chrome-user-data-dir', '/tmp/agent-browser-profile']),
    { maps: [], larkCliPath: '', chromeUserDataDirs: ['/tmp/agent-browser-profile'] },
  );
  assert.ok(path.isAbsolute(discoverStableNodePath()));
});

test('native installer rejects missing or unauthenticated mapped profiles', () => {
  const rules = [
    { hostSuffix: 'larkoffice.com', pathPrefix: '/', profile: 'corp' },
    { hostSuffix: 'feishu.cn', pathPrefix: '/', profile: 'personal' },
    { hostSuffix: 'my.feishu.cn', pathPrefix: '/', profile: 'personal' },
  ];
  const calls = [];
  const valid = validateConfiguredProfiles('/mock/lark-cli', rules, function (binary, args, options) {
    calls.push({ binary: binary, args: args, options: options });
    return {
      status: 0,
      stdout: JSON.stringify({
        identity: 'user',
        verified: true,
        identities: { user: { status: 'ready', available: true, verified: true } },
      }),
      stderr: '',
    };
  });
  assert.deepEqual(valid, ['corp', 'personal']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    'auth', 'status', '--json', '--verify', '--profile', 'corp',
  ]);

  assert.throws(function () {
    validateConfiguredProfiles('/mock/lark-cli', [rules[0]], function () {
      return { status: 3, stdout: '', stderr: 'profile not found' };
    });
  }, /corp.*不存在/);
  assert.throws(function () {
    validateConfiguredProfiles('/mock/lark-cli', [rules[0]], function () {
      return {
        status: 0,
        stdout: JSON.stringify({
          identity: 'user',
          verified: false,
          identities: { user: { status: 'expired', available: true, verified: false } },
        }),
      };
    });
  }, /登录已失效/);
});

test('installer resolves the npm launcher to a cancellable native lark-cli binary', (t) => {
  const root = makeTempDir(t);
  const scripts = path.join(root, 'scripts');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(scripts);
  fs.mkdirSync(bin);
  const wrapper = path.join(scripts, 'run.js');
  const native = path.join(bin, 'lark-cli');
  fs.writeFileSync(wrapper, '#!/usr/bin/env node\n');
  fs.writeFileSync(native, 'native-binary');
  fs.chmodSync(wrapper, 0o700);
  fs.chmodSync(native, 0o700);
  assert.equal(discoverLarkCli(wrapper), fs.realpathSync(native));
  assert.equal(discoverLarkCli(native), fs.realpathSync(native));
  const customWrapper = path.join(root, 'custom-cli');
  fs.writeFileSync(customWrapper, '#!/bin/sh\nexec lark-cli "$@"\n');
  assert.throws(() => discoverLarkCli(customWrapper), /脚本包装器/);
});

test('installer keeps working when an optional browser manifest directory is unavailable', (t) => {
  const root = makeTempDir(t);
  const unavailableParent = path.join(root, 'not-a-directory');
  const availableDirectory = path.join(root, 'available');
  fs.writeFileSync(unavailableParent, 'file');
  const manifest = { name: 'com.example.host', type: 'stdio', path: '/tmp/example' };
  const result = installNativeManifests([
    path.join(unavailableParent, 'NativeMessagingHosts'),
    availableDirectory,
  ], 'com.example.host.json', manifest);
  assert.deepEqual(result.manifestPaths, [path.join(availableDirectory, 'com.example.host.json')]);
  assert.equal(result.manifestWarnings.length, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.manifestPaths[0], 'utf8')),
    manifest,
  );
  assert.throws(function () {
    installNativeManifests([
      path.join(unavailableParent, 'another-directory'),
    ], 'com.example.host.json', manifest);
  }, /无法为任何受支持浏览器安装/);
  const collision = path.join(availableDirectory, 'collision.json');
  fs.mkdirSync(collision);
  assert.throws(() => installNativeManifests([availableDirectory], 'collision.json', manifest), /无法为任何/);
  assert.deepEqual(fs.readdirSync(availableDirectory).sort(), ['collision.json', 'com.example.host.json']);
});

test('profile routing and host request validation fail closed across tenants', () => {
  const config = {
    hostName: 'com.feishu_doc_helper.whiteboard',
    profileRules: [
      { hostSuffix: 'feishu.cn', pathPrefix: '/', profile: 'personal' },
      { hostSuffix: 'my.feishu.cn', pathPrefix: '/wiki/', profile: 'personal-wiki' },
      { hostSuffix: 'larkoffice.com', pathPrefix: '/', profile: 'corp' },
    ],
  };
  assert.equal(resolveProfile(config, 'https://bytedance.sg.larkoffice.com/docx/Doc1'), 'corp');
  assert.equal(resolveProfile(config, 'https://my.feishu.cn/wiki/Doc1'), 'personal-wiki');
  assert.equal(resolveProfile(config, 'https://team.feishu.cn/docx/Doc1'), 'personal');
  assert.equal(resolveProfile(config, 'https://feishu.cn.evil.example/docx/Doc1'), '');

  const base = {
    type: 'FEISHU_HELPER_WHITEBOARD_REQUEST',
    host: config.hostName,
  };
  assert.doesNotThrow(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'inspect', action: 'scan', sourceUrl: 'https://team.feishu.cn/docx/Doc1',
    }));
  });
  assert.throws(function () {
    validateRequest(config, Object.assign({}, base, {
      op: 'inspect', action: 'extract', sourceUrl: 'https://team.feishu.cn/docx/Doc1',
    }));
  });
  ['preflight', 'apply'].forEach(function (op) {
    assert.throws(function () {
      validateRequest(config, Object.assign({}, base, {
        op: op,
        action: 'paste',
        bundleId: BUNDLE_ID,
        targetUrl: 'https://team.feishu.cn/docx/Doc1',
      }));
    });
  });
});

test('LarkClient queries raw whiteboard nodes with the current CLI syntax', async () => {
  const client = new LarkClient({ binary: '/unused' });
  let exportArgs = null;
  client.run = async function () {
    exportArgs = Array.from(arguments[0]);
    return { ok: true, data: { msg: 'whiteboard has no nodes' } };
  };
  assert.deepEqual(await client.exportWhiteboard('empty_board_token'), []);
  assert.deepEqual(exportArgs, [
    'whiteboard', '+query', '--as', 'user', '--whiteboard-token', 'empty_board_token', '--output_as', 'raw',
  ]);
});
