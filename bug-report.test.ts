/**
 * this is a template for a test.
 * If you found a bug, edit this test to reproduce it
 * and than make a pull-request with that failing test.
 * The maintainer will later move your test to the correct position in the test-suite.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 * - 'npm run test:browser' so it runs in the browser
 */
import assert from 'assert';

import {
    createRxDatabase,
    randomToken,
    addRxPlugin
} from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';

import {
    isNode
} from 'rxdb/plugins/test-utils';


/**
 * You can import any RxDB Premium Plugins here
*/
import { getRxStorageIndexedDB } from 'rxdb-premium/plugins/storage-indexeddb';

describe('bug-report.test.ts', () => {

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);

    /**
     * Reproduction for: https://github.com/pubkey/rxdb/issues/8438
     *
     * SQLite has a hard limit on the number of bound parameters allowed in a single
     * query (SQLITE_LIMIT_VARIABLE_NUMBER, default 32766 in SQLite ≥ 3.32.0).
     * When replication calls `findDocumentsById()` with more IDs than this limit,
     * the storage builds one giant `WHERE id IN (?, ?, …)` clause and SQLite
     * throws: "Error: too many SQL variables".
     *
     * This test calls `findDocumentsById()` directly with 40 000 IDs, which
     * exceeds the limit, and asserts that the call succeeds. With the bug present
     * it will throw "too many SQL variables" instead.
     */
    it('should handle findDocumentsById() with more IDs than SQLite variable limit', async function () {
        // SQLite is only available in Node.js
        if (!isNode) {
            return;
        }

        // Allow plenty of time – inserting many documents can be slow in CI
        this.timeout(120_000);

        const { DatabaseSync } = require('node:sqlite' + '');
        const { getRxStorageSQLite, getSQLiteBasicsNodeNative } = require('rxdb-premium/plugins/storage-sqlite');
        const storage = getRxStorageSQLite({
            sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync)
        });

        const mySchema = {
            version: 0,
            primaryKey: 'passportId',
            type: 'object',
            properties: {
                passportId: {
                    type: 'string',
                    maxLength: 100
                }
            },
            required: ['passportId']
        };

        const name = randomToken(10);
        const db = await createRxDatabase({
            name,
            storage,
            eventReduce: true,
            ignoreDuplicate: true
        });

        const collections = await db.addCollections({
            mycollection: {
                schema: mySchema
            }
        });

        // Insert a small number of real documents so the collection/table exists
        await collections.mycollection.insert({ passportId: 'seed-doc' });

        /**
         * Build an ID list that exceeds SQLite's default SQLITE_LIMIT_VARIABLE_NUMBER
         * (32 766 for SQLite ≥ 3.32.0).  Most IDs won't match any stored document;
         * that is fine – the SELECT still has to bind all parameters before it can
         * decide which rows to return, so the limit is hit regardless.
         */
        const OVER_SQLITE_LIMIT = 40_000;
        const manyIds: string[] = Array.from(
            { length: OVER_SQLITE_LIMIT },
            (_, i) => `doc-${i}`
        );

        // This call must succeed and return whatever subset of IDs actually exists.
        // With the bug present it throws: "Error: too many SQL variables"
        const result = await collections.mycollection.storageInstance.findDocumentsById(
            manyIds,
            false
        );

        assert.ok(
            Array.isArray(result),
            'findDocumentsById should return an array even for very large ID lists'
        );

        await db.close();
    });
});
