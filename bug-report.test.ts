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
import AsyncTestUtil from 'async-test-util';

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
import { getRxStorageSQLite, getSQLiteBasicsNodeNative } from 'rxdb-premium/plugins/storage-sqlite';

import {
  AfterMigrateBatchHandlerInput,
  migrateStorage,
} from "rxdb/plugins/migration-storage";

describe('bug-report.test.ts', () => {

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);

    it('should fail because it reproduces the bug', async function () {

        let storage: any;
        if (isNode) {
            const { DatabaseSync } = require('node:sqlite' + '');
            storage = getRxStorageSQLite({
                sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync)
            });
        } else {
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

        // insert a document
        await collections.mycollection.insert({
            passportId: 'foobar',
            firstName: 'Bob',
            lastName: 'Kelso',
            age: 56
        });

        /**
         * to simulate the event-propagation over multiple browser-tabs,
         * we create the same database again
         */
        const dbInOtherTab = await createRxDatabase({
            name,
            storage,
            eventReduce: true,
            ignoreDuplicate: true
        });
        // create a collection
        const collectionInOtherTab = await dbInOtherTab.addCollections({
            mycollection: {
                schema: mySchema
            }
        });

        // find the document in the other tab
        const myDocument = await collectionInOtherTab.mycollection
            .findOne()
            .where('firstName')
            .eq('Bob')
            .exec();

        /*
         * assert things,
         * here your tests should fail to show that there is a bug
         */
        assert.strictEqual(myDocument.age, 56);


        // you can also wait for events
        const emitted: any[] = [];
        const sub = collectionInOtherTab.mycollection
            .findOne().$
            .subscribe(doc => {
                emitted.push(doc);
            });
        await AsyncTestUtil.waitUntil(() => emitted.length === 1);

        // clean up afterwards
        sub.unsubscribe();
        await db.close();
        await dbInOtherTab.close();

        const dbNew = await createRxDatabase({
            name: name + "-new",
            storage: storage,
            eventReduce: true,
            ignoreDuplicate: true,
        });

        let didProcessBatch = false;

        await migrateStorage({
            database: dbNew,
            oldDatabaseName: name,
            oldStorage: storage,
            batchSize: 500,
            parallel: false,
            afterMigrateBatch: (input: AfterMigrateBatchHandlerInput) => {
                console.info(`Migration batch processed: ${input}`);
                didProcessBatch = true;
            },
        });

        assert.strictEqual(didProcessBatch, true);
    });
});
