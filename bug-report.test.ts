/// <reference path="./node_modules/@types/mocha/index.d.ts" />
/**
 * SQLite bulkUpsert Bug Reproduction Test
 *
 * This test demonstrates data corruption and query inconsistency bugs
 * in the SQLite storage plugin when performing large bulkUpsert operations.
 *
 * To run this test:
 * - 'npm run test:browser' so it runs in the browser with OPFS support
 */
import assert from 'assert';
import { faker } from '@faker-js/faker';

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
import {
    wrappedValidateAjvStorage
} from 'rxdb/plugins/validate-ajv';
import * as Comlink from 'comlink';
import { setPremiumFlag } from 'rxdb-premium/plugins/shared';
import { getRxStorageSQLite } from 'rxdb-premium/plugins/storage-sqlite';

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

declare global {
    interface Window {
        db: RxDatabase<TestCollections> | null;
    }
}

function generateRandomDocument(index: number): TestDocument {
    const createdAt = faker.date.past({ years: 1 }).toISOString();
    const updatedAt = faker.date.between({ from: createdAt, to: new Date() }).toISOString();
    const hasDueDate = faker.datatype.boolean();
    const hasUserId = faker.datatype.boolean();
    const hasLayer = faker.datatype.boolean();
    const hasChecklist = faker.datatype.boolean();

    return {
        id: `test-${index}-${faker.string.uuid()}`,
        name: faker.company.catchPhrase(),
        ticketNumber: faker.number.int({ min: 1, max: 99999 }),
        posX: faker.number.float({ min: 0, max: 1000, fractionDigits: 2 }),
        posY: faker.number.float({ min: 0, max: 1000, fractionDigits: 2 }),
        ticketTypeId: `type-${faker.number.int({ min: 1, max: 10 })}`,
        sortTicketTypeName: faker.commerce.department(),
        dueDate: hasDueDate ? faker.date.future({ years: 1 }).toISOString() : null,
        userId: hasUserId ? faker.string.uuid() : null,
        sortAssigneeName: faker.person.fullName(),
        layer: hasLayer ? `layer-${faker.number.int({ min: 1, max: 5 })}` : null,
        checklistId: hasChecklist ? faker.string.uuid() : null,
        checklistName: hasChecklist ? faker.lorem.words({ min: 2, max: 4 }) : null,
        projectId: `project-${faker.number.int({ min: 1, max: 10 })}`,
        coupleId: faker.string.uuid(),
        statusId: `status-${faker.number.int({ min: 1, max: 5 })}`,
        createdAt,
        updatedAt,
        deletedAt: null,
        isBlocked: faker.datatype.boolean({ probability: 0.1 }),
    };
}

/**
 * Creates SQLite worker from the served wa-sqlite-worker.js file.
 * The worker file is served by karma at /base/test/unit/wa-sqlite-worker.js
 * Returns a promise that resolves when the worker is ready.
 */
function createSQLiteWorker(): Promise<Worker> {
    return new Promise((resolve, reject) => {
        const workerUrl = '/base/test/unit/wa-sqlite-worker.js';
        console.log('Creating worker from:', workerUrl);

        const worker = new Worker(workerUrl, { type: 'module', name: 'SQLite Bug Test Worker' });

        const timeout = setTimeout(() => {
            reject(new Error('Worker initialization timeout'));
        }, 30000);

        worker.onmessage = (event) => {
            if (event.data?.type === 'ready') {
                clearTimeout(timeout);
                console.log('Worker signaled ready');
                resolve(worker);
            }
        };

        worker.onerror = (event) => {
            clearTimeout(timeout);
            console.error('Worker error:', event.message, event.filename, event.lineno);
            reject(new Error(`Worker error: ${event.message}`));
        };
    });
}

/**
 * Check if OPFS is available (required for wa-sqlite OPFS VFS)
 */
function isOPFSAvailable(): boolean {
    return typeof navigator !== 'undefined' &&
        !!navigator.storage &&
        typeof navigator.storage.getDirectory === 'function';
}

describe('bug-report.test.js', () => {
    describe('SQLite bulkUpsert data corruption', () => {
        // Skip test in Node.js environment (requires browser with OPFS)
        if (isNode) {
            it('skipped: SQLite WASM test requires browser environment with OPFS', () => {
                console.log('Skipping SQLite WASM test in Node.js environment');
            });
            return;
        }

        let db: RxDatabase<TestCollections> | null = null;
        let collection: RxCollection<TestDocument> | null = null;
        let worker: Worker | null = null;
        let documents: TestDocument[] = [];

        before(async function() {
            this.timeout(120000); // SQLite WASM initialization can be slow

            // Check for OPFS support
            if (!isOPFSAvailable()) {
                console.log('OPFS not available, skipping SQLite WASM test');
                return;
            }
            console.log('OPFS is available, proceeding with SQLite WASM test setup');
            try {
                setPremiumFlag();
                console.log("Premium flag set, initializing SQLite worker...");
                // Create worker from external wa-sqlite-worker.js file
                worker = await createSQLiteWorker();
                console.log("SQLite worker created, setting up Comlink API...");
                const workerApi = Comlink.wrap<{
                    open(name: string): Promise<{ nr: number; name: string }>;
                    all(db: { nr: number; name: string }, query: { query: string; params: (string | number | boolean)[]; context?: unknown }): Promise<unknown[][]>;
                    run(db: { nr: number; name: string }, query: { query: string; params: (string | number | boolean)[]; context?: unknown }): Promise<void>;
                    setPragma(db: { nr: number; name: string }, key: string, value: string): Promise<void>;
                    close(db: { nr: number; name: string }): Promise<void>;
                    shutdown(): Promise<void>;
                }>(worker);
                console.log("SQLite worker created and Comlink API set up");

                // Create SQLite basics adapter
                const sqliteBasics = {
                    open: async (name: string) => workerApi.open(name),
                    all: async (dbHandle: { nr: number; name: string }, queryWithParams: { query: string; params: (string | number | boolean)[]; context?: unknown }) => {
                        return workerApi.all(dbHandle, queryWithParams);
                    },
                    run: async (dbHandle: { nr: number; name: string }, queryWithParams: { query: string; params: (string | number | boolean)[]; context?: unknown }) => {
                        return workerApi.run(dbHandle, queryWithParams);
                    },
                    setPragma: async (dbHandle: { nr: number; name: string }, key: string, value: string) => {
                        return workerApi.setPragma(dbHandle, key, value);
                    },
                    close: async (dbHandle: { nr: number; name: string }) => {
                        return workerApi.close(dbHandle);
                    },
                    journalMode: 'DELETE' as const,
                };

                const storage = wrappedValidateAjvStorage({
                    storage: getRxStorageSQLite({ sqliteBasics })
                });
                console.log("Wrapped SQLite storage created, initializing RxDatabase...");

                const dbName = `bug-test-db-${randomToken(10)}-${Date.now()}`;
                db = await createRxDatabase<TestCollections>({
                    name: dbName,
                    storage,
                    eventReduce: false,
                    multiInstance: false,
                });

                console.log("RxDatabase initialized.");

                await db.addCollections({
                    items: { schema: testSchema },
                });
                console.log("Collections added to database.");

                collection = db.items;

                // Generate test documents
                documents = Array.from({ length: DOCUMENT_COUNT }, (_, i) =>
                    generateRandomDocument(i)
                );
                window.db = db;
                if (window.top && window.top !== window) {
                    (window.top as any).db = db;
                }

            } catch (error) {
                console.error('Failed to initialize SQLite WASM storage:', error);
            }
        });

        after(async function() {
            this.timeout(30000);
            if (db) {
                await db.close();
            }
            if (worker) {
                worker.terminate();
            }
        });

        it('should maintain data integrity after large bulkUpsert', async function() {
            this.timeout(120000);

            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            // 1. Insert documents via bulkUpsert
            console.log(`Inserting ${DOCUMENT_COUNT} documents via bulkUpsert...`);
            const insertStart = performance.now();
            const insertResult = await collection.bulkUpsert(documents);
            const insertEnd = performance.now();
            console.log(`Insert completed in ${(insertEnd - insertStart).toFixed(2)}ms`);
            console.log(`Insert result: ${insertResult.length} documents processed`);

            // 2. Verify document count matches expected
            const countAfterInsert = await collection.count().exec();
            console.log(`Document count after insert: ${countAfterInsert}`);
            assert.strictEqual(
                countAfterInsert,
                DOCUMENT_COUNT,
                `Document count mismatch after insert: expected ${DOCUMENT_COUNT}, got ${countAfterInsert}`
            );
            console.log(`Verified document count: ${countAfterInsert}`);

            // 3. Verify all documents can be retrieved
            console.log('Fetching all documents to verify retrieval...');
            const allDocs = await collection.find().exec();
            console.log(`Retrieved ${allDocs.length} documents`);
            assert.strictEqual(
                allDocs.length,
                DOCUMENT_COUNT,
                `Retrieved document count mismatch: expected ${DOCUMENT_COUNT}, got ${allDocs.length}`
            );

            // Log sample of first few documents
            console.log('Sample documents after insert:');
            allDocs.slice(0, 3).forEach((doc, i) => {
                console.log(`  Doc ${i}: id=${doc.id}, name=${doc.name}, projectId=${doc.projectId}`);
            });

            // 4. Verify some documents have correct field values
            const sampleIndices = [0, 100, 500, 1000, 2500, 4999, 8000, 10000, 12000, 13999].filter(i => i < DOCUMENT_COUNT);
            for (const idx of sampleIndices) {
                const originalDoc = documents[idx];
                const retrievedDoc = await collection.findOne({
                    selector: { id: originalDoc.id }
                }).exec();
                console.log(`Retrieved document ${originalDoc.id}: ${retrievedDoc!.toJSON().name} ${retrievedDoc!.toJSON().projectId}`);
                assert.ok(
                    retrievedDoc,
                    `Document with id ${originalDoc.id} not found after insert`
                );

                assert.strictEqual(
                    retrievedDoc!.name,
                    originalDoc.name,
                    `Name mismatch for document ${originalDoc.id}`
                );

                assert.strictEqual(
                    retrievedDoc!.projectId,
                    originalDoc.projectId,
                    `ProjectId mismatch for document ${originalDoc.id}`
                );
            }
            console.log('Verified sample document integrity');
        });

        it('should correctly update documents via bulkUpsert (second pass)', async function() {
            this.timeout(120000);

            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            // Get existing documents
            const existingDocs = await collection.find().exec();
            assert.strictEqual(
                existingDocs.length,
                DOCUMENT_COUNT,
                `Expected ${DOCUMENT_COUNT} documents before update, got ${existingDocs.length}`
            );
            await collection.bulkRemove(existingDocs.map(doc => doc.primary));
            // Documents are removed first to force a fresh re-insert via bulkUpsert.
            // Without this remove step, the second bulkUpsert acts as an update —
            // and the bug manifests as only ~75 of 15000 documents being written.

            const updatedTime = new Date().toISOString();
            const updatedDocuments = existingDocs.map((doc) => ({
                ...doc.toJSON(),
                name: `Updated ${doc.name}`,
                projectId: `updated-${doc.projectId}`,
                updatedAt: updatedTime,
            }));

            console.log(`Updating ${updatedDocuments.length} documents via bulkUpsert...`);
            const updateStart = performance.now();
            const updateResult = await collection.bulkUpsert(updatedDocuments);
            const updateEnd = performance.now();
            console.log(`Update completed in ${(updateEnd - updateStart).toFixed(2)}ms`);
            console.log(`Update result: ${updateResult.length} documents processed`);

            // Verify count is unchanged (should be inserts after remove)
            const countAfterUpdate = await collection.count().exec();
            assert.strictEqual(
                countAfterUpdate,
                DOCUMENT_COUNT,
                `Document count changed after update: expected ${DOCUMENT_COUNT}, got ${countAfterUpdate}`
            );

            // Verify updates were applied
            const sampleIndices = [0, 100, 500, 1000, 2500, 4999, 8000, 10000, 12000, 13999].filter(i => i < DOCUMENT_COUNT);
            for (const idx of sampleIndices) {
                const originalDoc = updatedDocuments[idx];
                const retrievedDoc = await collection.findOne({
                    selector: { id: originalDoc.id }
                }).exec();
                console.log(`Retrieved document ${originalDoc.id}: ${retrievedDoc!.toJSON().name} ${retrievedDoc!.toJSON().projectId}`);
                assert.ok(
                    retrievedDoc,
                    `Document with id ${originalDoc.id} not found after update`
                );

                assert.ok(
                    retrievedDoc!.name!.startsWith('Updated'),
                    `Document ${originalDoc.id} name was not updated. Got: ${retrievedDoc!.name}`
                );

                assert.strictEqual(
                    retrievedDoc!.updatedAt,
                    updatedTime,
                    `Document ${originalDoc.id} updatedAt mismatch`
                );
            }
            console.log('Verified update integrity');
        });

        it('should return correct results for indexed field queries', async function() {
            this.timeout(60000);

            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            // Query by indexed field: projectId
            const targetProjectId = 'updated-project-5';
            const queryStart = performance.now();
            const projectResults = await collection.find({
                selector: { projectId: targetProjectId }
            }).exec();
            const queryEnd = performance.now();

            console.log(`Query by projectId took ${(queryEnd - queryStart).toFixed(2)}ms, found ${projectResults.length} documents`);

            // Verify all returned documents have the correct projectId
            for (const doc of projectResults) {
                assert.strictEqual(
                    doc.projectId,
                    targetProjectId,
                    `Query returned document with wrong projectId: expected ${targetProjectId}, got ${doc.projectId}`
                );
            }

            // Verify query returned expected number of results
            assert.ok(
                projectResults.length > 0,
                `Query by projectId returned no results (expected some documents with projectId=${targetProjectId})`
            );

            console.log(`Query consistency verified: ${projectResults.length} documents match projectId=${targetProjectId}`);

            // Query by another indexed field: statusId
            const targetStatusId = 'status-2';
            const statusResults = await collection.find({
                selector: { statusId: targetStatusId }
            }).exec();

            for (const doc of statusResults) {
                assert.strictEqual(
                    doc.statusId,
                    targetStatusId,
                    `Query returned document with wrong statusId: expected ${targetStatusId}, got ${doc.statusId}`
                );
            }

            console.log(`Query by statusId verified: ${statusResults.length} documents match statusId=${targetStatusId}`);
        });

        it('should detect data corruption if present', async function() {
            this.timeout(60000);

            if (!collection) {
                console.log('Collection not initialized, skipping test');
                return;
            }

            // Comprehensive integrity check
            console.log('Running comprehensive data integrity check...');
            const allDocs = await collection.find().exec();
            console.log(`Checking ${allDocs.length} documents for corruption...`);
            let corruptionDetected = false;
            const corruptionDetails: string[] = [];

            // Check for null/undefined required fields
            for (const doc of allDocs) {
                if (!doc.id) {
                    corruptionDetected = true;
                    corruptionDetails.push(`Document missing id`);
                }
                if (doc.projectId === undefined || doc.projectId === null) {
                    corruptionDetected = true;
                    corruptionDetails.push(`Document ${doc.id} missing projectId`);
                }
                if (doc.statusId === undefined || doc.statusId === null) {
                    corruptionDetected = true;
                    corruptionDetails.push(`Document ${doc.id} missing statusId`);
                }
                if (doc.createdAt === undefined || doc.createdAt === null) {
                    corruptionDetected = true;
                    corruptionDetails.push(`Document ${doc.id} missing createdAt`);
                }
                if (doc.updatedAt === undefined || doc.updatedAt === null) {
                    corruptionDetected = true;
                    corruptionDetails.push(`Document ${doc.id} missing updatedAt`);
                }
            }

            // Check for duplicate IDs
            const idSet = new Set<string>();
            for (const doc of allDocs) {
                if (idSet.has(doc.id)) {
                    corruptionDetected = true;
                    corruptionDetails.push(`Duplicate document id: ${doc.id}`);
                }
                idSet.add(doc.id);
            }

            if (corruptionDetected) {
                console.error('Data corruption detected:', corruptionDetails.slice(0, 10));
                assert.fail(`Data corruption detected: ${corruptionDetails.length} issues found. First 10: ${corruptionDetails.slice(0, 10).join(', ')}`);
            }

            console.log('No data corruption detected in comprehensive check');
            console.log(`Final integrity summary: ${allDocs.length} documents, ${idSet.size} unique IDs`);
        });
    });
});
