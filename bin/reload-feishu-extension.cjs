#!/usr/bin/env node
'use strict';

// Best-effort reload for the unpacked Feishu helper extension in a running
// Chrome/Canary CDP session. Build should still succeed if the browser is not
// open, the extension target is asleep, or Chrome internals change.

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/feishu-extension/manifest.json'), 'utf8'));
const EXTENSION_ID = require('../extension/extension-identity.json').extensionId;
const PORT = Number(process.env.FEISHU_EXTENSION_CDP_PORT || process.env.CDP_PORT || 9223);
const HOST = process.env.FEISHU_EXTENSION_CDP_HOST || '127.0.0.1';

function requestJson(pathname) {
  return new Promise(function (resolve, reject) {
    const req = http.get({ host: HOST, port: PORT, path: pathname, timeout: 1200 }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('CDP timeout')); });
    req.on('error', reject);
  });
}

function cdpEval(target, expression) {
  return new Promise(function (resolve, reject) {
    if (typeof WebSocket !== 'function') {
      reject(new Error('global WebSocket is unavailable in this Node runtime'));
      return;
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(function () {
      try { ws.close(); } catch (error) {}
      reject(new Error('CDP evaluate timeout'));
    }, 2500);
    ws.addEventListener('open', function () {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    ws.addEventListener('message', function (event) {
      let message;
      try { message = JSON.parse(String(event.data || '')); }
      catch (error) { return; }
      if (message.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (error) {}
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result && message.result.result && message.result.result.value);
    });
    ws.addEventListener('error', function () {
      clearTimeout(timer);
      reject(new Error('CDP websocket error'));
    });
  });
}

function extensionIdFromTarget(target) {
  const match = String((target && target.url) || '').match(/^chrome-extension:\/\/([^/]+)/);
  return match ? match[1] : '';
}

function reloadFromExtensionTarget(target) {
  return cdpEval(target, 'setTimeout(function () { chrome.runtime.reload(); }, 50); true').then(function () {
    return 'reloaded via extension target ' + extensionIdFromTarget(target);
  });
}

function reloadFromExtensionsPage(target) {
  const expression = `(() => {
    const wantedId = ${JSON.stringify(EXTENSION_ID)};
    function walk(node) {
      if (!node) return [];
      const out = [];
      if (node.nodeType === 1) out.push(node);
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) out.push(...walk(children[i]));
      if (node.shadowRoot) out.push(...walk(node.shadowRoot));
      return out;
    }
    const nodes = walk(document);
    const item = nodes.find((el) => el.tagName && el.tagName.toLowerCase() === 'extensions-item'
      && String(el.id || el.getAttribute && el.getAttribute('id') || '') === wantedId);
    if (!item || !item.shadowRoot) return { ok: false, reason: 'extension item not found' };
    const reload = item.shadowRoot.querySelector('#dev-reload-button, cr-icon-button[title*="重新加载"], cr-icon-button[aria-label*="重新加载"], cr-icon-button[title*="Reload"], cr-icon-button[aria-label*="Reload"]');
    if (!reload) return { ok: false, reason: 'reload button not found' };
    reload.click();
    return { ok: true };
  })()`;
  return cdpEval(target, expression).then(function (result) {
    if (!result || !result.ok) throw new Error((result && result.reason) || 'reload click failed');
    return 'reloaded via chrome://extensions';
  });
}

async function main() {
  const targets = await requestJson('/json/list');
  const extensionTargets = targets.filter(function (target) {
    return target.webSocketDebuggerUrl
      && /^(?:page|service_worker|background_page)$/.test(String(target.type || ''))
      && /^chrome-extension:\/\//.test(String(target.url || ''));
  });
  for (const target of extensionTargets) {
    if (extensionIdFromTarget(target) === EXTENSION_ID) return reloadFromExtensionTarget(target);
  }

  const extensionsPage = targets.find(function (target) {
    return target.webSocketDebuggerUrl && String(target.url || '').startsWith('chrome://extensions');
  });
  if (extensionsPage) return reloadFromExtensionsPage(extensionsPage);

  throw new Error('no extension target or chrome://extensions page found');
}

if (require.main === module) {
  main().then(function (message) {
    console.log('[reload-feishu-extension] ' + message);
  }).catch(function (error) {
    console.warn('[reload-feishu-extension] skipped: ' + (error && error.message ? error.message : error));
    process.exitCode = 2;
  });
}

module.exports = { main: main };
