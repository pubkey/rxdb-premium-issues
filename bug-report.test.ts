import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createRxDatabase,
    randomToken
} from 'rxdb/plugins/core';
import { replicateRxCollection } from 'rxdb/plugins/replication';
import {
    getRxStorageSQLite,
    getSQLiteBasicsNodeNative
} from 'rxdb-premium/plugins/storage-sqlite';

describe('bug-report.test.ts', () => {
    it('poisons later SQLite writes when cancellation closes replication metadata mid-write', async () => {
        const db = await createRxDatabase({
            name: join(tmpdir(), randomToken(10)),
            storage: getRxStorageSQLite({
                sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync)
            })
        });
        const { documents } = await db.addCollections({
            documents: {
                schema: {
                    version: 0,
                    primaryKey: 'id',
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            maxLength: 100
                        }
                    }
                }
            }
        });

        let downstreamWriteCompleted!: () => void;
        const downstreamWriteCompletion = new Promise<void>(resolve => {
            downstreamWriteCompleted = resolve;
        });
        let releaseDownstreamWrite!: () => void;
        const downstreamWriteRelease = new Promise<void>(resolve => {
            releaseDownstreamWrite = resolve;
        });

        const storageInstance: any = documents.storageInstance;
        const bulkWrite = storageInstance.bulkWrite.bind(storageInstance);
        storageInstance.bulkWrite = async (...args: any[]) => {
            const result = await bulkWrite(...args);
            downstreamWriteCompleted();
            await downstreamWriteRelease;
            return result;
        };

        const replication = replicateRxCollection({
            collection: documents,
            replicationIdentifier: 'closed-meta-reproduction',
            live: true,
            autoStart: false,
            pull: {
                async handler() {
                    return {
                        documents: [
                            {
                                id: 'replicated-document',
                                _deleted: false
                            }
                        ],
                        checkpoint: 1
                    };
                },
                batchSize: 10
            },
            push: {
                async handler() {
                    return [];
                },
                batchSize: 10
            }
        });

        await replication.start();
        await downstreamWriteCompletion;

        const downstreamQueue = (replication as any).internalReplicationState.streamQueue.down;
        await replication.cancel();
        releaseDownstreamWrite();

        // The replication metadata write fails here and poisons SQLite's transaction queue.
        await downstreamQueue.catch(() => { });

        // An unrelated insert surfaces the earlier replication metadata error.
        await documents.insert({
            id: 'unrelated-local-document'
        });
    });
});
