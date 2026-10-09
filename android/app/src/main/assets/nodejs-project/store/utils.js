// [xihanzu-NR]
'use strict';

const path = require('path');

/**
 * Resolves the Android app internal files directory (filesDir).
 * Supports explicit path, environment variables, or falls back to project parent.
 */
function resolveFilesDir(customDir) {
  if (customDir && typeof customDir === 'string') {
    return path.resolve(customDir);
  }
  if (process.env.NODEJS_STORAGE_PATH) {
    return path.resolve(process.env.NODEJS_STORAGE_PATH);
  }
  if (process.env.FILES_DIR) {
    return path.resolve(process.env.FILES_DIR);
  }
  if (process.env.ANDROID_FILES_DIR) {
    return path.resolve(process.env.ANDROID_FILES_DIR);
  }
  if (process.env.HOME) {
    const home = path.resolve(process.env.HOME);
    if (home.endsWith('nodejs-project') || home.endsWith('nodejs-project/')) {
      return path.dirname(home);
    }
    return home;
  }
  return process.cwd();
}

/**
 * Returns absolute path to session.sqlite in filesDir.
 */
function getSessionDbPath(filesDir) {
  const dir = resolveFilesDir(filesDir);
  return path.join(dir, 'session.sqlite');
}

/**
 * Returns absolute path to session.sqlite-wal in filesDir.
 */
function getWalDbPath(filesDir) {
  const dir = resolveFilesDir(filesDir);
  return path.join(dir, 'session.sqlite-wal');
}

/**
 * Decomposes Signal address object or JID string into user, server, device.
 */
function toSignalAddressParts(address) {
  if (!address) {
    return { user: '', server: 's.whatsapp.net', device: 0 };
  }
  if (typeof address === 'string') {
    const atIdx = address.indexOf('@');
    const jid = atIdx !== -1 ? address.slice(0, atIdx) : address;
    const server = atIdx !== -1 ? address.slice(atIdx + 1) : 's.whatsapp.net';
    const colonIdx = jid.indexOf(':');
    const dotIdx = jid.indexOf('.');
    const sepIdx = colonIdx !== -1 ? colonIdx : dotIdx;
    if (sepIdx !== -1) {
      const user = jid.slice(0, sepIdx);
      const device = parseInt(jid.slice(sepIdx + 1), 10) || 0;
      return { user, server, device };
    }
    return { user: jid, server, device: 0 };
  }
  return {
    user: String(address.user || ''),
    server: address.server || 's.whatsapp.net',
    device: typeof address.device === 'number' ? address.device : 0
  };
}

/**
 * Canonical lookup key for Signal address parts.
 */
function signalAddressKey(parts) {
  const p = toSignalAddressParts(parts);
  return `${p.user}.${p.device}@${p.server}`;
}

function asBytes(val, fieldName) {
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return Buffer.from(val);
  }
  if (typeof val === 'string') {
    return Buffer.from(val, 'base64');
  }
  if (Array.isArray(val)) {
    return Buffer.from(val);
  }
  throw new Error(`Expected bytes for ${fieldName}, received ${typeof val}`);
}

function asOptionalBytes(val) {
  if (val === null || val === undefined) return undefined;
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) return Buffer.from(val);
  if (typeof val === 'string') return Buffer.from(val, 'base64');
  if (Array.isArray(val)) return Buffer.from(val);
  return undefined;
}

function asString(val, fieldName) {
  if (typeof val === 'string') return val;
  if (val !== null && val !== undefined) return String(val);
  throw new Error(`Expected string for ${fieldName}, received ${typeof val}`);
}

function asOptionalString(val) {
  if (val === null || val === undefined) return undefined;
  return String(val);
}

function asNumber(val, fieldName) {
  const num = Number(val);
  if (!Number.isNaN(num)) return num;
  throw new Error(`Expected number for ${fieldName}, received ${val}`);
}

function asOptionalNumber(val) {
  if (val === null || val === undefined) return undefined;
  const num = Number(val);
  return Number.isNaN(num) ? undefined : num;
}

function toBoolOrUndef(val) {
  if (val === null || val === undefined) return undefined;
  return Number(val) === 1 || val === true;
}

function normalizeQueryLimit(limit, defaultLimit) {
  const n = Number(limit);
  if (!Number.isNaN(n) && n > 0) return Math.min(n, 1000);
  return defaultLimit || 50;
}

module.exports = {
  resolveFilesDir,
  getSessionDbPath,
  getWalDbPath,
  toSignalAddressParts,
  signalAddressKey,
  asBytes,
  asOptionalBytes,
  asString,
  asOptionalString,
  asNumber,
  asOptionalNumber,
  toBoolOrUndef,
  normalizeQueryLimit
};
