/**
 * Bug reproduction: the Memory-Mapped RxStorage silently drops batched writes.
 *
 * Root cause (plugins/storage-memory-mapped/memory-mapped-storage-instance.js, `bulkWrite`):
 * the background persistence flush drains ALL pending write tasks, then loops them to build
 * the blocks it writes to the persistent (underlying) instance. On the first task whose result
 * has zero written documents it does `if (writtenDocs.length === 0) return;` — which aborts the
 * ENTIRE flush. Because `this.writeTasks` was already cleared before the loop, every other write
 * batched into that flush is permanently abandoned: it lives only in the in-memory instance and
 * is NEVER persisted to the underlying storage. It should be `continue` (skip the empty result,
 * keep persisting the rest).
 *
 * Why `bulkUpsert` of an EXISTING document reliably triggers it:
 *   1. bulkUpsert first calls bulkInsert, which for an already-existing primary returns all-409
 *      conflicts -> a write task that resolves to an EMPTY array.
 *   2. bulkUpsert then applies the real change via incrementalModify -> a second write task.
 * With the default settings (awaitWritePersistence unset) the `requestIdlePromise` delay batches
 * both into one flush; the empty insert-result hits the `return` and the real update is dropped.
 * Waiting does not help — the flush already ran and bailed.
 *
 * `incrementalUpdate({$set})` (single-document edits) is unaffected because it never produces the
 * empty-result write that poisons the batch.
 *
 * The test below isolates the problem across separate database sessions:
 *   session 1: insert a document, then close (the insert persists fine — clean, non-empty batch).
 *   session 2: bulkUpsert the SAME document, then close (the update is dropped).
 *   session 3: reopen and read -> the document still has the OLD value.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 * - 'npm run test:browser' so it runs in the browser
 */
import assert from 'assert';

import {
    createRxDatabase,
    randomToken,
    addRxPlugin,
    RxStorage
} from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';

import {
    isNode
} from 'rxdb/plugins/test-utils';

import { getMemoryMappedRxStorage } from 'rxdb-premium/plugins/storage-memory-mapped';
import { getRxStorageIndexedDB } from 'rxdb-premium/plugins/storage-indexeddb';

const mySchema = {
    version: 0,
    primaryKey: 'passportId',
    type: 'object',
    properties: {
        passportId: { type: 'string', maxLength: 100 },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        age: { type: 'integer', minimum: 0, maximum: 150 }
    }
};

describe('bug-report.test.ts', () => {

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);

    /**
     * Build a Memory-Mapped storage wrapping a durable underlying storage.
     * The bug lives in the memory-mapped layer and is independent of which storage it wraps.
     * NOTE: `awaitWritePersistence` is intentionally left at its default (false) — that is the
     * configuration that drops the write. Setting it to `true` hides the bug.
     */
    function getStorage(): RxStorage<any, any> {
        let baseStorage: any;
        if (isNode) {
            // Polyfill IndexedDB with fake-indexeddb (which, like a real browser's IndexedDB,
            // keeps data across a database close()+reopen), then load the license-free Dexie
            // storage lazily via require() so it sees the polyfill. (The premium SQLite plugin
            // is not part of every license, so it is not used here.)
            require('fake-indexeddb/auto');
            baseStorage = require('rxdb/plugins/storage-dexie').getRxStorageDexie();
        } else {
            // In the browser, use the premium IndexedDB storage (durable across reopen).
            baseStorage = getRxStorageIndexedDB();
        }
        return wrappedValidateAjvStorage({
            storage: getMemoryMappedRxStorage({ storage: baseStorage })
        });
    }

    async function openShow(name: string) {
        const db = await createRxDatabase({
            name,
            storage: getStorage(),
            eventReduce: true,
            ignoreDuplicate: true
        });
        const collections = await db.addCollections({
            mycollection: { schema: mySchema }
        });
        return { db, collection: collections.mycollection };
    }

    it('memory-mapped storage drops a bulkUpsert update on an existing document', async function () {
        // Same database name across every session so they share the durable underlying storage.
        const name = randomToken(10);

        // --- session 1: insert the document, then close. ---
        // The insert is a single non-empty write, so it persists correctly.
        {
            const { db, collection } = await openShow(name);
            await collection.insert({
                passportId: 'foobar',
                firstName: 'Bob',
                lastName: 'Kelso',
                age: 56
            });
            await db.close();
        }

        // --- session 2: bulkUpsert the SAME (existing) document, then close. ---
        // bulkUpsert -> bulkInsert (409 conflict => empty-result write) + incrementalModify
        // (the real update). The empty insert-result aborts the persistence flush, so the
        // update is written to memory only and never reaches the underlying storage.
        {
            const { db, collection } = await openShow(name);

            // Confirm session 1 persisted (proves the underlying storage is durable across reopen).
            const beforeUpdate = await collection.findOne('foobar').exec();
            assert.ok(beforeUpdate, 'precondition: inserted document should survive reopen');
            assert.strictEqual(beforeUpdate.age, 56, 'precondition: inserted age should be 56');

            await collection.bulkUpsert([{
                passportId: 'foobar',
                firstName: 'Bob',
                lastName: 'Kelso',
                age: 100
            }]);

            // Querying the live database returns 100 (the in-memory instance has it) — looks saved.
            const liveDoc = await collection.findOne('foobar').exec();
            assert.strictEqual(liveDoc?.age, 100, 'sanity: the in-memory instance should hold the update');

            // close() awaits the write-queue, so by here the (broken) persistence flush has run.
            await db.close();
        }

        // --- session 3: reopen and re-read. ---
        {
            const { db, collection } = await openShow(name);
            const reread = await collection.findOne('foobar').exec();

            assert.ok(reread, 'document should still exist after reopen');

            // The actual bug: the bulkUpsert update was never persisted, so we read the stale
            // value 56 instead of 100.
            assert.strictEqual(
                reread.age,
                100,
                'bulkUpsert update must survive reopen, but the memory-mapped storage dropped it (got ' + reread.age + ')'
            );

            await db.close();
        }
    });
});
