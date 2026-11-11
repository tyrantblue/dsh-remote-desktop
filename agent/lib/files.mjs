// Filesystem service for the remote agent.
//
// Every path is confined to a single root directory. Resolution is done both
// lexically and through realpath so that a symlink inside the root cannot be
// used to escape it. Failures are raised as FileError with a protocol error
// code from docs/PROTOCOL.md §2.
//
// Public API (per task-2):
//   class FileService {
//     constructor({root, readOnly=false});
//     async list(p); async stat(p); async createReadStream(p);
//     async writeStream(p, reqStream); async mkdir(p); async rename(from,to);
//     async remove(p, recursive);
//     resolveSafe(input);
//   }

import fs from 'node:fs';

const fsp = fs.promises;
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PROTOCOL_CODES = new Set([
  'no_token',
  'bad_token',
  'not_found',
  'is_directory',
  'not_directory',
  'exists',
  'permission_denied',
  'outside_root',
  'invalid_request',
  'too_large',
  'server_error',
]);

export class FileError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'FileError';
    this.code = PROTOCOL_CODES.has(code) ? code : 'server_error';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

const STATUS_BY_CODE = {
  no_token: 401,
  bad_token: 401,
  invalid_password: 401,
  rate_limited: 429,
  not_found: 404,
  is_directory: 400,
  not_directory: 400,
  exists: 409,
  permission_denied: 403,
  outside_root: 403,
  invalid_request: 400,
  too_large: 413,
  server_error: 500,
};

export function statusForCode(code) {
  return STATUS_BY_CODE[code] || 400;
}

function mapFsCode(code) {
  switch (code) {
    case 'ENOENT':
      return 'not_found';
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    case 'EEXIST':
      return 'exists';
    case 'EISDIR':
      return 'is_directory';
    case 'ENOTDIR':
      return 'not_directory';
    case 'ENOTEMPTY':
      return 'invalid_request';
    case 'ENAMETOOLONG':
    case 'ELOOP':
    case 'EINVAL':
      return 'invalid_request';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'too_large';
    default:
      return 'server_error';
  }
}

function wrapFsError(err, fallbackMessage) {
  if (err instanceof FileError) return err;
  const code = mapFsCode(err && err.code);
  const detail = err && err.message ? err.message : String(err);
  return new FileError(code, fallbackMessage ? `${fallbackMessage}: ${detail}` : detail, { cause: err });
}

function isInside(child, root) {
  if (child === root) return true;
  if (root === path.sep) return child.startsWith(path.sep);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(prefix);
}

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export class FileService {
  constructor({ root, readOnly = false } = {}) {
    if (!root || typeof root !== 'string') {
      throw new Error('FileService requires a root directory');
    }
    this.root = path.resolve(expandTilde(root));
    this.readOnly = Boolean(readOnly);
  }

  get rootPath() {
    return this.root;
  }

  // Resolve a client supplied path to a normalized absolute path that is
  // guaranteed to stay inside this.root, following symlinks for verification.
  // Returns the lexical (tilde-expanded, normalized) path, which is what the
  // rest of the service operates on.
  resolveSafe(input) {
    if (typeof input !== 'string') {
      throw new FileError('invalid_request', 'path must be a string');
    }
    if (input.length === 0) {
      throw new FileError('invalid_request', 'path must not be empty');
    }
    if (input.includes('\u0000')) {
      throw new FileError('invalid_request', 'path must not contain NUL bytes');
    }

    const expanded = expandTilde(input);
    if (!path.isAbsolute(expanded)) {
      throw new FileError('invalid_request', 'path must be absolute or start with ~');
    }
    const lexical = path.resolve(expanded);
    if (!isInside(lexical, this.root)) {
      throw new FileError('outside_root', `path is outside of ${this.root}`);
    }

    let rootReal;
    try {
      rootReal = fs.realpathSync(this.root);
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new FileError('not_found', 'filesystem root does not exist');
      throw wrapFsError(err, 'cannot resolve filesystem root');
    }

    // Walk up to the deepest existing ancestor, resolve it, and re-append the
    // missing tail. If any existing component is a symlink leaving the root,
    // the final real path fails the containment check.
    const tail = [];
    let current = lexical;
    let resolvedReal = null;
    for (let i = 0; i < 4096; i++) {
      try {
        const real = fs.realpathSync(current);
        resolvedReal = tail.length ? path.join(real, ...tail.reverse()) : real;
        break;
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
          const parent = path.dirname(current);
          if (parent === current) break;
          tail.push(path.basename(current));
          current = parent;
          continue;
        }
        throw wrapFsError(err, `cannot resolve path ${lexical}`);
      }
    }

    if (resolvedReal === null) {
      throw new FileError('not_found', `cannot resolve path ${lexical}`);
    }
    if (!isInside(resolvedReal, rootReal)) {
      throw new FileError('outside_root', `path escapes ${this.root}`);
    }
    return lexical;
  }

  async list(p) {
    const target = this.resolveSafe(p);
    let entries;
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      throw wrapFsError(err, `cannot list ${target}`);
    }

    const result = [];
    for (const dirent of entries) {
      let type;
      if (dirent.isDirectory()) type = 'dir';
      else if (dirent.isFile()) type = 'file';
      else if (dirent.isSymbolicLink()) type = 'symlink';
      else type = 'other';

      let size = 0;
      let mtimeMs = 0;
      try {
        const info = await fsp.lstat(path.join(target, dirent.name));
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        // A racing delete: keep the entry with neutral metadata.
      }
      result.push({ name: dirent.name, type, size, mtimeMs });
    }

    result.sort((a, b) => {
      const aDir = a.type === 'dir' ? 0 : 1;
      const bDir = b.type === 'dir' ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });

    return { path: target, parent: path.dirname(target), entries: result };
  }

  async stat(p) {
    const target = this.resolveSafe(p);
    let info;
    try {
      info = await fsp.stat(target);
    } catch (err) {
      throw wrapFsError(err, `cannot stat ${target}`);
    }
    const type = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other';
    return { path: target, type, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
  }

  async createReadStream(p) {
    const target = this.resolveSafe(p);
    let info;
    try {
      info = await fsp.stat(target);
    } catch (err) {
      throw wrapFsError(err, `cannot read ${target}`);
    }
    if (info.isDirectory()) {
      throw new FileError('is_directory', `cannot download a directory: ${target}`);
    }
    return fs.createReadStream(target);
  }

  async writeStream(p, reqStream) {
    if (this.readOnly) throw new FileError('permission_denied', 'filesystem is read-only');
    const target = this.resolveSafe(p);

    const parent = path.dirname(target);
    let parentInfo;
    try {
      parentInfo = await fsp.stat(parent);
    } catch (err) {
      throw wrapFsError(err, `parent directory does not exist: ${parent}`);
    }
    if (!parentInfo.isDirectory()) {
      throw new FileError('not_directory', `parent is not a directory: ${parent}`);
    }

    let existing = null;
    try {
      existing = await fsp.stat(target);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw wrapFsError(err, `cannot write ${target}`);
    }
    if (existing && existing.isDirectory()) {
      throw new FileError('is_directory', `target is a directory: ${target}`);
    }

    let out;
    try {
      out = fs.createWriteStream(target, { flags: 'w' });
    } catch (err) {
      throw wrapFsError(err, `cannot write ${target}`);
    }
    try {
      await pipeline(reqStream, out);
    } catch (err) {
      try {
        await fsp.unlink(target);
      } catch {
        /* best effort cleanup */
      }
      throw wrapFsError(err, 'upload failed');
    }
    let info;
    try {
      info = await fsp.stat(target);
    } catch {
      return { path: target, size: 0 };
    }
    return { path: target, size: info.size };
  }

  async mkdir(p) {
    if (this.readOnly) throw new FileError('permission_denied', 'filesystem is read-only');
    const target = this.resolveSafe(p);
    try {
      await fsp.mkdir(target);
    } catch (err) {
      throw wrapFsError(err, `cannot create directory ${target}`);
    }
    return { path: target };
  }

  async rename(from, to) {
    if (this.readOnly) throw new FileError('permission_denied', 'filesystem is read-only');
    const source = this.resolveSafe(from);
    const target = this.resolveSafe(to);
    try {
      await fsp.rename(source, target);
    } catch (err) {
      throw wrapFsError(err, `cannot rename ${source} to ${target}`);
    }
    return { from: source, to: target };
  }

  async remove(p, recursive = false) {
    if (this.readOnly) throw new FileError('permission_denied', 'filesystem is read-only');
    const target = this.resolveSafe(p);
    if (target === this.root) {
      throw new FileError('permission_denied', 'refusing to remove the filesystem root');
    }

    let info;
    try {
      info = await fsp.lstat(target);
    } catch (err) {
      throw wrapFsError(err, `cannot remove ${target}`);
    }

    try {
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (recursive) {
          await fsp.rm(target, { recursive: true, force: false });
        } else {
          await fsp.rmdir(target);
        }
      } else {
        await fsp.unlink(target);
      }
    } catch (err) {
      if (err && err.code === 'ENOTEMPTY') {
        throw new FileError('invalid_request', 'directory is not empty; pass recursive=true', { cause: err });
      }
      throw wrapFsError(err, `cannot remove ${target}`);
    }
    return { removed: target };
  }
}
