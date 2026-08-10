#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const identity = require('../extension/extension-identity.json');
const protocol = require('../extension/shared/protocol.js');
const packageJson = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'FeishuDocHelper');
const RUNTIME_DIR = path.join(APP_SUPPORT, 'runtime');
const CONFIG_PATH = path.join(APP_SUPPORT, 'config.json');
const DATA_DIR = path.join(APP_SUPPORT, 'data');
const LAUNCHER_PATH = path.join(APP_SUPPORT, 'feishu-doc-helper-native-host');
const NATIVE_MANIFEST_NAME = protocol.NATIVE_MESSAGING.HOST_NAME + '.json';
const NATIVE_MANIFEST_DIRS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
];
const RUNTIME_FILES = [
  'native-host/host.cjs',
  'native-host/lark-client.cjs',
  'native-host/bundle-store.cjs',
  'native-host/transfer-service.cjs',
  'lib/feishu-whiteboard-transfer.cjs',
];
const PROFILE_RE = /^[A-Za-z0-9._-]{1,128}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

function computeExtensionId(publicKey) {
  const der = Buffer.from(String(publicKey || ''), 'base64');
  const hash = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
  return Array.from(hash).map(function (byte) {
    return String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  }).join('');
}

function parseMap(value) {
  const source = String(value || '');
  const separator = source.lastIndexOf('=');
  if (separator <= 0 || separator === source.length - 1) throw new Error('--map 格式应为 host[/path]=profile');
  const selector = source.slice(0, separator);
  const profile = source.slice(separator + 1);
  const slash = selector.indexOf('/');
  const hostSuffix = (slash === -1 ? selector : selector.slice(0, slash)).toLowerCase().replace(/^\*\./, '');
  const pathPrefix = slash === -1 ? '/' : selector.slice(slash);
  if (!HOST_RE.test(hostSuffix) || hostSuffix.startsWith('.') || hostSuffix.endsWith('.')
    || !pathPrefix.startsWith('/') || pathPrefix.length > 512 || !PROFILE_RE.test(profile)) {
    throw new Error('--map 包含无效的 host、path 或 profile');
  }
  return { hostSuffix: hostSuffix, pathPrefix: pathPrefix, profile: profile };
}

function parseArgs(argv) {
  const result = { maps: [], larkCliPath: '', chromeUserDataDirs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--map') {
      if (!argv[i + 1]) throw new Error('--map 缺少值');
      result.maps.push(parseMap(argv[++i]));
    } else if (arg === '--lark-cli') {
      if (!argv[i + 1]) throw new Error('--lark-cli 缺少路径');
      result.larkCliPath = argv[++i];
    } else if (arg === '--chrome-user-data-dir') {
      if (!argv[i + 1]) throw new Error('--chrome-user-data-dir 缺少路径');
      const userDataDir = path.resolve(argv[++i]);
      if (!path.isAbsolute(userDataDir) || userDataDir === path.parse(userDataDir).root) {
        throw new Error('--chrome-user-data-dir 必须是具体的绝对目录');
      }
      result.chromeUserDataDirs.push(userDataDir);
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error('未知参数：' + arg);
    }
  }
  return result;
}

function discoverLarkCli(explicitPath) {
  let candidate = explicitPath;
  if (!candidate) {
    const result = childProcess.spawnSync('which', ['lark-cli'], { encoding: 'utf8', shell: false });
    if (result.status !== 0 || !String(result.stdout || '').trim()) {
      throw new Error('未找到 lark-cli，请先安装并完成用户身份授权');
    }
    candidate = String(result.stdout).trim();
  }
  const resolved = fs.realpathSync(path.resolve(candidate));
  // npm installs expose scripts/run.js as the public launcher. It depends on
  // `env node` (missing from Chrome GUI PATH) and then creates a grandchild that
  // cannot be cancelled transactionally. Resolve the bundled native binary.
  if (path.basename(resolved) === 'run.js' && path.basename(path.dirname(resolved)) === 'scripts') {
    const nativeName = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli';
    const nativePath = path.resolve(path.dirname(resolved), '..', 'bin', nativeName);
    if (fs.existsSync(nativePath)) return fs.realpathSync(nativePath);
  }
  const header = fs.readFileSync(resolved).subarray(0, 2).toString('utf8');
  if (header === '#!') {
    throw new Error('lark-cli 路径仍是脚本包装器；请通过 --lark-cli 指向安装包 bin/lark-cli 原生可执行文件');
  }
  return resolved;
}

function discoverStableNodePath() {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch (error) {}
  }
  throw new Error('未找到可长期使用的 Node.js 可执行文件');
}

function validateConfiguredProfiles(larkCliPath, profileRules, runner) {
  const run = runner || childProcess.spawnSync;
  const profiles = Array.from(new Set((profileRules || []).map(function (rule) {
    return String(rule && rule.profile || '');
  }).filter(Boolean)));
  profiles.forEach(function (profile) {
    const result = run(larkCliPath, [
      'auth', 'status', '--json', '--verify', '--profile', profile,
    ], {
      encoding: 'utf8',
      shell: false,
      env: Object.assign({}, process.env, {
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      }),
    });
    let status = null;
    try { status = JSON.parse(String(result && result.stdout || '')); }
    catch (error) {}
    const user = status && status.identities && status.identities.user;
    if (!result || result.status !== 0 || !status || status.verified !== true
      || status.identity !== 'user' || !user || user.status !== 'ready'
      || user.available !== true || user.verified !== true) {
      throw new Error('CLI profile "' + profile
        + '" 不存在、未完成用户授权或登录已失效；请先用该 profile 完成 lark-cli 用户授权');
    }
  });
  return profiles;
}

function readExistingConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return value && value.schemaVersion === 1 ? value : null;
  } catch (error) {
    return null;
  }
}

function mergeRules(existingRules, incomingRules) {
  const bySelector = new Map();
  (existingRules || []).concat(incomingRules || []).forEach(function (rule) {
    if (!rule || !HOST_RE.test(String(rule.hostSuffix || '')) || !PROFILE_RE.test(String(rule.profile || ''))) return;
    const pathPrefix = String(rule.pathPrefix || '/');
    if (!pathPrefix.startsWith('/') || pathPrefix.length > 512) return;
    bySelector.set(String(rule.hostSuffix).toLowerCase() + '\0' + pathPrefix, {
      hostSuffix: String(rule.hostSuffix).toLowerCase(),
      pathPrefix: pathPrefix,
      profile: String(rule.profile),
    });
  });
  return Array.from(bySelector.values()).sort(function (left, right) {
    return (right.hostSuffix.length + right.pathPrefix.length)
      - (left.hostSuffix.length + left.pathPrefix.length);
  });
}

function writeAtomic(targetPath, contents, mode) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = targetPath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tempPath, contents, { mode: mode, flag: 'wx' });
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, targetPath);
}

function writeJsonAtomic(targetPath, value, mode) {
  writeAtomic(targetPath, JSON.stringify(value, null, 2) + '\n', mode);
}

function installNativeManifests(directories, manifestName, nativeManifest) {
  const manifestPaths = [];
  const manifestWarnings = [];
  directories.forEach(function (directory) {
    const target = path.join(directory, manifestName);
    try {
      writeJsonAtomic(target, nativeManifest, 0o644);
      manifestPaths.push(target);
    } catch (error) {
      manifestWarnings.push({
        targetPath: target,
        message: String(error && error.message || error),
      });
    }
  });
  if (!manifestPaths.length) {
    const details = manifestWarnings.map(function (warning) {
      return warning.targetPath + '：' + warning.message;
    }).join('；');
    throw new Error('无法为任何受支持浏览器安装 Native Host manifest' + (details ? '：' + details : ''));
  }
  return { manifestPaths: manifestPaths, manifestWarnings: manifestWarnings };
}

function replaceRuntime() {
  fs.mkdirSync(APP_SUPPORT, { recursive: true, mode: 0o700 });
  const staging = path.join(APP_SUPPORT, 'runtime.staging-' + process.pid);
  const previous = path.join(APP_SUPPORT, 'runtime.previous');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  RUNTIME_FILES.forEach(function (relativePath) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(staging, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  });
  if (fs.existsSync(RUNTIME_DIR)) fs.renameSync(RUNTIME_DIR, previous);
  try {
    fs.renameSync(staging, RUNTIME_DIR);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(RUNTIME_DIR) && fs.existsSync(previous)) fs.renameSync(previous, RUNTIME_DIR);
    throw error;
  }
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function install(options) {
  if (process.platform !== 'darwin') throw new Error('当前安装器仅支持 macOS');
  const calculatedId = computeExtensionId(identity.publicKey);
  if (calculatedId !== identity.extensionId) throw new Error('扩展固定身份校验失败');
  const existing = readExistingConfig();
  const profileRules = mergeRules(existing && existing.profileRules, options.maps);
  const larkCliPath = discoverLarkCli(options.larkCliPath || (existing && existing.larkCliPath));
  const stat = fs.statSync(larkCliPath);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('lark-cli 不可执行');
  validateConfiguredProfiles(larkCliPath, profileRules);

  replaceRuntime();
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const allowedOrigins = ['chrome-extension://' + identity.extensionId + '/'];
  writeJsonAtomic(CONFIG_PATH, {
    schemaVersion: 1,
    version: packageJson.version,
    hostName: protocol.NATIVE_MESSAGING.HOST_NAME,
    larkCliPath: larkCliPath,
    dataDir: DATA_DIR,
    allowedOrigins: allowedOrigins,
    profileRules: profileRules,
  }, 0o600);

  const installedHostPath = path.join(RUNTIME_DIR, 'native-host', 'host.cjs');
  const nodePath = discoverStableNodePath();
  const launcher = [
    '#!/bin/sh',
    'export FEISHU_HELPER_NATIVE_CONFIG=' + shellQuote(CONFIG_PATH),
    'exec ' + shellQuote(nodePath) + ' ' + shellQuote(installedHostPath) + ' "$@"',
    '',
  ].join('\n');
  writeAtomic(LAUNCHER_PATH, launcher, 0o700);

  const nativeManifest = {
    name: protocol.NATIVE_MESSAGING.HOST_NAME,
    description: '飞书文档助手画板跨账号迁移 Host',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };
  const customManifestDirs = (options.chromeUserDataDirs || []).map(function (userDataDir) {
    return path.join(userDataDir, 'NativeMessagingHosts');
  });
  const manifestResult = installNativeManifests(
    Array.from(new Set(NATIVE_MANIFEST_DIRS.concat(customManifestDirs))),
    NATIVE_MANIFEST_NAME,
    nativeManifest,
  );
  return {
    configPath: CONFIG_PATH,
    manifestPaths: manifestResult.manifestPaths,
    manifestWarnings: manifestResult.manifestWarnings,
    extensionId: identity.extensionId,
    profileRules: profileRules,
    version: packageJson.version,
  };
}

function printHelp() {
  process.stdout.write([
    '安装飞书文档助手 Native Host：',
    '  node native-host/install.cjs',
    '',
    '默认复用 lark-cli 当前用户身份。仅当不同域名必须使用不同 CLI profile 时，重复传入：',
    '  --map bytedance.sg.larkoffice.com=corp --map my.feishu.cn=personal',
    '',
    'Chrome 使用自定义 --user-data-dir 时，把同一目录显式传给安装器（可重复）：',
    '  --chrome-user-data-dir /absolute/path/to/chrome-profile',
    '',
  ].join('\n'));
}

module.exports = Object.freeze({
  computeExtensionId,
  discoverLarkCli,
  discoverStableNodePath,
  install,
  installNativeManifests,
  mergeRules,
  parseArgs,
  parseMap,
  replaceRuntime,
  shellQuote,
  validateConfiguredProfiles,
});

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const result = install(options);
      process.stdout.write('Native Host ' + result.version + ' 已安装，扩展 ID：' + result.extensionId + '\n');
      process.stdout.write(result.profileRules.length
        ? '已配置 ' + result.profileRules.length + ' 条账号映射。\n'
        : '未配置域名映射，将复用 lark-cli 当前用户身份。\n');
      result.manifestWarnings.forEach(function (warning) {
        process.stderr.write('浏览器 manifest 安装已跳过：' + warning.targetPath + '（' + warning.message + '）\n');
      });
    }
  } catch (error) {
    process.stderr.write('安装失败：' + String(error && error.message || error) + '\n');
    process.exitCode = 1;
  }
}
