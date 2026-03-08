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
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
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
     * Reproduces https://github.com/pubkey/rxdb/issues/7984
     *
     * When performing bulkInsert on documents that were previously soft-deleted,
     * only 199 documents are revived instead of all of them.
     */
    it('bulkInsert should revive all soft-deleted documents, not just 199', async function () {
        this.timeout(60000);

        let storage: any;
        if (isNode) {
            // SQLite is only available in Node.js; use dynamic require so the browser
            // bundle never tries to include native Node-only dependencies.
            const { DatabaseSync } = require('node:sqlite' + '');
            const { getRxStorageSQLite, getSQLiteBasicsNodeNative } = require('rxdb-premium/plugins/storage-sqlite');
            storage = getRxStorageSQLite({
                sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync)
            });
        } else {
            // In the browser, use the premium IndexedDB storage.
            storage = getRxStorageIndexedDB();
        }
        storage = wrappedValidateAjvStorage({
            storage
        });

        // create a schema
        const mySchema = {
            version: 0,
            primaryKey: 'passportId',
            type: 'object',
            properties: {
                passportId: {
                    type: 'string',
                    maxLength: 100
                },
                firstName: {
                    type: 'string'
                },
                lastName: {
                    type: 'string'
                },
                age: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 150
                }
            }
        };

        /**
         * Always generate a random database-name
         * to ensure that different test runs do not affect each other.
         */
        const name = randomToken(10);

        // create a database
        const db = await createRxDatabase({
            name,
            storage: storage,
            eventReduce: true,
            ignoreDuplicate: true
        });
        // create a collection
        const collections = await db.addCollections({
            mycollection: {
                schema: mySchema
            }
        });

        const collection = collections.mycollection;

        // Use 300 documents, well above the 199 limit described in the bug
        const DOCUMENT_COUNT = 300;
        const myDocuments = Array.from({ length: DOCUMENT_COUNT }, (_, i) => ({
            passportId: 'doc-' + String(i).padStart(4, '0'),
            firstName: 'First' + i,
            lastName: 'Last' + i,
            age: (i % 150) // keep age within schema maximum of 150
        }));

        // Step 1: Insert all N documents (should work correctly)
        const firstInsertResult = await collection.bulkInsert(myDocuments);
        assert.strictEqual(
            firstInsertResult.success.length,
            DOCUMENT_COUNT,
            'First bulkInsert should report all documents as success'
        );
        assert.strictEqual(
            firstInsertResult.error.length,
            0,
            'First bulkInsert should report no errors'
        );
        const countAfterFirstInsert = await collection.count().exec();
        assert.strictEqual(
            countAfterFirstInsert,
            DOCUMENT_COUNT,
            'After first bulkInsert, collection should contain all documents'
        );

        // Step 2: Delete all N documents
        const allDocs = await collection.find().exec();
        const bulkDeleteResult = await collection.bulkRemove(allDocs.map(d => d.passportId));
        assert.strictEqual(
            bulkDeleteResult.success.length,
            DOCUMENT_COUNT,
            'bulkRemove should report all documents as success'
        );
        const countAfterDelete = await collection.count().exec();
        assert.strictEqual(
            countAfterDelete,
            0,
            'After bulkRemove, collection should be empty'
        );

        // Step 3: Re-insert the same N documents (reviving soft-deleted entries)
        const secondInsertResult = await collection.bulkInsert(myDocuments);
        assert.strictEqual(
            secondInsertResult.success.length,
            DOCUMENT_COUNT,
            'Second bulkInsert should report all documents as success'
        );
        assert.strictEqual(
            secondInsertResult.error.length,
            0,
            'Second bulkInsert should report no errors'
        );

        // Step 4: Verify all documents are present (this is where the bug manifests)
        const countAfterSecondInsert = await collection.count().exec();
        assert.strictEqual(
            countAfterSecondInsert,
            DOCUMENT_COUNT,
            'After second bulkInsert (reviving soft-deleted docs), collection should contain all ' + DOCUMENT_COUNT + ' documents, not just 199'
        );

        // clean up afterwards
        await db.close();
    });
});
