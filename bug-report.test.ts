import AsyncTestUtil from 'async-test-util';

import {
    addRxPlugin,
    createRxDatabase,
    randomToken
} from 'rxdb/plugins/core';
import { replicateRxCollection } from 'rxdb/plugins/replication';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { isNode } from 'rxdb/plugins/test-utils';

declare const window: any;

addRxPlugin(RxDBDevModePlugin);

const REPLICATION_SCHEMA = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: {
            type: 'string',
            maxLength: 100
        },
        value: {
            type: 'string'
        },
        updatedAt: {
            type: 'number',
            minimum: 0,
            maximum: 9999999999999
        },
        _deleted: {
            type: 'boolean'
        }
    },
    required: ['id', 'value', 'updatedAt', '_deleted']
};
const WAIT_FOR_UNHANDLED_MS = 10 * 1000;

describe('bug-report.test.ts', () => {
    it('reproduces TransactionInactiveError via RxDB replication with IndexedDB storage', async function () {
        if (isNode) {
            this.skip();
            return;
        }

        const exactMessage = "TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is not active.";
        const { getRxStorageIndexedDB } = require('rxdb-premium/plugins/storage-indexeddb');
        const storage = wrappedValidateAjvStorage({
            storage: getRxStorageIndexedDB()
        });
        const dbName = 'issue-8497-' + randomToken(10);
        const docsFromMaster = Array.from({ length: 500 }).map((_, idx) => ({
            id: 'doc-' + idx,
            value: 'v' + idx,
            updatedAt: idx,
            _deleted: false
        }));
        const unhandledRejections: any[] = [];
        const onUnhandled = (event: any) => {
            const reasonAsString = String(event.reason);
            if (reasonAsString.includes('TransactionInactiveError') && reasonAsString.includes('IDBObjectStore')) {
                unhandledRejections.push(event.reason);
            }
        };
        window.addEventListener('unhandledrejection', onUnhandled);

        const db = await createRxDatabase({
            name: dbName,
            storage,
            multiInstance: true,
            eventReduce: true,
            ignoreDuplicate: true
        });

        try {
            const collections = await db.addCollections({
                docs: {
                    schema: REPLICATION_SCHEMA
                }
            });
            const replicationState = replicateRxCollection({
                replicationIdentifier: 'issue-8497-repro',
                collection: collections.docs,
                deletedField: '_deleted',
                waitForLeadership: false,
                live: false,
                pull: {
                    batchSize: 200,
                    handler: async (lastCheckpoint: any, batchSize: number) => {
                        const checkpoint = lastCheckpoint ? lastCheckpoint.i + 1 : 0;
                        const documents = docsFromMaster.slice(checkpoint, checkpoint + batchSize);
                        const newCheckpoint = documents.length > 0 ? { i: checkpoint + documents.length - 1 } : lastCheckpoint;
                        return {
                            checkpoint: newCheckpoint,
                            documents
                        };
                    }
                }
            });

            await replicationState.awaitInSync();
            await AsyncTestUtil.waitUntil(() => unhandledRejections.length > 0, WAIT_FOR_UNHANDLED_MS);

            const firstError = String(unhandledRejections[0]);
            if (!firstError.includes(exactMessage)) {
                throw new Error('Unexpected error: ' + firstError);
            }
            throw new Error('Uncaught (in promise) ' + exactMessage);
        } finally {
            window.removeEventListener('unhandledrejection', onUnhandled);
            await db.remove();
        }
    });
});
