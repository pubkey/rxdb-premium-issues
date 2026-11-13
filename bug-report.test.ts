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
    addRxPlugin,
    deepEqual,
    type RxStorage,
    type WithDeleted
} from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { replicateRxCollection } from 'rxdb/plugins/replication';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

import {
    isNode
} from 'rxdb/plugins/test-utils';

/**
 * Replication pushes documents from an interrupted pull back to the master as local writes.
 * Related: https://github.com/pubkey/rxdb/issues/9322
 *
 * When the process stops after the downstream wrote pulled documents to the fork but before it
 * wrote their assumed master state and checkpoint, the next start pushes those documents back,
 * although nothing changed them locally:
 * - Documents new to the fork lose `_meta.o` on insert and are pushed without an assumed master
 *   state (the case in #9322).
 * - Documents the fork already had keep `_meta.o`, but the upstream never checks it, so they are
 *   pushed with the stale assumed master state from the last completed pull.
 *
 * The second case loses data on a master that follows the replication protocol: when the master
 * document has changed back to the stale assumed master state, the master accepts the push as a
 * local write and stores the values from the interrupted pull over newer ones.
 */
type Patient = { id: string; address: string };
type Checkpoint = { seq: number; id: string };
type PushedRow = { id: string; assumedMaster: string | null; pushed: string };

describe('bug-report.test.ts', () => {

    addRxPlugin(RxDBDevModePlugin);

    it('should not push documents from an interrupted pull back to the master', async function () {

        const name = randomToken(10);
        let baseStorage: RxStorage<any, any>;
        let removeDatabaseFiles = async () => { };
        if (isNode) {
            // SQLite is only available in Node.js; use dynamic imports so the browser
            // bundle never tries to include native Node-only dependencies.
            const { DatabaseSync } = await import('node:sqlite' + '');
            const { getRxStorageSQLite, getSQLiteBasicsNodeNative } = await import('rxdb-premium/plugins/storage-sqlite' + '');
            baseStorage = getRxStorageSQLite({
                sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync)
            });
            removeDatabaseFiles = async () => {
                const { rm } = await import('node:fs/promises' + '');
                await Promise.all(['', '-wal', '-shm'].map(suffix => rm(name + suffix, { force: true })));
            };
        } else {
            baseStorage = getRxStorageMemory();
        }

        /**
         * Simulates the process stopping after the downstream wrote pulled documents to the fork:
         * while enabled, writes to the replication meta instance (assumed master states and
         * checkpoints) never reach the storage.
         */
        let processStopsBeforeMetaWrites = false;
        const storage = wrappedValidateAjvStorage({
            storage: {
                ...baseStorage,
                async createStorageInstance(params) {
                    const instance = await baseStorage.createStorageInstance(params);
                    if (params.collectionName.startsWith('rx-replication-meta-')) {
                        const bulkWrite = instance.bulkWrite.bind(instance);
                        instance.bulkWrite = (rows, context) =>
                            processStopsBeforeMetaWrites ? Promise.resolve({ error: [] }) : bulkWrite(rows, context);
                    }
                    return instance;
                }
            } as RxStorage<any, any>
        });

        /**
         * A master that follows the replication protocol: it refuses a write as a conflict when
         * the assumed master state differs from its current state, and stores it otherwise.
         */
        let seq = 0;
        const master = new Map<string, { doc: WithDeleted<Patient>; seq: number }>();
        const writeOnMaster = (doc: Patient) => {
            seq = seq + 1;
            master.set(doc.id, { doc: { ...doc, _deleted: false }, seq });
        };
        const masterAddresses = () => Object.fromEntries(
            Array.from(master.values()).map(({ doc }) => [doc.id, doc.address])
        );
        const pushedRows: PushedRow[] = [];
        /**
         * Pull responses arrive after a network delay, so on start the upstream reads the fork
         * before the downstream writes pulled documents to it, as on a device.
         */
        const PULL_LATENCY_MS = 100;

        const schema = {
            version: 0,
            primaryKey: 'id',
            type: 'object',
            properties: {
                id: { type: 'string', maxLength: 100 },
                address: { type: 'string' }
            },
            required: ['id', 'address']
        } as const;

        /**
         * Each session is one start of the app: open the database, run the replication once, close.
         */
        const session = async () => {
            const db = await createRxDatabase({ name, storage, ignoreDuplicate: true });
            await db.addCollections({ patients: { schema } });
            const replication = replicateRxCollection<Patient, Checkpoint>({
                collection: db.patients,
                replicationIdentifier: 'patients-' + name,
                live: false,
                pull: {
                    batchSize: 100,
                    async handler(checkpoint, batchSize) {
                        await new Promise(resolve => setTimeout(resolve, PULL_LATENCY_MS));
                        const after = checkpoint ?? { seq: 0, id: '' };
                        const documents = Array.from(master.values())
                            .filter(entry => entry.seq > after.seq)
                            .sort((a, b) => a.seq - b.seq)
                            .slice(0, batchSize);
                        const last = documents[documents.length - 1];
                        return {
                            documents: documents.map(entry => ({ ...entry.doc })),
                            checkpoint: last ? { seq: last.seq, id: last.doc.id } : after
                        };
                    }
                },
                push: {
                    batchSize: 100,
                    async handler(rows) {
                        const conflicts: WithDeleted<Patient>[] = [];
                        for (const row of rows) {
                            pushedRows.push({
                                id: row.newDocumentState.id,
                                assumedMaster: row.assumedMasterState ? row.assumedMasterState.address : null,
                                pushed: row.newDocumentState.address
                            });
                            const current = master.get(row.newDocumentState.id);
                            if (current && (!row.assumedMasterState || !deepEqual(
                                { id: row.assumedMasterState.id, address: row.assumedMasterState.address },
                                { id: current.doc.id, address: current.doc.address }
                            ))) {
                                conflicts.push({ ...current.doc });
                            } else {
                                writeOnMaster({ id: row.newDocumentState.id, address: row.newDocumentState.address });
                            }
                        }
                        return conflicts;
                    }
                }
            });
            const errors: any[] = [];
            replication.error$.subscribe(error => errors.push(error));
            await replication.awaitInitialReplication();
            await replication.cancel();
            const deviceAddresses = Object.fromEntries(
                (await db.patients.find().exec()).map(doc => [doc.id, doc.address])
            );
            return { db, errors, deviceAddresses };
        };

        try {
            // Session 1 pulls patients A and C.
            writeOnMaster({ id: 'A', address: 'A v1' });
            writeOnMaster({ id: 'C', address: 'C v1' });
            await (await session()).db.close();

            // Elsewhere, A and C change and B is created.
            writeOnMaster({ id: 'A', address: 'A v2' });
            writeOnMaster({ id: 'C', address: 'C v2' });
            writeOnMaster({ id: 'B', address: 'B v1' });

            // Session 2 pulls them, but the process stops before the replication meta writes.
            processStopsBeforeMetaWrites = true;
            const interrupted = await session();
            processStopsBeforeMetaWrites = false;
            assert.deepStrictEqual(interrupted.deviceAddresses, { A: 'A v2', B: 'B v1', C: 'C v2' });
            await interrupted.db.close();

            // Elsewhere, all three change again; C changes back to its earlier value.
            writeOnMaster({ id: 'A', address: 'A v3' });
            writeOnMaster({ id: 'B', address: 'B v2' });
            writeOnMaster({ id: 'C', address: 'C v1' });

            // Session 3 is a normal start. Nothing changed a document locally.
            const restart = await session();
            const actual = {
                replicationErrors: restart.errors.length,
                pushedRows,
                master: masterAddresses(),
                device: restart.deviceAddresses
            };
            await restart.db.remove();

            assert.deepStrictEqual(actual, {
                replicationErrors: 0,
                pushedRows: [],
                master: { A: 'A v3', B: 'B v2', C: 'C v1' },
                device: { A: 'A v3', B: 'B v2', C: 'C v1' }
            });
        } finally {
            await removeDatabaseFiles();
        }
    });
});
