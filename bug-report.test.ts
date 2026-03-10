/// <reference path="./node_modules/@types/mocha/index.d.ts" />
/**
 * SQLite bulkUpsert Bug Reproduction Test
 *
 * This test demonstrates data corruption and query inconsistency bugs
 * in the SQLite storage plugin when performing large bulkUpsert operations.
 *
 * To run this test:
 * - 'npm run test:browser' so it runs in the browser with OPFS support
 * - 'npm run test:node'    so it runs in Node.js with node:sqlite
 */
import assert from 'assert';

import {
    createRxDatabase,
    randomToken,
    RxCollection,
    RxDatabase,
    RxJsonSchema
} from 'rxdb/plugins/core';
import {
    isNode
} from 'rxdb/plugins/test-utils';

/** Number of documents to insert for the test */
const DOCUMENT_COUNT = 15000;

// Test schema matching a complex document structure with 20 fields
type TestDocument = {
    id: string;
    name: string | null;
    ticketNumber: number | null;
    posX: number;
    posY: number;
    ticketTypeId: string;
    sortTicketTypeName: string;
    dueDate: string | null;
    userId: string | null;
    sortAssigneeName: string;
    layer: string | null;
    checklistId: string | null;
    checklistName: string | null;
    projectId: string;
    coupleId: string;
    statusId: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    isBlocked: boolean;
};

const testSchema: RxJsonSchema<TestDocument> = {
    title: 'Test Schema',
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: { type: 'string', maxLength: 50 },
        name: { type: ['string', 'null'] },
        ticketNumber: { type: ['number', 'null'] },
        posX: { type: 'number' },
        posY: { type: 'number' },
        ticketTypeId: { type: 'string', maxLength: 50 },
        sortTicketTypeName: { type: 'string' },
        dueDate: { type: ['string', 'null'], maxLength: 50 },
        userId: { type: ['string', 'null'], maxLength: 50 },
        sortAssigneeName: { type: 'string' },
        layer: { type: ['string', 'null'] },
        checklistId: { type: ['string', 'null'], maxLength: 50 },
        checklistName: { type: ['string', 'null'] },
        projectId: { type: 'string', maxLength: 50 },
        coupleId: { type: 'string', maxLength: 50 },
        statusId: { type: 'string', maxLength: 50 },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string', maxLength: 50 },
        deletedAt: { type: ['string', 'null'] },
        isBlocked: { type: 'boolean' },
    },
    required: [
        'id',
        'posX',
        'posY',
        'projectId',
        'coupleId',
        'statusId',
        'createdAt',
        'updatedAt',
    ],
    indexes: ['coupleId', 'projectId', 'statusId', 'updatedAt'],
};

type TestCollections = {
    items: RxCollection<TestDocument>;
};

function generateRandomDocument(index: number): TestDocument {
    return {
        id: `test-${index}-${randomToken(12)}`,
        name: randomToken(10),
        ticketNumber: Math.floor(Math.random() * 99999) + 1,
        posX: Math.random() * 1000,
        posY: Math.random() * 1000,
        ticketTypeId: randomToken(8),
        sortTicketTypeName: randomToken(8),
        dueDate: Math.random() > 0.5 ? randomToken(10) : null,
        userId: Math.random() > 0.5 ? randomToken(12) : null,
        sortAssigneeName: randomToken(10),
        layer: Math.random() > 0.5 ? randomToken(8) : null,
        checklistId: Math.random() > 0.5 ? randomToken(12) : null,
        checklistName: Math.random() > 0.5 ? randomToken(10) : null,
        projectId: `project-${Math.floor(Math.random() * 10) + 1}`,
        coupleId: randomToken(12),
        statusId: `status-${Math.floor(Math.random() * 5) + 1}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        isBlocked: Math.random() < 0.1,
    };
}

// ─── Shared test body ────────────────────────────────────────────────────────

function runBulkUpsertTests(
    label: string,
    getStorage: () => Promise<any>
): void {
    describe(label, () => {
        let db: RxDatabase<TestCollections> | null = null;
        let collection: RxCollection<TestDocument> | null = null;
        let documents: TestDocument[] = [];

        before(async function () {
            this.timeout(120000);
            try {
                const storage = await getStorage();
                const dbName = `bug-test-db-${randomToken(10)}-${Date.now()}`;
                db = await createRxDatabase<TestCollections>({
                    name: dbName,
                    storage,
                    eventReduce: false,
                    multiInstance: false,
                });
                await db.addCollections({ items: { schema: testSchema } });
                collection = db.items;
                documents = Array.from({ length: DOCUMENT_COUNT }, (_, i) =>
                    generateRandomDocument(i)
                );
            } catch (error) {
                console.error('Failed to initialize storage:', error);
            }
        });

        after(async function () {
            this.timeout(30000);
            if (db) {
                await db.close();
            }
        });

        it('should maintain data integrity after large bulkUpsert', async function () {
            this.timeout(120000);
            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            console.log(`Inserting ${DOCUMENT_COUNT} documents via bulkUpsert...`);
            const insertStart = performance.now();
            const insertResult = await collection.bulkUpsert(documents);
            console.log(`Insert: ${(performance.now() - insertStart).toFixed(2)}ms, ${insertResult.success.length} docs`);

            const countAfterInsert = await collection.count().exec();
            assert.strictEqual(countAfterInsert, DOCUMENT_COUNT,
                `Count mismatch after insert: expected ${DOCUMENT_COUNT}, got ${countAfterInsert}`);

            const allDocs = await collection.find().exec();
            assert.strictEqual(allDocs.length, DOCUMENT_COUNT,
                `Retrieved count mismatch: expected ${DOCUMENT_COUNT}, got ${allDocs.length}`);

            const sampleIndices = [0, 100, 500, 1000, 2500, 4999, 8000, 10000, 12000, 13999]
                .filter(i => i < DOCUMENT_COUNT);
            for (const idx of sampleIndices) {
                const orig = documents[idx];
                const retrieved = await collection.findOne({ selector: { id: orig.id } }).exec();
                assert.ok(retrieved, `Document ${orig.id} not found after insert`);
                assert.strictEqual(retrieved!.name, orig.name, `Name mismatch for ${orig.id}`);
                assert.strictEqual(retrieved!.projectId, orig.projectId, `ProjectId mismatch for ${orig.id}`);
            }
            console.log('Verified sample document integrity');
        });

        it('should correctly re-insert documents via bulkUpsert (second pass)', async function () {
            this.timeout(120000);
            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            const existingDocs = await collection.find().exec();
            assert.strictEqual(existingDocs.length, DOCUMENT_COUNT,
                `Expected ${DOCUMENT_COUNT} docs before update, got ${existingDocs.length}`);

            // Remove all docs first to force a fresh re-insert via bulkUpsert.
            // Without this step the second bulkUpsert acts as an update and the bug
            // manifests as only ~75 of 15000 documents being written.
            await collection.bulkRemove(existingDocs.map(doc => doc.primary));

            const updatedTime = new Date().toISOString();
            const updatedDocuments = existingDocs.map((doc) => ({
                ...doc.toJSON(),
                name: `Updated-${doc.name}`,
                projectId: `updated-${doc.projectId}`,
                updatedAt: updatedTime,
            }));

            console.log(`Re-inserting ${updatedDocuments.length} documents via bulkUpsert...`);
            const updateStart = performance.now();
            const updateResult = await collection.bulkUpsert(updatedDocuments);
            console.log(`Re-insert: ${(performance.now() - updateStart).toFixed(2)}ms, ${updateResult.success.length} docs`);

            const countAfterUpdate = await collection.count().exec();
            assert.strictEqual(countAfterUpdate, DOCUMENT_COUNT,
                `Count mismatch after re-insert: expected ${DOCUMENT_COUNT}, got ${countAfterUpdate}`);

            const sampleIndices = [0, 100, 500, 1000, 2500, 4999, 8000, 10000, 12000, 13999]
                .filter(i => i < DOCUMENT_COUNT);
            for (const idx of sampleIndices) {
                const orig = updatedDocuments[idx];
                const retrieved = await collection.findOne({ selector: { id: orig.id } }).exec();
                assert.ok(retrieved, `Document ${orig.id} not found after re-insert`);
                assert.ok(
                    retrieved!.name!.startsWith('Updated-'),
                    `Document ${orig.id} name not updated. Got: ${retrieved!.name}`
                );
                assert.strictEqual(retrieved!.updatedAt, updatedTime,
                    `Document ${orig.id} updatedAt mismatch`);
            }
            console.log('Verified re-insert integrity');
        });

        it('should return correct results for indexed field queries', async function () {
            this.timeout(60000);
            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            const targetProjectId = 'updated-project-5';
            const projectResults = await collection.find({ selector: { projectId: targetProjectId } }).exec();
            for (const doc of projectResults) {
                assert.strictEqual(doc.projectId, targetProjectId,
                    `Wrong projectId: expected ${targetProjectId}, got ${doc.projectId}`);
            }
            assert.ok(projectResults.length > 0, `No docs found with projectId=${targetProjectId}`);
            console.log(`Query by projectId: ${projectResults.length} docs`);

            const targetStatusId = 'status-2';
            const statusResults = await collection.find({ selector: { statusId: targetStatusId } }).exec();
            for (const doc of statusResults) {
                assert.strictEqual(doc.statusId, targetStatusId,
                    `Wrong statusId: expected ${targetStatusId}, got ${doc.statusId}`);
            }
            console.log(`Query by statusId: ${statusResults.length} docs`);
        });

        it('should detect data corruption if present', async function () {
            this.timeout(60000);
            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            const allDocs = await collection.find().exec();
            const corruptionDetails: string[] = [];

            for (const doc of allDocs) {
                if (!doc.id) corruptionDetails.push('Document missing id');
                if (doc.projectId == null) corruptionDetails.push(`Document ${doc.id} missing projectId`);
                if (doc.statusId == null) corruptionDetails.push(`Document ${doc.id} missing statusId`);
                if (doc.createdAt == null) corruptionDetails.push(`Document ${doc.id} missing createdAt`);
                if (doc.updatedAt == null) corruptionDetails.push(`Document ${doc.id} missing updatedAt`);
            }

            const idSet = new Set<string>();
            for (const doc of allDocs) {
                if (idSet.has(doc.id)) corruptionDetails.push(`Duplicate id: ${doc.id}`);
                idSet.add(doc.id);
            }

            if (corruptionDetails.length > 0) {
                assert.fail(
                    `Data corruption (${corruptionDetails.length} issues): ${corruptionDetails.slice(0, 10).join(', ')}`
                );
            }
            console.log(`Integrity check passed: ${allDocs.length} docs, ${idSet.size} unique IDs`);
        });
    });
}

// ─── Node.js test suite (node:sqlite) ────────────────────────────────────────

if (isNode) {
    describe('bug-report.test.ts', () => {
        const { getRxStorageSQLite, getSQLiteBasicsNodeNative } = require('rxdb-premium/plugins/storage-sqlite');
        const { setPremiumFlag } = require('rxdb-premium/plugins/shared');
        const { wrappedValidateAjvStorage: wrapAjv } = require('rxdb/plugins/validate-ajv');
        // Use string concatenation to prevent webpack from trying to bundle node:sqlite
        // as a browser module (it's a Node.js built-in).
        const { DatabaseSync } = require('node:sqlite' + '');
        setPremiumFlag();
        runBulkUpsertTests('SQLite bulkUpsert data corruption (node:sqlite)', async () => {
            return wrapAjv({
                storage: getRxStorageSQLite({ sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync) })
            });
        });
    });
}

// ─── Browser test suite (wa-sqlite + OPFS) ───────────────────────────────────

if (!isNode) {
    describe('bug-report.test.ts', () => {
        function isOPFSAvailable(): boolean {
            return typeof navigator !== 'undefined' &&
                !!navigator.storage &&
                typeof navigator.storage.getDirectory === 'function';
        }

        if (!isOPFSAvailable()) {
            it('skipped: OPFS not available', () => {
                console.log('Skipping SQLite WASM test — OPFS unavailable');
            });
        } else {
            runBulkUpsertTests('SQLite bulkUpsert data corruption (wa-sqlite/OPFS)', async () => {
                const Comlink = await import('comlink');
                const { setPremiumFlag } = await import('rxdb-premium/plugins/shared');
                const { getRxStorageSQLite } = await import('rxdb-premium/plugins/storage-sqlite');
                const { wrappedValidateAjvStorage: wrapAjv } = await import('rxdb/plugins/validate-ajv');

                setPremiumFlag();

                const worker = await new Promise<Worker>((resolve, reject) => {
                    const w = new Worker('/base/test/unit/wa-sqlite-worker.js', { type: 'module' });
                    const timer = setTimeout(() => reject(new Error('Worker init timeout')), 30000);
                    w.onmessage = (e) => {
                        if (e.data?.type === 'ready') { clearTimeout(timer); resolve(w); }
                    };
                    w.onerror = (e) => { clearTimeout(timer); reject(new Error(`Worker error: ${e.message}`)); };
                });

                const workerApi = Comlink.wrap<{
                    open(name: string): Promise<{ nr: number; name: string }>;
                    all(db: { nr: number; name: string }, q: { query: string; params: (string | number | boolean)[] }): Promise<unknown[][]>;
                    run(db: { nr: number; name: string }, q: { query: string; params: (string | number | boolean)[] }): Promise<void>;
                    setPragma(db: { nr: number; name: string }, key: string, value: string): Promise<void>;
                    close(db: { nr: number; name: string }): Promise<void>;
                    shutdown(): Promise<void>;
                }>(worker);

                return wrapAjv({
                    storage: getRxStorageSQLite({
                        sqliteBasics: {
                            open: (name: string) => workerApi.open(name),
                            all: (h: { nr: number; name: string }, q: any) => workerApi.all(h, q),
                            run: (h: { nr: number; name: string }, q: any) => workerApi.run(h, q),
                            setPragma: (h: { nr: number; name: string }, k: string, v: string) => workerApi.setPragma(h, k, v),
                            close: (h: { nr: number; name: string }) => workerApi.close(h),
                            journalMode: 'DELETE' as const,
                        }
                    })
                });
            });
        }
    });
}
