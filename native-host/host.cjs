'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LarkClient } = require('./lark-client.cjs');
const { BundleStore } = require('./bundle-store.cjs');
const { TransferService } = require('./transfer-service.cjs');
const transfer = require('../lib/feishu-whiteboard-transfer.cjs');

const MAX_NATIVE_REQUEST_BYTES = 1024 * 1024;
const MAX_NATIVE_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TYPE = 'FEISHU_HELPER_WHITEBOARD_REQUEST';

function loadConfig() {
  const configPath = String(process.env.FEISHU_HELPER_NATIVE_CONFIG || '');
  if (!configPath || !path.isAbsolute(configPath)) throw new Error('Native Host 配置路径无效');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || !path.isAbsolute(String(config.larkCliPath || ''))
    || !path.isAbsolute(String(config.dataDir || '')) || !Array.isArray(config.allowedOrigins)
    || !config.allowedOrigins.length || typeof config.hostName !== 'string'
    || (config.profileRules != null && !Array.isArray(config.profileRules))) {
    throw new Error('Native Host 配置无效');
  }
  return config;
}

function resolveProfile(config, documentUrl) {
  const rules = Array.isArray(config.profileRules) ? config.profileRules : [];
  if (!documentUrl) return '';
  const url = new URL(documentUrl);
  const matching = rules.filter(function (rule) {
    const suffix = String(rule && rule.hostSuffix || '').toLowerCase();
    const pathPrefix = String(rule && rule.pathPrefix || '/');
    return /^[A-Za-z0-9.-]{1,253}$/.test(suffix)
      && /^[A-Za-z0-9._-]{1,128}$/.test(String(rule.profile || ''))
      && (url.hostname.toLowerCase() === suffix || url.hostname.toLowerCase().endsWith('.' + suffix))
      && url.pathname.startsWith(pathPrefix);
  }).sort(function (left, right) {
    return (String(right.hostSuffix).length + String(right.pathPrefix || '/').length)
      - (String(left.hostSuffix).length + String(left.pathPrefix || '/').length);
  });
  return matching.length ? String(matching[0].profile) : '';
}

function validateChromeOrigin(config) {
  const origin = String(process.argv[2] || '');
  if (!config.allowedOrigins.includes(origin)) throw new Error('Native Host 调用来源未授权');
}

function validateRequest(config, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Native 请求格式无效');
  if (request.type !== REQUEST_TYPE || request.host !== config.hostName) throw new Error('Native 请求类型无效');
  const allowed = new Set(['type', 'host', 'op', 'action', 'bundleId', 'sourceUrl', 'targetUrl', 'images']);
  Object.keys(request).forEach(function (key) {
    if (!allowed.has(key)) throw new Error('Native 请求包含不支持的字段');
  });
  const hasOwn = Object.prototype.hasOwnProperty;
  if (!hasOwn.call(request, 'type') || !hasOwn.call(request, 'host')
    || !hasOwn.call(request, 'op') || !hasOwn.call(request, 'action')) {
    throw new Error('Native 请求信封不完整');
  }
  const hasBundleId = hasOwn.call(request, 'bundleId');
  const hasSourceUrl = hasOwn.call(request, 'sourceUrl');
  const hasTargetUrl = hasOwn.call(request, 'targetUrl');
  if (request.op === 'inspect') {
    if (request.action !== 'scan' || !hasSourceUrl || !transfer.isSupportedDocumentUrl(request.sourceUrl)
      || hasBundleId || hasTargetUrl) {
      throw new Error('Native inspect 请求无效');
    }
    return;
  }
  if (request.op === 'copyPermission') {
    if (request.action !== 'extract' || !hasSourceUrl || !transfer.isSupportedDocumentUrl(request.sourceUrl)
      || hasBundleId || hasTargetUrl) {
      throw new Error('Native copy permission 请求无效');
    }
    return;
  }
  if (request.op === 'export') {
    if (request.action !== 'extract' || !hasSourceUrl || !transfer.isSupportedDocumentUrl(request.sourceUrl)
      || hasBundleId || hasTargetUrl) {
      throw new Error('Native export 请求无效');
    }
    return;
  }
  if (request.op === 'preflight' || request.op === 'apply') {
    if (request.action !== 'paste' || !hasBundleId || !transfer.BUNDLE_ID_RE.test(String(request.bundleId || ''))
      || !hasTargetUrl || !transfer.isSupportedDocumentUrl(request.targetUrl) || hasSourceUrl) {
      throw new Error('Native 目标请求无效');
    }
    return;
  }
  if (request.op === 'reconcileImages') {
    if (request.action !== 'paste' || hasBundleId || hasSourceUrl || !hasTargetUrl
      || !transfer.isSupportedDocumentUrl(request.targetUrl)
      || !Array.isArray(request.images) || !request.images.length || request.images.length > 500) {
      throw new Error('Native 图片归位请求无效');
    }
    const markers = new Set();
    const stagingIds = new Set();
    request.images.forEach(function (image) {
      if (!image || typeof image !== 'object' || Array.isArray(image)
        || Object.keys(image).some((key) => !['marker', 'targetToken', 'stagingBlockId'].includes(key))
        || !/^\[\[FEISHU_HELPER_IMAGE:[a-z0-9]+:[0-9]{4}\]\]$/.test(String(image.marker || ''))
        || !transfer.RESOURCE_TOKEN_RE.test(String(image.targetToken || ''))
        || !transfer.BLOCK_ID_RE.test(String(image.stagingBlockId || ''))
        || markers.has(image.marker) || stagingIds.has(image.stagingBlockId)) {
        throw new Error('Native 图片归位绑定无效');
      }
      markers.add(image.marker);
      stagingIds.add(image.stagingBlockId);
    });
    return;
  }
  if (request.op === 'discard') {
    if (request.action !== 'extract' || !hasBundleId
      || !transfer.BUNDLE_ID_RE.test(String(request.bundleId || ''))
      || hasSourceUrl || hasTargetUrl) {
      throw new Error('Native discard 请求无效');
    }
    return;
  }
  throw new Error('Native 请求操作不受支持');
}

function sanitizeErrorMessage(error) {
  return String(error && error.message || error || 'Native Host 执行失败')
    .replace(/(access[_-]?token|authorization|bearer)\s*[:=]\s*[^\s;,]+/gi, '$1=[已隐藏]')
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, '[长标识已隐藏]')
    .slice(0, 2000);
}

function createHandler(config) {
  const store = new BundleStore({ dataDir: config.dataDir });
  const services = new Map();

  function serviceFor(documentUrl) {
    const profile = resolveProfile(config, documentUrl);
    if (!services.has(profile)) {
      services.set(profile, new TransferService({
        client: new LarkClient({ binary: config.larkCliPath, profile: profile }),
        store: store,
      }));
    }
    return services.get(profile);
  }

  return async function handle(request) {
    validateRequest(config, request);
    if (request.op === 'inspect') return serviceFor(request.sourceUrl).inspectSource(request.sourceUrl);
    if (request.op === 'copyPermission') {
      return serviceFor(request.sourceUrl).inspectCopyPermission(request.sourceUrl);
    }
    if (request.op === 'export') return serviceFor(request.sourceUrl).exportSource(request.sourceUrl);
    if (request.op === 'preflight') return serviceFor(request.targetUrl).preflight(request.bundleId, request.targetUrl);
    if (request.op === 'apply') return serviceFor(request.targetUrl).apply(request.bundleId, request.targetUrl);
    if (request.op === 'reconcileImages') {
      return serviceFor(request.targetUrl).reconcileImages(request.images, request.targetUrl);
    }
    if (request.op === 'discard') {
      store.discard(request.bundleId);
      return { discarded: true };
    }
    throw new Error('Native 请求操作不受支持');
  };
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_NATIVE_RESPONSE_BYTES) {
    throw new Error('Native Host 响应超过 1MiB 上限');
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

function startNativeMessagingHost() {
  let config;
  let handler;
  try {
    config = loadConfig();
    validateChromeOrigin(config);
    handler = createHandler(config);
  } catch (error) {
    process.stderr.write('[feishu-doc-helper-native] ' + sanitizeErrorMessage(error) + '\n');
    process.exitCode = 1;
    return;
  }

  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  process.stdin.on('data', function (chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_NATIVE_REQUEST_BYTES) {
        process.stderr.write('[feishu-doc-helper-native] Native 请求长度无效\n');
        process.exitCode = 1;
        process.stdin.destroy();
        return;
      }
      if (buffer.length < length + 4) return;
      const payload = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      chain = chain.then(async function () {
        try {
          const request = JSON.parse(payload.toString('utf8'));
          const result = await handler(request);
          writeNativeMessage({ ok: true, data: result || null });
        } catch (error) {
          writeNativeMessage({ ok: false, error: sanitizeErrorMessage(error) });
        }
      });
    }
  });
  process.stdin.on('end', function () {
    chain.catch(function (error) {
      process.stderr.write('[feishu-doc-helper-native] ' + sanitizeErrorMessage(error) + '\n');
      process.exitCode = 1;
    });
  });
}

if (require.main === module) startNativeMessagingHost();

module.exports = {
  REQUEST_TYPE,
  createHandler,
  loadConfig,
  sanitizeErrorMessage,
  startNativeMessagingHost,
  resolveProfile,
  validateRequest,
  writeNativeMessage,
};
