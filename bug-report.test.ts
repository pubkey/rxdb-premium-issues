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


describe('bug-report.test.ts', () => {
    const SHARED_WORKER_HEALTH_CHECK_WAIT_MS = 2000;

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);

    it('reproduces SharedWorker TransactionInactiveError with IndexedDB storage', async function () {
        this.timeout(30000);


        if (isNode) {
            return;
        }

        const unhandledErrors: any[] = [];
        const unhandledRejectionHandler = (event: any) => {
            const reasonAsString = event?.reason ? String(event.reason) : '';
            if (reasonAsString.includes('TransactionInactiveError')) {
                unhandledErrors.push({
                    type: 'unhandledrejection',
                    reason: reasonAsString
                });
            }
        };
        window.addEventListener('unhandledrejection', unhandledRejectionHandler);

        const { getRxStorageSharedWorker } = await import('rxdb-premium/plugins/storage-worker');
        const storage = wrappedValidateAjvStorage({
            storage: getRxStorageSharedWorker({
                workerInput: '/base/node_modules/rxdb-premium/dist/workers/indexeddb.worker.js'
            })
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
        const dbName = `shared-worker-test-${randomToken(10)}`;
        const db1 = await createRxDatabase({
            name: dbName,
            storage,
            eventReduce: true,
            ignoreDuplicate: true,
            multiInstance: true
        });
        const db2 = await createRxDatabase({
            name: dbName,
            storage,
            eventReduce: true,
            ignoreDuplicate: true,
            multiInstance: true
        });

        const collections1 = await db1.addCollections({
            mycollection: {
                schema: mySchema
            }
        });
        const collections2 = await db2.addCollections({
            mycollection: {
                schema: mySchema
            }
        });

        const emitted: any[] = [];
        const sub = collections2.mycollection.findOne('doc-0').$.subscribe(doc => emitted.push(doc));

        for (let i = 0; i < 25; i++) {
            await collections1.mycollection.upsert({
                passportId: 'doc-' + i,
                firstName: 'Bob',
                lastName: 'Kelso',
                age: i
            });
            await collections2.mycollection.findOne('doc-' + i).exec();
        }

        await AsyncTestUtil.wait(SHARED_WORKER_HEALTH_CHECK_WAIT_MS);

        sub.unsubscribe();
        await db1.close();
        await db2.close();
        window.removeEventListener('unhandledrejection', unhandledRejectionHandler);

        assert.strictEqual(
            unhandledErrors.length,
            0,
            'Expected no SharedWorker/IndexedDB unhandled rejections, got: ' + JSON.stringify(unhandledErrors)
        );
    });
});
