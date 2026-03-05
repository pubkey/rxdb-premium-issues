/**
 * wa-sqlite OPFS worker for RxDB SQLite storage bug reproduction test.
 *
 * This worker:
 * 1. Initialises wa-sqlite with the AccessHandlePoolVFS (OPFS SAH-pool)
 * 2. Exposes the SQLiteBasics interface required by getRxStorageSQLite via Comlink
 * 3. Posts a { type: 'ready' } message once initialisation is complete
 *
 * The file is served by Karma at:
 *   /base/test/unit/wa-sqlite-worker.js
 * and referenced by the test as:
 *   new Worker('/base/test/unit/wa-sqlite-worker.js', { type: 'module' })
 */

import SQLiteESMFactory from '/base/node_modules/wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from '/base/node_modules/wa-sqlite/src/sqlite-api.js';
import { AccessHandlePoolVFS } from '/base/node_modules/wa-sqlite/src/examples/AccessHandlePoolVFS.js';
import * as Comlink from '/base/node_modules/comlink/dist/esm/comlink.mjs';

let sqlite3;
let vfs;
let dbCounter = 0;
/** @type {Map<number, number>} */
const dbMap = new Map();

async function initialize() {
    const module = await SQLiteESMFactory();
    sqlite3 = SQLite.Factory(module);
    vfs = new AccessHandlePoolVFS('/rxdb-wa-sqlite-worker');
    await vfs.isReady;
    sqlite3.vfs_register(vfs, true);
}

const initPromise = initialize();

const api = {
    /**
     * Open (or create) a SQLite database.
     * @param {string} name
     * @returns {Promise<{nr: number, name: string}>}
     */
    async open(name) {
        await initPromise;
        const nr = ++dbCounter;
        const db = await sqlite3.open_v2(
            name,
            SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
            'AccessHandlePool'
        );
        dbMap.set(nr, db);
        return { nr, name };
    },

    /**
     * Execute a query and return all result rows as arrays.
     * @param {{nr: number, name: string}} dbHandle
     * @param {{query: string, params: (string|number|boolean)[]}} queryWithParams
     * @returns {Promise<unknown[][]>}
     */
    async all(dbHandle, queryWithParams) {
        await initPromise;
        const db = dbMap.get(dbHandle.nr);
        const rows = [];
        for await (const stmt of sqlite3.statements(db, queryWithParams.query)) {
            if (queryWithParams.params && queryWithParams.params.length > 0) {
                sqlite3.bind_collection(stmt, queryWithParams.params);
            }
            while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
                rows.push(sqlite3.row(stmt));
            }
        }
        return rows;
    },

    /**
     * Execute a statement without returning results.
     * @param {{nr: number, name: string}} dbHandle
     * @param {{query: string, params: (string|number|boolean)[]}} queryWithParams
     * @returns {Promise<void>}
     */
    async run(dbHandle, queryWithParams) {
        await initPromise;
        const db = dbMap.get(dbHandle.nr);
        for await (const stmt of sqlite3.statements(db, queryWithParams.query)) {
            if (queryWithParams.params && queryWithParams.params.length > 0) {
                sqlite3.bind_collection(stmt, queryWithParams.params);
            }
            await sqlite3.step(stmt);
        }
    },

    /**
     * Set a SQLite PRAGMA on the given database.
     * Both key and value are validated to only contain safe characters
     * (alphanumeric and underscores for key; alphanumeric, underscores,
     * dots, hyphens, and single quotes for value) to prevent SQL injection.
     * @param {{nr: number, name: string}} dbHandle
     * @param {string} key
     * @param {string} value
     * @returns {Promise<void>}
     */
    async setPragma(dbHandle, key, value) {
        await initPromise;
        const db = dbMap.get(dbHandle.nr);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            throw new Error(`Invalid PRAGMA key: ${key}`);
        }
        if (!/^[a-zA-Z0-9_.'-]+$/.test(value)) {
            throw new Error(`Invalid PRAGMA value: ${value}`);
        }
        await sqlite3.exec(db, `PRAGMA ${key} = ${value}`);
    },

    /**
     * Close a database.
     * @param {{nr: number, name: string}} dbHandle
     * @returns {Promise<void>}
     */
    async close(dbHandle) {
        await initPromise;
        const db = dbMap.get(dbHandle.nr);
        if (db !== undefined) {
            await sqlite3.close(db);
            dbMap.delete(dbHandle.nr);
        }
    },

    /**
     * Close all open databases.
     * @returns {Promise<void>}
     */
    async shutdown() {
        await initPromise;
        for (const [nr, db] of dbMap.entries()) {
            await sqlite3.close(db);
            dbMap.delete(nr);
        }
    },
};

// Expose the API via Comlink so the main thread can call methods via RPC.
Comlink.expose(api);

// Signal readiness to the main thread once initialisation is complete.
initPromise.then(() => {
    self.postMessage({ type: 'ready' });
}).catch((err) => {
    console.error('[wa-sqlite-worker] Initialisation failed:', err);
    self.postMessage({ type: 'error', message: String(err) });
});
