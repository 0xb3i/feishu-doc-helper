'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const transfer = require('../lib/feishu-whiteboard-transfer.cjs');

function ensureInside(parent, candidate) {
  const root = path.resolve(parent) + path.sep;
  const resolved = path.resolve(candidate);
  if (resolved !== path.resolve(parent) && !resolved.startsWith(root)) {
    throw new Error('本地迁移路径越界');
  }
  return resolved;
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tempPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
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
      this.discard(bundleId);
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
    const staleAfterMs = 10 * 60 * 1000;

    function ownerRecord(createdAt) {
      return { ownerId: ownerId, pid: process.pid, createdAt: createdAt, heartbeatAt: Date.now() };
    }

    function acquire() {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      writeJsonAtomic(ownerPath, ownerRecord(Date.now()));
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

    function readCurrentOwner() {
      try { return readJson(ownerPath); }
      catch (error) { return null; }
    }

    function releaseIfOwner() {
      const current = readCurrentOwner();
      if (current && current.ownerId === ownerId) fs.rmSync(lockPath, { recursive: true, force: true });
    }
    try {
      acquire();
    } catch (error) {
      let stale = false;
      const owner = readCurrentOwner();
      if (owner) {
        const heartbeatAt = Number(owner && (owner.heartbeatAt || owner.createdAt) || 0);
        stale = heartbeatAt < Date.now() - staleAfterMs && !isProcessAlive(owner && owner.pid);
      } else {
        try { stale = fs.statSync(lockPath).mtimeMs < Date.now() - staleAfterMs; }
        catch (statError) { stale = false; }
      }
      if (!stale) throw new Error('同一目标文档已有画板迁移正在执行，请稍后重试');
      const quarantinePath = lockPath + '.stale-' + ownerId;
      try {
        fs.renameSync(lockPath, quarantinePath);
      } catch (renameError) {
        throw new Error('同一目标文档的迁移锁状态已变化，请稍后重试');
      }
      try {
        acquire();
      } finally {
        fs.rmSync(quarantinePath, { recursive: true, force: true });
      }
    }

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

  discard(bundleId) {
    const dir = this.bundleDir(bundleId);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  cleanupExpired(now) {
    const currentTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const entries = fs.readdirSync(this.bundleRoot, { withFileTypes: true });
    entries.forEach((entry) => {
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
        const targetsDir = path.join(dir, 'targets');
        let hasActiveLock = false;
        try {
          const locks = fs.readdirSync(targetsDir, { withFileTypes: true })
            .filter((item) => item.isDirectory() && item.name.endsWith('.lock'));
          hasActiveLock = locks.some(function (lock) {
            const lockDir = path.join(targetsDir, lock.name);
            let owner = null;
            try { owner = readJson(path.join(lockDir, 'owner')); } catch (error) {}
            const heartbeatAt = Number(owner && (owner.heartbeatAt || owner.createdAt) || 0);
            if (heartbeatAt >= currentTime - 10 * 60 * 1000) return true;
            const pid = Number(owner && owner.pid);
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); return true; }
              catch (error) { if (error && error.code === 'EPERM') return true; }
            }
            if (!owner) {
              try { return fs.statSync(lockDir).mtimeMs >= currentTime - 10 * 60 * 1000; }
              catch (error) { return false; }
            }
            return false;
          });
        } catch (error) {}
        if (hasActiveLock) return;
        fs.rmSync(dir, { recursive: true, force: true });
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
