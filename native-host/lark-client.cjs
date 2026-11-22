'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function parseJsonEnvelope(stdout, stderr) {
  const candidates = [stdout, stderr].map((value) => String(value || '').trim()).filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); }
    catch (error) {}
  }
  return null;
}

function formatCliError(envelope, fallback) {
  const error = envelope && envelope.error;
  const pieces = [];
  if (error && error.message) pieces.push(String(error.message));
  if (error && error.hint) pieces.push(String(error.hint));
  return pieces.join('；') || String(fallback || 'lark-cli 调用失败');
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {}
  }
  try { child.kill('SIGKILL'); } catch (error) {}
}

class LarkClient {
  constructor(options) {
    const opts = options || {};
    this.binary = String(opts.binary || 'lark-cli');
    this.profile = String(opts.profile || '');
    this.timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.maxOutputBytes = Number(opts.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
  }

  run(args, options) {
    const opts = options || {};
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (this.profile) argv.push('--profile', this.profile);
    const binary = this.binary;
    const timeoutMs = Number(opts.timeoutMs || this.timeoutMs);
    const maxOutputBytes = Number(opts.maxOutputBytes || this.maxOutputBytes);
    const cwd = opts.cwd;
    const input = opts.input == null ? null : String(opts.input);

    return new Promise(function (resolve, reject) {
      const child = spawn(binary, argv, {
        cwd: cwd,
        env: Object.assign({}, process.env, {
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        }),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminatingError = null;

      function terminateAfterClose(error) {
        if (settled || terminatingError) return;
        terminatingError = error;
        clearTimeout(timer);
        killProcessTree(child);
      }

      const timer = setTimeout(function () {
        terminateAfterClose(new Error('lark-cli 调用超时'));
      }, timeoutMs);

      function collect(target, chunk, kind) {
        const size = Buffer.byteLength(chunk);
        if (kind === 'stdout') stdoutBytes += size;
        else stderrBytes += size;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          terminateAfterClose(new Error('lark-cli 输出超过安全上限'));
          return;
        }
        if (terminatingError) return;
        target.push(Buffer.from(chunk));
      }

      child.stdout.on('data', function (chunk) { collect(stdout, chunk, 'stdout'); });
      child.stderr.on('data', function (chunk) { collect(stderr, chunk, 'stderr'); });
      child.on('error', function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(terminatingError || new Error('无法启动 lark-cli：' + String(error && error.message || error)));
      });
      child.on('close', function (code) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminatingError) {
          reject(terminatingError);
          return;
        }
        const stdoutText = Buffer.concat(stdout).toString('utf8');
        const stderrText = Buffer.concat(stderr).toString('utf8');
        const envelope = parseJsonEnvelope(stdoutText, stderrText);
        if (code !== 0 || !envelope || envelope.ok !== true) {
          reject(new Error(formatCliError(envelope, 'lark-cli 退出码 ' + String(code))));
          return;
        }
        resolve(envelope);
      });

      if (input !== null) child.stdin.end(input);
      else child.stdin.end();
      child.stdin.on('error', function () {});
    });
  }

  fetchDocument(documentUrl) {
    return this.run([
      'docs', '+fetch', '--as', 'user', '--detail', 'with-ids', '--doc', documentUrl,
    ]).then(function (envelope) {
      const document = envelope && envelope.data && envelope.data.document;
      if (!document || typeof document.content !== 'string' || !document.document_id) {
        throw new Error('lark-cli 未返回完整文档结构');
      }
      return document;
    });
  }

  exportWhiteboard(boardToken) {
    return this.run([
      'whiteboard', '+query', '--as', 'user', '--whiteboard-token', boardToken, '--output_as', 'raw',
    ]).then(function (envelope) {
      const data = envelope && envelope.data;
      const nodes = data && data.nodes;
      if (!Array.isArray(nodes)) {
        // The OpenAPI returns an informational `msg` instead of `nodes: []`
        // for a new or genuinely empty whiteboard. Treat only that successful
        // shape as empty; every other malformed response still fails closed.
        if (data && typeof data.msg === 'string' && data.msg.trim()) return [];
        throw new Error('lark-cli 未返回画板 raw nodes');
      }
      return nodes;
    });
  }
}

module.exports = {
  LarkClient,
  formatCliError,
  killProcessTree,
  parseJsonEnvelope,
};
