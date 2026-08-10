#!/usr/bin/env node
'use strict';

// Build helper for the Feishu browser extension (Manifest V3).
//
// The extension is fully self-contained.  Maintainable sources live in
// `lib/feishu-*.cjs` (pure helpers) and `src/feishu-runtime/*` (page runtime);
// this script inlines them into a single MAIN-world content script and wires
// up the popup build via Vite.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');
const protocol = require('../extension/shared/protocol.js');
const extensionIdentity = require('../extension/extension-identity.json');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/feishu-extension');
const MATCHES = protocol.buildDocumentMatchPatterns();

// 图片 CDN 域：service worker 需要对这些域有 host 权限，才能跨域抓取图片字节
// （绕开页面 CORS，模拟浏览器原生"复制图片"的行为）。不注入内容脚本。
const IMAGE_HOSTS = protocol.CDN_HOST_SUFFIXES.map(function (host) {
  return 'https://*.' + host + '/*';
}).concat(protocol.DOCUMENT_HOST_SUFFIXES.map(function (host) {
  return 'https://*.' + host + '/space/api/box/stream/download/*';
})).concat(protocol.DOCUMENT_HOST_SUFFIXES.map(function (host) {
  return 'https://*.' + host + '/space/api/file/f/cdp-chart-*';
}));

// Pure helper modules (CommonJS) shared by the page runtime.  Each must end
// with a `module.exports` assignment; they are exposed to the runtime through
// the `FeishuHelperLibs` container.
const LIB_MODULES = [
  'lib/feishu-attribs.cjs',
  'lib/feishu-style-codec.cjs',
  'lib/feishu-html-sanitizer.cjs',
  'lib/feishu-docx-record.cjs',
  'lib/feishu-block-render.cjs',
  'lib/feishu-semantic-snapshot.cjs',
  'lib/feishu-native-clipboard-transform.cjs',
];

function discoverRuntimeParts() {
  const runtimeDir = path.join(ROOT, 'src/feishu-runtime');
  return fs.readdirSync(runtimeDir)
    .filter(function (fileName) { return /^\d{2}-[a-z0-9-]+\.js$/.test(fileName); })
    .sort()
    .map(function (fileName) { return 'src/feishu-runtime/' + fileName; });
}

function validateRuntimeParts(runtimeParts) {
  if (!runtimeParts.length) throw new Error('no runtime modules were discovered');
  const declarations = new Map();
  runtimeParts.forEach(function (relativePath) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const patterns = [
      /^  function\s+([A-Za-z_$][\w$]*)/gm,
      /^  var\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/gm,
    ];
    patterns.forEach(function (pattern) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const previous = declarations.get(match[1]);
        if (previous) {
          throw new Error('duplicate runtime symbol ' + match[1] + ' in ' + previous + ' and ' + relativePath);
        }
        declarations.set(match[1], relativePath);
      }
    });
  });
  return runtimeParts;
}

function moduleNameFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/^feishu-/, '')
    .replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
}

function indentSource(source, spaces) {
  const indent = ' '.repeat(spaces);
  return source.split('\n').map(function (line) {
    return line ? indent + line : line;
  }).join('\n');
}

// Wrap each CJS lib so its `module.exports` is exposed via FeishuHelperLibs.
function inlineLibSources() {
  const wrappers = LIB_MODULES.map(function (relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    const source = fs.readFileSync(absolutePath, 'utf8');
    const moduleName = moduleNameFromPath(relativePath);
    return [
      '  // ── ' + relativePath + ' ──',
      '  FeishuHelperLibs.' + moduleName + ' = (function () {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
      '    (function () {',
      indentSource(source, 6),
      '    })();',
      '    return module.exports;',
      '  })();',
    ].join('\n');
  });

  return [
    '  var FeishuHelperLibs = {};',
    wrappers.join('\n\n'),
  ].join('\n');
}

function inlineRuntimeSources(version) {
  return validateRuntimeParts(discoverRuntimeParts()).map(function (relativePath) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
      .replace(/__FEISHU_HELPER_VERSION__/g, version)
      .replace(/\s+$/, '');
    return [
      '  // ── ' + relativePath + ' ──',
      source,
    ].join('\n');
  }).join('\n\n');
}

function copyFile(relativePath, targetRelativePath, outputDir) {
  const source = path.join(ROOT, relativePath);
  const target = path.join(outputDir, targetRelativePath || relativePath.replace(/^extension\//, ''));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function writeJson(relativePath, value, outputDir) {
  const target = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function validateManifestVersion(value) {
  const version = String(value || '');
  const parts = version.split('.');
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version)
    || parts.some(function (part) { return Number(part) > 65535; })) {
    throw new Error('package.json version must be a Chrome-compatible 1-4 part numeric version');
  }
  return version;
}

function buildMainWorldScript(version) {
  const runtimeVersion = validateManifestVersion(version || require('../package.json').version);
  return [
    '(function () {',
    "  'use strict';",
    '',
    "  if (window.__feishuHelperRuntime && typeof window.__feishuHelperRuntime.dispose === 'function') {",
    "    try { window.__feishuHelperRuntime.dispose(); }",
    "    catch (error) { console.warn('[Feishu Helper] previous runtime dispose failed', error); }",
    '  }',
    '',
    inlineLibSources(),
    '',
    inlineRuntimeSources(runtimeVersion),
    '',
    '})();',
    '',
  ].join('\n');
}

function buildManifest(packageJson) {
  const version = validateManifestVersion(packageJson && packageJson.version);
  return {
    manifest_version: 3,
    minimum_chrome_version: '111',
    name: '飞书文档助手',
    version: version,
    key: extensionIdentity.publicKey,
    description: '飞书文档复制、粘贴与图片提取菜单',
    permissions: [
      'storage',
      'unlimitedStorage',
      'contextMenus',
      'commands',
      'alarms',
      'nativeMessaging',
      'clipboardRead',
      'clipboardWrite',
    ],
    host_permissions: Array.from(new Set(MATCHES.concat(IMAGE_HOSTS))),
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: '飞书文档助手',
      default_popup: 'ui/popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    background: {
      service_worker: 'background/service-worker.js',
    },
    content_scripts: [
      {
        matches: MATCHES,
        js: ['content/main-world.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        matches: MATCHES,
        js: ['shared/protocol.js', 'shared/image-clipboard.js', 'content/bridge.js'],
        run_at: 'document_start',
      },
    ],
    commands: {
      'feishu-extract': {
        suggested_key: { default: 'Ctrl+Shift+D', mac: 'Command+Shift+D' },
        description: '提取当前飞书文档',
      },
      'feishu-paste': {
        suggested_key: { default: 'Ctrl+Shift+P', mac: 'Command+Shift+P' },
        description: '粘贴已提取的飞书文档副本',
      },
      'feishu-snapshot': {
        description: '刷新飞书文档页面快照',
      },
    },
  };
}

function runViteBuild(outputDir) {
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const result = spawnSync(process.execPath, [
    viteBin,
    'build',
    '--config',
    path.join(ROOT, 'extension/vite.config.mjs'),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      FEISHU_EXTENSION_UI_OUT_DIR: path.join(outputDir, 'ui'),
    }),
  });
  if (result.status !== 0) {
    throw new Error((result.stdout || '') + (result.stderr || ''));
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function reloadExtensionAfterBuild() {
  if (process.env.FEISHU_EXTENSION_SKIP_RELOAD === '1') {
    console.log('[build-feishu-extension] skipped extension reload by FEISHU_EXTENSION_SKIP_RELOAD=1');
    return;
  }

  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/reload-feishu-extension.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : 'exit code ' + result.status;
    console.warn('[build-feishu-extension] extension reload skipped: ' + reason);
  }
}

function validateBuildOutput(outputDir, expectedVersion) {
  const requiredFiles = [
    'manifest.json',
    'shared/protocol.js',
    'content/main-world.js',
    'content/bridge.js',
    'background/service-worker.js',
    'ui/popup.html',
  ];
  requiredFiles.forEach(function (relativePath) {
    if (!fs.existsSync(path.join(outputDir, relativePath))) {
      throw new Error('build output is missing ' + relativePath);
    }
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== expectedVersion) throw new Error('manifest version does not match package version');
  const mainWorld = fs.readFileSync(path.join(outputDir, 'content/main-world.js'), 'utf8');
  if (mainWorld.includes('__FEISHU_HELPER_VERSION__') || !mainWorld.includes("var SCRIPT_VERSION = '" + expectedVersion + "'")) {
    throw new Error('runtime version was not injected from package.json');
  }
  new vm.Script(mainWorld, { filename: 'content/main-world.js' });
}

function replaceBuildOutput(stagingDir) {
  const backupDir = DIST + '.previous';
  fs.rmSync(backupDir, { recursive: true, force: true });
  if (fs.existsSync(DIST)) fs.renameSync(DIST, backupDir);
  try {
    fs.renameSync(stagingDir, DIST);
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(DIST) && fs.existsSync(backupDir)) fs.renameSync(backupDir, DIST);
    throw error;
  }
}

function build() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = validateManifestVersion(packageJson.version);
  const stagingDir = DIST + '.staging';
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingDir, 'content'), { recursive: true });

  try {
    writeJson('manifest.json', buildManifest(packageJson), stagingDir);
    fs.writeFileSync(path.join(stagingDir, 'content/main-world.js'), buildMainWorldScript(version));
    copyFile('extension/shared/protocol.js', 'shared/protocol.js', stagingDir);
    copyFile('extension/shared/image-clipboard.js', 'shared/image-clipboard.js', stagingDir);
    copyFile('extension/content/bridge.js', 'content/bridge.js', stagingDir);
    copyFile('extension/background/service-worker.js', 'background/service-worker.js', stagingDir);
    ['16', '32', '48', '128'].forEach(function (size) {
      copyFile('extension/icons/icon-' + size + '.png', 'icons/icon-' + size + '.png', stagingDir);
    });
    runViteBuild(stagingDir);
    validateBuildOutput(stagingDir, version);
    replaceBuildOutput(stagingDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  console.log('[build-feishu-extension] wrote ' + path.relative(ROOT, DIST));
  reloadExtensionAfterBuild();
}

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error('[build-feishu-extension] failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  build: build,
  buildMainWorldScript: buildMainWorldScript,
  buildManifest: buildManifest,
  discoverRuntimeParts: discoverRuntimeParts,
  reloadExtensionAfterBuild: reloadExtensionAfterBuild,
  validateRuntimeParts: validateRuntimeParts,
  validateManifestVersion: validateManifestVersion,
};
