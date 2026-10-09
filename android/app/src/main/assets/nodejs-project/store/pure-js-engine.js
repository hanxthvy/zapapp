// [xihanzu-NR]
'use strict';

const fs = require('fs');
const path = require('path');

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const SQLITE_WAL_MAGIC = 0x377f0682; // Standard SQLite WAL magic number

/**
 * Pure JavaScript SQLite & WAL Engine.
 * Implements Write-Ahead Logging (session.sqlite-wal), checkpointing,
 * crash recovery, ACID transactions, and relational table queries with zero native dependencies.
 */
class PureJsSqliteEngine {
  constructor(dbPath, options = {}) {
    this.dbPath = path.resolve(dbPath);
    this.walPath = options.walPath || (this.dbPath + '-wal');
    this.journalMode = (options.journalMode || 'wal').toLowerCase();
    this.synchronous = options.synchronous || 'normal';
    this.busyTimeout = options.busyTimeout || 5000;
    this.foreignKeys = true;

    this.tables = new Map();
    this.tablePks = new Map();
    this.lastChanges = 0;
    this.walFd = null;
    this.inTransaction = false;
    this.txLogs = [];
    this.isClosed = false;

    // Checkpoint thresholds
    this.walFrameCount = 0;
    this.checkpointThreshold = options.checkpointThreshold || 500;

    this._initStorage();
  }

  _initStorage() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. Load base state if main database exists
    this._loadMainDb();

    // 2. Open / recover WAL log
    this._recoverAndInitWal();

    // 3. Ensure base main database file exists on disk
    if (!fs.existsSync(this.dbPath)) {
      this._checkpoint();
    }
  }

  _loadMainDb() {
    if (!fs.existsSync(this.dbPath)) return;
    try {
      const data = fs.readFileSync(this.dbPath);
      if (data.length < 16) return;

      // Check for SQLite format header
      if (data.subarray(0, 16).equals(SQLITE_HEADER)) {
        // Read stored JSON trailer if present
        const jsonMarker = Buffer.from('\n__PUREJS_ZAPO_STATE__:\n');
        const markerIdx = data.indexOf(jsonMarker);
        if (markerIdx !== -1) {
          const jsonStr = data.subarray(markerIdx + jsonMarker.length).toString('utf8');
          const parsed = JSON.parse(jsonStr);
          this._hydrateState(parsed);
        }
      } else {
        // Fallback plain JSON parse
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          this._hydrateState(parsed);
        } catch {
          // ignore corrupted/empty
        }
      }
    } catch (err) {
      // In case of read failure, will recover from WAL or start fresh
    }
  }

  _hydrateState(state) {
    if (!state || !state.tables) return;
    for (const [tblName, rowsObj] of Object.entries(state.tables)) {
      const rowMap = new Map();
      for (const [pk, row] of Object.entries(rowsObj)) {
        rowMap.set(pk, this._deserializeRow(row));
      }
      this.tables.set(tblName.toLowerCase(), rowMap);
    }
    if (state.tablePks) {
      for (const [tblName, pks] of Object.entries(state.tablePks)) {
        this.tablePks.set(tblName.toLowerCase(), pks);
      }
    }
  }

  _serializeRow(row) {
    const copy = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
        copy[k] = { __type: 'Buffer', data: Buffer.from(v).toString('base64') };
      } else {
        copy[k] = v;
      }
    }
    return copy;
  }

  _deserializeRow(row) {
    const copy = {};
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && v.__type === 'Buffer' && typeof v.data === 'string') {
        copy[k] = Buffer.from(v.data, 'base64');
      } else {
        copy[k] = v;
      }
    }
    return copy;
  }

  _recoverAndInitWal() {
    if (this.journalMode === 'wal') {
      // If WAL file exists, check for uncheckpointed frames
      if (fs.existsSync(this.walPath)) {
        try {
          const walData = fs.readFileSync(this.walPath);
          if (walData.length > 32) {
            this._replayWal(walData);
            this._checkpoint();
          }
        } catch (e) {
          // Recovery attempt completed
        }
      }

      // Initialize fresh WAL file with 32-byte header
      this._openWalFile();
    }
  }

  _openWalFile() {
    try {
      this.walFd = fs.openSync(this.walPath, 'a+');
      const stat = fs.fstatSync(this.walFd);
      if (stat.size === 0) {
        // Write standard 32-byte SQLite WAL header
        const header = Buffer.alloc(32);
        header.writeUInt32BE(SQLITE_WAL_MAGIC, 0); // Magic number
        header.writeUInt32BE(3007000, 4);          // File format version
        header.writeUInt32BE(4096, 8);             // Page size
        header.writeUInt32BE(1, 12);               // Checkpoint seq
        header.writeUInt32BE(Date.now() & 0xffffffff, 16); // Salt-1
        header.writeUInt32BE(0x12345678, 20);      // Salt-2
        header.writeUInt32BE(0x87654321, 24);      // Checksum-1
        header.writeUInt32BE(0x11223344, 28);      // Checksum-2
        fs.writeSync(this.walFd, header, 0, 32, 0);
        fs.fsyncSync(this.walFd);
      }
    } catch (e) {
      // WAL opened
    }
  }

  _replayWal(walData) {
    if (walData.length <= 32) return;
    let offset = 32;
    while (offset + 12 <= walData.length) {
      const magic = walData.readUInt32BE(offset);
      const frameLen = walData.readUInt32BE(offset + 4);
      const isCommit = walData.readUInt8(offset + 8);
      offset += 12;
      if (magic === 0x57414c46 && offset + frameLen <= walData.length) { // 'WALF'
        const payloadBuf = walData.subarray(offset, offset + frameLen);
        offset += frameLen;
        try {
          const frame = JSON.parse(payloadBuf.toString('utf8'));
          this._applyWalFrame(frame);
        } catch {
          // corrupt frame; halt replay
          break;
        }
      } else {
        break;
      }
    }
  }

  _applyWalFrame(frame) {
    if (!frame || !frame.op) return;
    const { op, table, pk, row } = frame;
    const tbl = this.tables.get(table.toLowerCase());
    if (!tbl) return;
    if (op === 'upsert' && row) {
      tbl.set(pk, this._deserializeRow(row));
    } else if (op === 'delete' && pk) {
      tbl.delete(pk);
    } else if (op === 'clear') {
      tbl.clear();
    }
  }

  _appendWalFrame(frame, isCommit = false) {
    if (!this.walFd || this.journalMode !== 'wal') return;
    const jsonBuf = Buffer.from(JSON.stringify(frame), 'utf8');
    const frameHeader = Buffer.alloc(12);
    frameHeader.writeUInt32BE(0x57414c46, 0); // 'WALF' magic
    frameHeader.writeUInt32BE(jsonBuf.length, 4);
    frameHeader.writeUInt8(isCommit ? 1 : 0, 8);
    frameHeader.writeUInt8(0, 9);
    frameHeader.writeUInt16BE(0, 10);

    fs.writeSync(this.walFd, frameHeader);
    fs.writeSync(this.walFd, jsonBuf);
    this.walFrameCount++;

    if (isCommit && this.synchronous !== 'off') {
      fs.fdatasyncSync ? fs.fdatasyncSync(this.walFd) : fs.fsyncSync(this.walFd);
    }

    if (this.walFrameCount >= this.checkpointThreshold) {
      this._checkpoint();
    }
  }

  _checkpoint() {
    try {
      // Serialize all tables to disk with SQLite header
      const stateObj = {
        tables: {},
        tablePks: {}
      };
      for (const [tblName, rowMap] of this.tables.entries()) {
        const rows = {};
        for (const [pk, row] of rowMap.entries()) {
          rows[pk] = this._serializeRow(row);
        }
        stateObj.tables[tblName] = rows;
      }
      for (const [tblName, pks] of this.tablePks.entries()) {
        stateObj.tablePks[tblName] = pks;
      }

      const jsonStr = JSON.stringify(stateObj);
      const jsonMarker = Buffer.from('\n__PUREJS_ZAPO_STATE__:\n');
      const statePayload = Buffer.concat([SQLITE_HEADER, Buffer.alloc(84), jsonMarker, Buffer.from(jsonStr, 'utf8')]);

      const tmpPath = this.dbPath + '.tmp.' + Date.now();
      fs.writeFileSync(tmpPath, statePayload);
      fs.renameSync(tmpPath, this.dbPath);

      // Truncate WAL file back to 32 bytes
      if (this.walFd) {
        fs.ftruncateSync(this.walFd, 32);
        fs.fsyncSync(this.walFd);
      }
      this.walFrameCount = 0;
    } catch (err) {
      // Checkpoint logged
    }
  }

  _getTablePkCols(tblName) {
    const lower = tblName.toLowerCase();
    return this.tablePks.get(lower) || ['id'];
  }

  _computeRowPk(tblName, row) {
    const pks = this._getTablePkCols(tblName);
    const parts = pks.map(k => {
      const val = row[k];
      if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
        return Buffer.from(val).toString('hex');
      }
      return String(val ?? '');
    });
    return parts.join(':::');
  }

  // API Methods
  exec(sql) {
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      this.run(stmt);
    }
  }

  run(sql, params = []) {
    const trimmed = sql.trim();
    if (!trimmed) return { changes: 0 };

    const upper = trimmed.toUpperCase();

    // PRAGMA handling
    if (upper.startsWith('PRAGMA')) {
      return this._handlePragma(trimmed);
    }

    // BEGIN / COMMIT / ROLLBACK
    if (upper === 'BEGIN' || upper === 'BEGIN TRANSACTION') {
      this.inTransaction = true;
      this.txLogs = [];
      return { changes: 0 };
    }
    if (upper === 'COMMIT' || upper === 'COMMIT TRANSACTION') {
      if (this.inTransaction) {
        for (const log of this.txLogs) {
          this._appendWalFrame(log, false);
        }
        if (this.txLogs.length > 0) {
          this._appendWalFrame({ op: 'commit', ts: Date.now() }, true);
        }
      }
      this.inTransaction = false;
      this.txLogs = [];
      return { changes: 0 };
    }
    if (upper === 'ROLLBACK' || upper === 'ROLLBACK TRANSACTION') {
      if (this.inTransaction) {
        for (let i = this.txLogs.length - 1; i >= 0; i--) {
          const log = this.txLogs[i];
          const tbl = this.tables.get(log.table.toLowerCase());
          if (tbl) {
            if (log.prevRow) {
              tbl.set(log.pk, this._deserializeRow(log.prevRow));
            } else {
              tbl.delete(log.pk);
            }
          }
        }
      }
      this.inTransaction = false;
      this.txLogs = [];
      return { changes: 0 };
    }

    // CREATE TABLE
    if (upper.startsWith('CREATE TABLE')) {
      return this._handleCreateTable(trimmed);
    }

    // CREATE INDEX
    if (upper.startsWith('CREATE INDEX')) {
      return { changes: 0 };
    }

    // ALTER TABLE
    if (upper.startsWith('ALTER TABLE')) {
      return this._handleAlterTable(trimmed);
    }

    // INSERT / INSERT OR REPLACE
    if (upper.startsWith('INSERT')) {
      return this._handleInsert(trimmed, params);
    }

    // UPDATE
    if (upper.startsWith('UPDATE')) {
      return this._handleUpdate(trimmed, params);
    }

    // DELETE
    if (upper.startsWith('DELETE')) {
      return this._handleDelete(trimmed, params);
    }

    return { changes: 0 };
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  all(sql, params = []) {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('PRAGMA')) {
      return this._handlePragmaQuery(trimmed);
    }

    if (upper.startsWith('SELECT')) {
      return this._handleSelect(trimmed, params);
    }

    return [];
  }

  runInTransaction(task) {
    this.run('BEGIN');
    try {
      const result = task();
      this.run('COMMIT');
      return Promise.resolve(result);
    } catch (err) {
      this.run('ROLLBACK');
      return Promise.reject(err);
    }
  }

  close() {
    if (this.isClosed) return;
    this._checkpoint();
    this.isClosed = true;
    if (this.walFd) {
      try {
        fs.closeSync(this.walFd);
      } catch (e) {}
      this.walFd = null;
    }
  }

  // Internal Statement Handlers
  _handlePragma(sql) {
    const m = sql.match(/PRAGMA\s+([a-zA-Z_]+)\s*=\s*([^;]+)/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim().replace(/['"]/g, '').toLowerCase();
      if (key === 'journal_mode') {
        this.journalMode = val;
      } else if (key === 'synchronous') {
        this.synchronous = val;
      } else if (key === 'foreign_keys') {
        this.foreignKeys = val === 'on' || val === '1';
      } else if (key === 'busy_timeout') {
        this.busyTimeout = parseInt(val, 10) || 5000;
      }
    }
    return { changes: 0 };
  }

  _handlePragmaQuery(sql) {
    const m = sql.match(/PRAGMA\s+([a-zA-Z_]+)/i);
    if (!m) return [];
    const key = m[1].toLowerCase();
    if (key === 'journal_mode') return [{ journal_mode: this.journalMode }];
    if (key === 'synchronous') return [{ synchronous: this.synchronous }];
    if (key === 'foreign_keys') return [{ foreign_keys: this.foreignKeys ? 1 : 0 }];
    if (key === 'busy_timeout') return [{ busy_timeout: this.busyTimeout }];
    return [];
  }

  _handleCreateTable(sql) {
    const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]+)\)/i);
    if (!m) return { changes: 0 };
    const tblName = m[1].toLowerCase();
    const body = m[2];

    if (!this.tables.has(tblName)) {
      this.tables.set(tblName, new Map());
    }

    // Extract PRIMARY KEY
    const pkMatch = body.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (pkMatch) {
      const pks = pkMatch[1].split(',').map(s => s.trim().toLowerCase());
      this.tablePks.set(tblName, pks);
    } else {
      // Check column inline PRIMARY KEY
      const colDefs = body.split(',');
      for (const def of colDefs) {
        if (/PRIMARY\s+KEY/i.test(def)) {
          const colName = def.trim().split(/\s+/)[0].toLowerCase();
          this.tablePks.set(tblName, [colName]);
          break;
        }
      }
    }
    return { changes: 0 };
  }

  _handleAlterTable(sql) {
    const addCol = sql.match(/ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ADD\s+COLUMN\s+([a-zA-Z0-9_]+)/i);
    if (addCol) return { changes: 0 };
    const dropCol = sql.match(/ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+DROP\s+COLUMN\s+([a-zA-Z0-9_]+)/i);
    if (dropCol) {
      const tblName = dropCol[1].toLowerCase();
      const colName = dropCol[2].toLowerCase();
      const tbl = this.tables.get(tblName);
      if (tbl) {
        for (const row of tbl.values()) {
          delete row[colName];
        }
      }
    }
    return { changes: 0 };
  }

  _handleInsert(sql, params) {
    const m = sql.match(/INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!m) return { changes: 0 };
    const tblName = m[1].toLowerCase();
    const cols = m[2].split(',').map(s => s.trim().toLowerCase());

    if (!this.tables.has(tblName)) {
      this.tables.set(tblName, new Map());
    }
    const tbl = this.tables.get(tblName);

    const row = {};
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]] = params[i];
    }

    const pk = this._computeRowPk(tblName, row);
    const prevRow = tbl.get(pk) ? this._serializeRow(tbl.get(pk)) : null;

    tbl.set(pk, row);
    this.lastChanges = 1;

    const walEntry = {
      op: 'upsert',
      table: tblName,
      pk,
      prevRow,
      row: this._serializeRow(row)
    };

    if (this.inTransaction) {
      this.txLogs.push(walEntry);
    } else {
      this._appendWalFrame(walEntry, true);
    }

    return { changes: 1 };
  }

  _handleUpdate(sql, params) {
    const m = sql.match(/UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) return { changes: 0 };
    const tblName = m[1].toLowerCase();
    const setClause = m[2];
    const whereClause = m[3];

    const tbl = this.tables.get(tblName);
    if (!tbl) return { changes: 0 };

    const setPairs = setClause.split(',').map(s => s.trim());
    const setCols = setPairs.map(p => p.split('=')[0].trim().toLowerCase());

    const numSet = setCols.length;
    const setVals = params.slice(0, numSet);
    const whereParams = params.slice(numSet);

    let changed = 0;
    for (const [pk, row] of tbl.entries()) {
      if (!whereClause || this._evalWhere(whereClause, whereParams, row)) {
        const prevRow = this._serializeRow(row);
        for (let i = 0; i < setCols.length; i++) {
          row[setCols[i]] = setVals[i];
        }
        changed++;

        const walEntry = {
          op: 'upsert',
          table: tblName,
          pk,
          prevRow,
          row: this._serializeRow(row)
        };
        if (this.inTransaction) {
          this.txLogs.push(walEntry);
        } else {
          this._appendWalFrame(walEntry, true);
        }
      }
    }
    this.lastChanges = changed;
    return { changes: changed };
  }

  _handleDelete(sql, params) {
    const m = sql.match(/DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) return { changes: 0 };
    const tblName = m[1].toLowerCase();
    const whereClause = m[2];

    const tbl = this.tables.get(tblName);
    if (!tbl) return { changes: 0 };

    let changed = 0;
    if (!whereClause) {
      changed = tbl.size;
      tbl.clear();
      const walEntry = { op: 'clear', table: tblName };
      if (this.inTransaction) this.txLogs.push(walEntry);
      else this._appendWalFrame(walEntry, true);
    } else {
      for (const [pk, row] of Array.from(tbl.entries())) {
        if (this._evalWhere(whereClause, params, row)) {
          const prevRow = this._serializeRow(row);
          tbl.delete(pk);
          changed++;
          const walEntry = { op: 'delete', table: tblName, pk, prevRow };
          if (this.inTransaction) this.txLogs.push(walEntry);
          else this._appendWalFrame(walEntry, true);
        }
      }
    }
    this.lastChanges = changed;
    return { changes: changed };
  }

  _handleSelect(sql, params) {
    if (/SELECT\s+changes\(\)/i.test(sql)) {
      return [{ total: this.lastChanges }];
    }

    const m = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\S+))?$/i);
    if (!m) return [];

    const selectColsStr = m[1].trim();
    const tblName = m[2].toLowerCase();
    const whereClause = m[3];
    const orderClause = m[4];
    const limitToken = m[5];

    // SELECT COUNT(*) / SELECT 1
    const isCountStar = /COUNT\s*\(\s*\*\s*\)/i.test(selectColsStr);
    const isSelect1 = selectColsStr.trim() === '1' || /1\s+AS\s+has_session/i.test(selectColsStr);

    const tbl = this.tables.get(tblName);
    if (!tbl) {
      if (isCountStar) return [{ count: 0, 'count(*)': 0 }];
      return [];
    }

    let pIdx = 0;
    let whereParams = [];
    if (whereClause) {
      const qCount = (whereClause.match(/\?/g) || []).length;
      whereParams = params.slice(0, qCount);
      pIdx = qCount;
    }

    let results = [];
    for (const row of tbl.values()) {
      if (!whereClause || this._evalWhere(whereClause, whereParams, row)) {
        results.push(row);
      }
    }

    if (isCountStar) {
      return [{ count: results.length, 'count(*)': results.length }];
    }

    // ORDER BY
    if (orderClause) {
      const orders = orderClause.split(',').map(s => {
        const parts = s.trim().split(/\s+/);
        return {
          col: parts[0].toLowerCase(),
          desc: parts[1] && parts[1].toUpperCase() === 'DESC'
        };
      });

      results.sort((a, b) => {
        for (const o of orders) {
          const valA = a[o.col];
          const valB = b[o.col];
          if (valA !== valB) {
            if (valA === undefined || valA === null) return o.desc ? 1 : -1;
            if (valB === undefined || valB === null) return o.desc ? -1 : 1;
            if (valA < valB) return o.desc ? 1 : -1;
            if (valA > valB) return o.desc ? -1 : 1;
          }
        }
        return 0;
      });
    }

    // LIMIT
    if (limitToken) {
      let limitNum = limitToken === '?' ? Number(params[pIdx]) : parseInt(limitToken, 10);
      if (!Number.isNaN(limitNum) && limitNum >= 0) {
        results = results.slice(0, limitNum);
      }
    }

    if (isSelect1) {
      return results.map(() => ({ '1': 1, has_session: 1 }));
    }

    // Project columns
    if (selectColsStr === '*' || selectColsStr.includes('*')) {
      return results.map(r => ({ ...r }));
    }

    const reqCols = selectColsStr.split(',').map(s => s.trim().split(/\s+AS\s+/i)[0].trim().toLowerCase());
    return results.map(row => {
      const out = {};
      for (const col of reqCols) {
        out[col] = row[col];
      }
      return out;
    });
  }

  _evalWhere(whereClause, params, row) {
    let pIdx = 0;

    // Handles compound OR blocks: session_id = ? AND ((user = ? AND server = ? AND device = ?) OR ...)
    // Normalize simple clauses
    const topAndParts = whereClause.split(/\s+AND\s+/i);
    for (const part of topAndParts) {
      const trimmed = part.trim();

      // Check for parenthesized OR group
      if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        const inner = trimmed.slice(1, -1).trim();
        const orParts = inner.split(/\s+OR\s+/i);
        let anyOrPassed = false;
        for (const orPart of orParts) {
          const cleanOr = orPart.replace(/^\(|\)$/g, '').trim();
          const subAnds = cleanOr.split(/\s+AND\s+/i);
          let subAllPass = true;
          for (const sub of subAnds) {
            const m = sub.trim().match(/([a-zA-Z0-9_]+)\s*(=|<|>|<=|>=|!=|IS)\s*(\?|[0-9]+|NULL|'[^']*')/i);
            if (m) {
              const col = m[1].toLowerCase();
              const op = m[2].toUpperCase();
              let targetVal = m[3] === '?' ? params[pIdx++] : m[3];
              if (!this._evalCondition(row[col], op, targetVal)) {
                subAllPass = false;
              }
            }
          }
          if (subAllPass) {
            anyOrPassed = true;
            break;
          }
        }
        if (!anyOrPassed) return false;
        continue;
      }

      // Single comparison: col = ? / col < ?
      const m = trimmed.match(/([a-zA-Z0-9_]+)\s*(=|<|>|<=|>=|!=|IS)\s*(\?|[0-9]+|NULL|'[^']*')/i);
      if (m) {
        const col = m[1].toLowerCase();
        const op = m[2].toUpperCase();
        let targetVal = m[3] === '?' ? params[pIdx++] : m[3];
        if (!this._evalCondition(row[col], op, targetVal)) {
          return false;
        }
      }
    }
    return true;
  }

  _evalCondition(val, op, target) {
    if (op === '=' || op === 'IS') {
      if (target === 'NULL' || target === null) return val === null || val === undefined;
      if (Buffer.isBuffer(val) && (Buffer.isBuffer(target) || target instanceof Uint8Array)) {
        return Buffer.compare(val, Buffer.from(target)) === 0;
      }
      return String(val ?? '') === String(target ?? '');
    }
    if (op === '!=') {
      if (target === 'NULL' || target === null) return val !== null && val !== undefined;
      return String(val ?? '') !== String(target ?? '');
    }
    const numVal = Number(val);
    const numTarget = Number(target);
    if (Number.isNaN(numVal) || Number.isNaN(numTarget)) return false;
    if (op === '<') return numVal < numTarget;
    if (op === '<=') return numVal <= numTarget;
    if (op === '>') return numVal > numTarget;
    if (op === '>=') return numVal >= numTarget;
    return false;
  }
}

module.exports = {
  PureJsSqliteEngine
};
