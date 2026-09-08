/**
 * filesystem-node storage: the database randomly becomes corrupt and can no
 * longer be opened, failing with an error like:
 *
 *   SyntaxError: Expected ',' or ']' after array element in JSON at position 525
 *
 * ---------------------------------------------------------------------------
 * ROOT CAUSE
 * ---------------------------------------------------------------------------
 * In `rxdb-premium/plugins/storage-abstract-filesystem/bulk-write.js` ->
 * `bulkWrite()` the serialized event-bulk is appended to `changes.json` like this:
 *
 *   let str = JSON.stringify(categorized.eventBulk);
 *   if (runState.knownChangesFileSize) { str = ',' + str; }
 *   const write = (await writable).write(encoded, {
 *       at: runState.knownChangesFileSize ? runState.knownChangesFileSize : 0
 *   });
 *
 * `runState.knownChangesFileSize` is declared in `TaskQueueRunState` (types.ts)
 * but it is NEVER assigned - unlike `knownChangelogFileSize` (changelog.js) and
 * `knownDocumentFileSize` (documents-file.js), which are both kept up to date.
 * So EVERY bulkWrite() of a TaskQueue write-run writes at offset 0 instead of
 * appending, and the ',' separator is never prepended.
 *
 * The TaskQueue batches multiple bulkWrite() tasks into a single write-run and
 * only flushes `changes.json` between two tasks when the second task writes
 * >= 20 documents or touches a document that was already touched in the same run
 * (see task-queue.js -> triggerWriteTasks()). So two small, independent writes -
 * for example `await Promise.all([docA.patch(...), docB.patch(...)])` - end up in
 * the same run and both write at offset 0:
 *
 *   WRITE changes.json at=0 len=954  sizeBefore=0     <- bulk A
 *   WRITE changes.json at=0 len=455  sizeBefore=954   <- bulk B overwrites the head of A
 *
 * Writing at an offset never truncates, so `changes.json` now contains
 * `<bulk B><tail of bulk A>` and `JSON.parse('[' + content + ']')` - which is
 * exactly what `processChangesFileIfRequired()` does when it reads that file -
 * throws "Expected ',' or ']' after array element in JSON at position <len of bulk B>".
 *
 * During normal operation this stays invisible, because the end-of-run flush
 * prefers the in-memory `runState.knownChangesContent` over the file content and
 * afterwards truncates `changes.json` to 0. But while the write-run is still in
 * flight, the broken bytes ARE on disk. Measured with a randomized workload on
 * 15k documents: `changes.json` on disk was invalid JSON after 629 of 963 writes
 * (65% of the time).
 *
 * So whenever the process goes away before the run finished its final flush
 * (tab closed, reload, crash, OOM, worker terminated, or any error inside the
 * run - the TaskQueue promise chain dies on the first rejection), the corrupt
 * `changes.json` survives on disk. On the next start the very first read or
 * write calls `processChangesFileIfRequired()`, the JSON.parse throws and the
 * database is permanently unusable - it happens randomly, during normal usage,
 * independent of migrations, and it gets more likely the fuller the database is,
 * because a bigger database makes the flush slower, so more write tasks are
 * batched into a single run and the window in which the broken file is on disk
 * gets much bigger.
 *
 * The offending code lives in the shared `storage-abstract-filesystem` layer, so
 * every storage built on it is affected the same way.
 *
 * ---------------------------------------------------------------------------
 * SUGGESTED FIX
 * ---------------------------------------------------------------------------
 * Keep `runState.knownChangesFileSize` up to date in bulkWrite(), the same way
 * `changelog.js` -> `addChangelogOperations()` already does for
 * `knownChangelogFileSize`:
 *
 *   const at = runState.knownChangesFileSize ? runState.knownChangesFileSize : 0;
 *   ...
 *   await (await writable).write(encoded, { at });
 *   runState.knownChangesFileSize = at + encoded.byteLength;
 *
 * and reset it to 0 in processChangesFileIfRequired() after `changesHandle.truncate(0)`.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 */
import assert from 'assert';

import {
    createRxDatabase,
    randomToken,
    addRxPlugin,
    RxCollection
} from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';

import {
    isNode
} from 'rxdb/plugins/test-utils';

/**
 * Node.js-only modules. In the browser bundle these resolve to empty stubs
 * (see the `fallback` config in karma.conf.js) and the test skips itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';


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
    },
    required: ['passportId']
};

describe('bug-report.test.ts', () => {

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);

    it('should fail because it reproduces the bug', async function () {
        this.timeout(20000);

        if (!isNode) {
            /**
             * The filesystem-node storage only exists in Node.js.
             * Run this with 'npm run test:node'.
             */
            this.skip();
            return;
        }

        /**
         * Loaded lazily so that the browser bundle does not try to resolve the
         * Node.js-only dependencies of the filesystem-node storage.
         */
        const storageModule = 'rxdb-premium/plugins/storage-filesystem-node';
        const { getRxStorageFilesystemNode } = await import(/* webpackIgnore: true */ storageModule);

        const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rxdb-filesystem-node-'));
        const databaseName = randomToken(10);
        const collectionName = 'mycollection';

        const db = await createRxDatabase({
            name: databaseName,
            storage: wrappedValidateAjvStorage({
                storage: getRxStorageFilesystemNode({ basePath })
            }),
            eventReduce: true,
            ignoreDuplicate: true
        });
        const collections = await db.addCollections({
            [collectionName]: {
                schema: mySchema as any
            }
        });
        const collection: RxCollection<any> = collections[collectionName];

        await collection.bulkInsert(
            new Array(20).fill(0).map((_v, idx) => ({
                passportId: 'foobar-' + idx,
                firstName: 'Bob',
                lastName: 'Kelso',
                age: 56
            }))
        );

        /**
         * Normal usage: update two documents at the same time.
         * Both writes land in the same TaskQueue write-run and both are written
         * to changes.json at offset 0. The second one is smaller than the first
         * one, so the tail of the first one survives and the file is broken.
         */
        const docA = await collection.findOne('foobar-1').exec(true);
        const docB = await collection.findOne('foobar-9').exec(true);
        await Promise.all([
            docA.patch({ lastName: 'x'.repeat(500) }),
            docB.patch({ lastName: 'y' })
        ]);

        /**
         * Simulate the process going away while the write-run is still open,
         * by copying the database files exactly as they are on disk right now.
         *
         * Everything in this block is synchronous on purpose: after the last
         * write task resolved, the write-run waits 10ms for further tasks before
         * it does its final flush + truncate(0), so as long as we do not yield to
         * the event loop we copy exactly the bytes that a killed process would
         * have left behind.
         */
        const crashedBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rxdb-filesystem-node-crashed-'));
        fs.cpSync(basePath, crashedBasePath, { recursive: true });

        /**
         * Let the original database finish normally so that it releases its
         * web-locks. It only touches its own files in basePath, the copy we
         * took above is not affected by this.
         */
        await db.close();

        const changesFilePath = path.join(
            crashedBasePath,
            'rxdb-' + databaseName + '-' + collectionName + '-0',
            'changes.json'
        );
        const changesFileContent = fs.readFileSync(changesFilePath, 'utf-8');

        /**
         * processChangesFileIfRequired() reads changes.json back with
         * JSON.parse('[' + content + ']'), so that must always work.
         */
        let changesFileParseError: Error | undefined;
        try {
            JSON.parse('[' + changesFileContent + ']');
        } catch (err) {
            changesFileParseError = err as Error;
            console.log(
                'changes.json on disk (' + changesFileContent.length + ' bytes), ' +
                'JSON.parse("[" + content + "]") fails with: ' + changesFileParseError.message
            );
            console.log('content around the corruption: ' + JSON.stringify(
                changesFileContent.substring(Math.max(0, changesFileContent.length - 60))
            ));
        }

        /**
         * Reopen the database on exactly the files that were on disk at that
         * moment, like a process that was killed and started again.
         * The first read triggers processChangesFileIfRequired(), the JSON.parse
         * throws inside of the TaskQueue promise chain, the queue dies and the
         * query never resolves -> the database is permanently unusable.
         */
        const reopenedDb = await createRxDatabase({
            name: databaseName,
            storage: wrappedValidateAjvStorage({
                storage: getRxStorageFilesystemNode({ basePath: crashedBasePath })
            }),
            eventReduce: true,
            ignoreDuplicate: true
        });
        const reopenedCollections = await reopenedDb.addCollections({
            [collectionName]: {
                schema: mySchema as any
            }
        });

        /**
         * The TaskQueue swallows the error into its own promise chain, so the
         * query below never resolves and never rejects. Catch it here to show
         * what actually killed the database.
         */
        const taskQueueErrors: Error[] = [];
        const onUnhandledRejection = (err: any) => taskQueueErrors.push(err);
        process.on('unhandledRejection', onUnhandledRejection);
        const readResult = await Promise.race([
            reopenedCollections[collectionName].find().exec().then(() => 'read-worked'),
            new Promise<string>(res => setTimeout(() => res('read-never-resolved'), 3000))
        ]);
        process.off('unhandledRejection', onUnhandledRejection);

        console.log('reading the reopened database: ' + readResult);
        taskQueueErrors.forEach(err => console.log(
            'the RxStorage task-queue died with: ' + err.message
        ));

        assert.strictEqual(
            readResult,
            'read-worked',
            'the database can no longer be read after the write-run was interrupted'
        );
        assert.strictEqual(
            changesFileParseError,
            undefined,
            'changes.json must always contain valid JSON on disk'
        );
    });
});
