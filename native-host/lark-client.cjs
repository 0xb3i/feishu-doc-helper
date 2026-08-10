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

  canEditDocument(documentId) {
    const token = String(documentId || '');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) {
      return Promise.reject(new Error('目标文档 ID 无效'));
    }
    return this.run([
      'drive', 'permission.members', 'auth', '--as', 'user',
      '--type', 'docx', '--token', token, '--action', 'edit',
    ]).then(function (envelope) {
      return envelope && envelope.data && envelope.data.auth_result === true;
    });
  }

  exportWhiteboard(boardToken) {
    return this.run([
      'whiteboard', '+export', '--as', 'user', '--whiteboard-token', boardToken, '--output-type', 'raw',
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

  downloadMedia(token, outputPath, cwd) {
    return this.run([
      'docs', '+media-download', '--as', 'user', '--token', token,
      '--output', outputPath, '--overwrite',
    ], { cwd: cwd }).catch(() => this.run([
      'docs', '+media-preview', '--as', 'user', '--token', token,
      '--output', outputPath,
    ], { cwd: cwd }));
  }

  uploadWhiteboardMedia(options) {
    const opts = options || {};
    return this.run([
      'docs', '+media-upload', '--as', 'user',
      '--doc-id', opts.documentId,
      '--parent-node', opts.boardToken,
      '--parent-type', 'whiteboard',
      '--file', opts.file,
    ], { cwd: opts.cwd }).then(function (envelope) {
      const data = envelope && envelope.data || {};
      const token = data.file_token || data.token
        || data.media && (data.media.file_token || data.media.token)
        || data.file && (data.file.file_token || data.file.token);
      if (!token) throw new Error('目标画板图片上传成功但未返回 file_token');
      return String(token);
    });
  }

  updateWhiteboard(options) {
    const opts = options || {};
    const args = [
      'whiteboard', '+update', '--as', 'user',
      '--whiteboard-token', opts.boardToken,
      '--input_format', 'raw', '--source', '-', '--overwrite',
      '--idempotent-token', opts.idempotentToken,
    ];
    if (opts.dryRun) args.push('--dry-run');
    return this.run(args, {
      input: JSON.stringify({ nodes: opts.nodes || [] }),
      cwd: opts.cwd,
    }).then(function (envelope) {
      if (opts.dryRun) {
        const api = envelope && envelope.data && envelope.data.api;
        if (!Array.isArray(api) || !api.length
          || /parse input failed/i.test(String(envelope.data.description || ''))) {
          throw new Error('画板 raw 数据未通过 lark-cli dry-run 校验');
        }
      } else {
        const data = envelope && envelope.data;
        // The API currently returns `created_node_ids`, but its value is not a
        // one-to-one list for every raw node type. Require the documented
        // acknowledgement field here; completeness is proven separately by a
        // read-after-write export of the target board.
        if (!data || !Object.prototype.hasOwnProperty.call(data, 'created_node_ids')) {
          throw new Error('画板更新未返回节点确认');
        }
      }
      return envelope;
    });
  }

  updateDocument(options) {
    const opts = options || {};
    const revisionId = Number(opts.revisionId);
    if (!Number.isInteger(revisionId) || revisionId < 0) {
      return Promise.reject(new Error('文档结构写入必须绑定已读取的 revision_id'));
    }
    const args = [
      'docs', '+update', '--as', 'user', '--doc', opts.documentUrl,
      '--command', opts.command, '--block-id', opts.blockId,
      '--revision-id', String(revisionId),
    ];
    if (opts.content != null) args.push('--content', String(opts.content));
    if (opts.dryRun) args.push('--dry-run');
    return this.run(args, { cwd: opts.cwd }).then(function (envelope) {
      const result = envelope && envelope.data && envelope.data.result;
      if (!opts.dryRun && result !== 'success') {
        throw new Error('文档更新未完整成功：' + String(result || 'missing_result'));
      }
      return envelope;
    });
  }
}

module.exports = {
  LarkClient,
  formatCliError,
  killProcessTree,
  parseJsonEnvelope,
};
