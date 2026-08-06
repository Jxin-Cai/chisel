import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const TRANSACTION_DIR = '.transactions';
const TRANSACTION_LOCK = '.file-transaction.lock';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function safeRelative(root, path) {
  const base = resolve(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, target).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error(`transaction target escapes root: ${path}`);
  return rel;
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is unavailable on some platforms. File fsync still applies.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function durableAtomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, 'wx');
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(path, staleMs = 10 * 60 * 1000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
      fsyncSync(fd);
      return fd;
    } catch {
      if (attempt > 0) break;
      let stale = false;
      try {
        const lock = JSON.parse(readFileSync(path, 'utf8'));
        const ageMs = Date.now() - new Date(lock.created_at).getTime();
        stale = !processIsAlive(Number(lock.pid)) || !Number.isFinite(ageMs) || ageMs > staleMs;
      } catch {
        stale = true;
      }
      if (!stale) break;
      try { unlinkSync(path); } catch { break; }
    }
  }
  return null;
}

function transactionDirectory(root) {
  return join(root, TRANSACTION_DIR);
}

function journalPath(root, id) {
  const safeId = String(id || randomUUID()).replace(/[^A-Za-z0-9._-]/g, '-');
  return join(transactionDirectory(root), `${safeId}.json`);
}

function normalizeWrites(root, writes) {
  if (!Array.isArray(writes) || writes.length === 0) throw new Error('transaction requires at least one write');
  const seen = new Set();
  return writes.map(write => {
    const path = safeRelative(root, write.path);
    if (seen.has(path)) throw new Error(`duplicate transaction target: ${path}`);
    seen.add(path);
    const content = Buffer.isBuffer(write.content) ? write.content : Buffer.from(String(write.content));
    return { path, sha256: sha256(content), content_base64: content.toString('base64') };
  });
}

export function prepareFileTransaction(root, writes, { id = randomUUID() } = {}) {
  mkdirSync(transactionDirectory(root), { recursive: true });
  const journal = {
    schema_version: 1,
    transaction_id: id,
    status: 'prepared',
    created_at: new Date().toISOString(),
    writes: normalizeWrites(root, writes),
  };
  const path = journalPath(root, id);
  durableAtomicWrite(path, `${JSON.stringify(journal, null, 2)}\n`);
  return { path, journal };
}

function applyJournal(root, journal, { failAfterWrites = 0 } = {}) {
  let applied = 0;
  for (const write of journal.writes || []) {
    const content = Buffer.from(write.content_base64, 'base64');
    if (sha256(content) !== write.sha256) throw new Error(`transaction payload checksum mismatch: ${write.path}`);
    durableAtomicWrite(join(root, safeRelative(root, write.path)), content);
    applied += 1;
    if (failAfterWrites > 0 && applied >= failAfterWrites) throw new Error(`injected transaction failure after ${applied} write(s)`);
  }
  return applied;
}

function recoverPreparedTransactionsUnlocked(root) {
  const dir = transactionDirectory(root);
  if (!existsSync(dir)) return [];
  const recovered = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    const path = join(dir, file);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    if (journal.schema_version !== 1 || journal.status !== 'prepared') throw new Error(`invalid transaction journal: ${file}`);
    applyJournal(root, journal);
    unlinkSync(path);
    recovered.push(journal.transaction_id);
  }
  return recovered;
}

export function recoverFileTransactions(root) {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, TRANSACTION_LOCK);
  const fd = acquireLock(lockPath);
  if (fd === null) throw new Error('another file transaction is in progress');
  try {
    return recoverPreparedTransactionsUnlocked(root);
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

export function commitFileTransaction(root, writes, { id = randomUUID(), failAfterWrites = 0 } = {}) {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, TRANSACTION_LOCK);
  const fd = acquireLock(lockPath);
  if (fd === null) throw new Error('another file transaction is in progress');
  try {
    const recovered = recoverPreparedTransactionsUnlocked(root);
    const prepared = prepareFileTransaction(root, writes, { id });
    const applied = applyJournal(root, prepared.journal, { failAfterWrites });
    unlinkSync(prepared.path);
    return { transaction_id: id, applied, recovered };
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}
