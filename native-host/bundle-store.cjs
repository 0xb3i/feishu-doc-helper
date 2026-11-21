'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const transfer = require('../lib/feishu-whiteboard-transfer.cjs');
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

function ensureInside(parent, candidate) {
  const root = path.resolve(parent) + path.sep;
  const resolved = path.resolve(candidate);
  if (resolved !== path.resolve(parent) && !resolved.startsWith(root)) {
    throw new Error('本地迁移路径越界');
  }
  return resolved;
}

function writeJsonAtomic(filePath, value) {
  // Bundle directories are created exactly once by create(). A delayed writer
  // must fail after discard, never resurrect a partially deleted bundle.
  const tempPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function isTargetLockActive(lockPath, now) {
  let owner = null;
  try { owner = readJson(path.join(lockPath, 'owner')); } catch (error) {}
  if (owner) {
    const heartbeatAt = Number(owner.heartbeatAt || owner.createdAt || 0);
    return heartbeatAt >= now - LOCK_STALE_AFTER_MS || isProcessAlive(owner.pid);
  }
  try { return fs.statSync(lockPath).mtimeMs >= now - LOCK_STALE_AFTER_MS; }
  catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function bundleBusyError() {
  const error = new Error('画板迁移正在执行或本地迁移状态正在更新，请稍后重试；若上次进程已中断，请重新提取源文档');
  error.code = 'FEISHU_BUNDLE_BUSY';
  return error;
}

function readLifecycleOwner(lockPath) {
  try { return fs.readlinkSync(lockPath); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function withBundleLifecycleLock(bundleDir, callback) {
  const lockPath = path.join(bundleDir, '.lifecycle.lock');
  const owner = process.pid + '-' + crypto.randomBytes(16).toString('hex');
  // A symlink atomically publishes both exclusion and ownership. Unlike a
  // mkdir + owner-file pair it cannot leave a half-written owner on a crash.
  try { fs.symlinkSync(owner, lockPath); }
  catch (error) {
    if (error && error.code === 'EEXIST') throw bundleBusyError();
    throw error;
  }
  try { return callback(); }
  finally {
    if (readLifecycleOwner(lockPath) === owner) fs.unlinkSync(lockPath);
  }
}

class BundleStore {
  constructor(options) {
    const opts = options || {};
    this.dataDir = path.resolve(String(opts.dataDir || ''));
    if (!path.isAbsolute(this.dataDir) || this.dataDir === path.parse(this.dataDir).root) {
      throw new Error('Native Host dataDir 必须是安全的绝对路径');
    }
    this.bundleRoot = path.join(this.dataDir, 'bundles');
    fs.mkdirSync(this.bundleRoot, { recursive: true, mode: 0o700 });
  }

  bundleDir(bundleId) {
    if (!transfer.BUNDLE_ID_RE.test(String(bundleId || ''))) throw new Error('bundleId 无效');
    return ensureInside(this.bundleRoot, path.join(this.bundleRoot, bundleId));
  }

  create(bundleId) {
    const dir = this.bundleDir(bundleId);
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: false, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'targets'), { recursive: false, mode: 0o700 });
    return dir;
  }

  saveBundle(bundle) {
    if (!bundle || !transfer.BUNDLE_ID_RE.test(String(bundle.id || ''))) throw new Error('bundle 数据无效');
    const filePath = path.join(this.bundleDir(bundle.id), 'bundle.json');
    writeJsonAtomic(filePath, bundle);
  }

  loadBundle(bundleId) {
    const filePath = path.join(this.bundleDir(bundleId), 'bundle.json');
    let bundle;
    try { bundle = readJson(filePath); }
    catch (error) { throw new Error('本地画板迁移包不存在或已损坏'); }
    if (!bundle || bundle.schemaVersion !== transfer.BUNDLE_SCHEMA_VERSION || bundle.id !== bundleId) {
      throw new Error('本地画板迁移包格式无效');
    }
    const expiresAt = Number(bundle.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      if (!this.hasActiveTargetLock(bundleId)) this.discard(bundleId);
      throw new Error('本地画板迁移包已过期，请重新提取源文档');
    }
    return bundle;
  }

  targetKey(bundleId, targetDocumentId) {
    return crypto.createHash('sha256')
      .update(String(bundleId) + '\0' + String(targetDocumentId))
      .digest('hex');
  }

  loadJournal(bundleId, targetDocumentId) {
    const key = this.targetKey(bundleId, targetDocumentId);
    const filePath = path.join(this.bundleDir(bundleId), 'targets', key + '.json');
    if (!fs.existsSync(filePath)) return null;
    try { return readJson(filePath); }
    catch (error) { throw new Error('目标迁移状态已损坏，请重新提取源文档'); }
  }

  saveJournal(bundleId, targetDocumentId, journal) {
    const key = this.targetKey(bundleId, targetDocumentId);
    const filePath = path.join(this.bundleDir(bundleId), 'targets', key + '.json');
    writeJsonAtomic(filePath, journal);
  }

  clearJournal(bundleId, targetDocumentId) {
    const key = this.targetKey(bundleId, targetDocumentId);
    const filePath = path.join(this.bundleDir(bundleId), 'targets', key + '.json');
    fs.rmSync(filePath, { force: true });
  }

  withTargetLock(bundleId, targetDocumentId, callback) {
    const key = this.targetKey(bundleId, targetDocumentId);
    const lockPath = path.join(this.bundleDir(bundleId), 'targets', key + '.lock');
    const ownerId = crypto.randomBytes(16).toString('hex');
    const ownerPath = path.join(lockPath, 'owner');
    const heartbeatIntervalMs = 30000;

    function ownerRecord(createdAt) {
      return { ownerId: ownerId, pid: process.pid, createdAt: createdAt, heartbeatAt: Date.now() };
    }

    function acquire() {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeJsonAtomic(ownerPath, ownerRecord(Date.now()));
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
    }

    function readCurrentOwner() {
      try { return readJson(ownerPath); }
      catch (error) { return null; }
    }

    function releaseIfOwner() {
      const current = readCurrentOwner();
      if (current && current.ownerId === ownerId) fs.rmSync(lockPath, { recursive: true, force: true });
    }
    withBundleLifecycleLock(this.bundleDir(bundleId), function () {
      try {
        acquire();
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        if (isTargetLockActive(lockPath, Date.now())) {
          throw new Error('同一目标文档已有画板迁移正在执行，请稍后重试');
        }
        // No competing acquisition or bundle deletion can run under the gate.
        fs.rmSync(lockPath, { recursive: true, force: true });
        acquire();
      }
    });

    const createdAt = Date.now();
    const heartbeat = setInterval(function () {
      const current = readCurrentOwner();
      if (!current || current.ownerId !== ownerId) return;
      try { writeJsonAtomic(ownerPath, ownerRecord(createdAt)); } catch (error) {}
    }, heartbeatIntervalMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    return Promise.resolve().then(callback).finally(function () {
      clearInterval(heartbeat);
      releaseIfOwner();
    });
  }

  hasActiveTargetLock(bundleId, now = Date.now()) {
    const targetsDir = path.join(this.bundleDir(bundleId), 'targets');
    let entries;
    try { entries = fs.readdirSync(targetsDir, { withFileTypes: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
    return entries.some(function (entry) {
      return entry.isDirectory() && entry.name.endsWith('.lock')
        && isTargetLockActive(path.join(targetsDir, entry.name), now);
    });
  }

  discard(bundleId, now = Date.now()) {
    const dir = this.bundleDir(bundleId);
    const retiredDir = path.join(this.bundleRoot, '.discarded-' + bundleId + '-' + crypto.randomBytes(8).toString('hex'));
    const retire = () => {
      if (this.hasActiveTargetLock(bundleId, now)) throw bundleBusyError();
      // Move the gate with the bundle. New acquisitions then fail with ENOENT
      // instead of slipping in while recursive deletion removes its children.
      fs.renameSync(dir, retiredDir);
    };
    try {
      withBundleLifecycleLock(dir, retire);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      if (!error || error.code !== 'FEISHU_BUNDLE_BUSY') throw error;
      const owner = readLifecycleOwner(path.join(dir, '.lifecycle.lock'));
      const match = owner && owner.match(/^([0-9]+)-[a-f0-9]{32}$/);
      if (!match || isProcessAlive(Number(match[1]))) throw error;
      // Never steal a crashed gate for further writes. Its immutable marker
      // blocks all new writers while we retire the whole abandoned bundle.
      try { retire(); }
      catch (retireError) {
        if (!retireError || retireError.code !== 'ENOENT') throw retireError;
      }
    }
    fs.rmSync(retiredDir, { recursive: true, force: true });
  }

  cleanupExpired(now) {
    const currentTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const entries = fs.readdirSync(this.bundleRoot, { withFileTypes: true });
    entries.forEach((entry) => {
      // A process may stop after retirement but before recursive removal.
      // These directories are unreachable to writers and contain no live lease.
      if (entry.isDirectory() && /^\.discarded-[a-f0-9]{64}-[a-f0-9]{16}$/.test(entry.name)) {
        fs.rmSync(path.join(this.bundleRoot, entry.name), { recursive: true, force: true });
        return;
      }
      if (!entry.isDirectory() || !transfer.BUNDLE_ID_RE.test(entry.name)) return;
      const dir = this.bundleDir(entry.name);
      const filePath = path.join(dir, 'bundle.json');
      let expiresAt = 0;
      try { expiresAt = Number(readJson(filePath).expiresAt || 0); }
      catch (error) {
        try { expiresAt = fs.statSync(dir).mtimeMs + transfer.BUNDLE_TTL_MS; }
        catch (statError) { expiresAt = 0; }
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
        try { this.discard(entry.name, currentTime); }
        catch (error) {
          if (!error || error.code !== 'FEISHU_BUNDLE_BUSY') throw error;
        }
      }
    });
  }
}

module.exports = {
  BundleStore,
  ensureInside,
  readJson,
  writeJsonAtomic,
};
