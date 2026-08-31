/**
 * OPFS (sync-access-handle) storage: the database randomly becomes corrupt and
 * can no longer be opened, failing with an error like:
 *
 *   SyntaxError: Expected ',' or ']' after array element in JSON at position 456
 *
 * ---------------------------------------------------------------------------
 * ROOT CAUSE
 * ---------------------------------------------------------------------------
 * The bug is NOT in the OPFS bindings, it is in the shared storage layer
 * `rxdb-premium/plugins/storage-abstract-filesystem` which OPFS, OPFS-main-thread,
 * filesystem-node and filesystem-expo all build on. Therefore it can be reproduced
 * with any AbstractFilesystem implementation (this test uses a minimal in-memory
 * one so that it runs in Node.js AND in the browser; it was also verified against
 * the real `getRxStorageFilesystemNode()`).
 *
 * In `storage-abstract-filesystem/bulk-write.js` -> `bulkWrite()` the serialized
 * event-bulk is appended to `changes.json` like this:
 *
 *   let str = JSON.stringify(categorized.eventBulk);
 *   if (runState.knownChangesFileSize) { str = ',' + str; }
 *   const write = (await writable).write(encoded, {
 *       at: runState.knownChangesFileSize ? runState.knownChangesFileSize : 0
 *   });
 *
 * `runState.knownChangesFileSize` is declared in `TaskQueueRunState` (types.ts) but
 * it is NEVER assigned. So EVERY bulkWrite() of a TaskQueue write-run writes at
 * offset 0 instead of appending at the end of the file.
 *
 * The TaskQueue batches multiple bulkWrite() tasks into a single write-run and it
 * only flushes `changes.json` between two tasks when the second task writes >= 20
 * documents or touches a document that was already touched in the same run
 * (see task-queue.js -> triggerWriteTasks()). So two small, independent writes -
 * for example `await Promise.all([docA.patch(...), docB.patch(...)])` - end up in
 * the same run and both write at offset 0:
 *
 *   WRITE changes.json at=0 len=954  sizeBefore=0     <- bulk A
 *   WRITE changes.json at=0 len=455  sizeBefore=954   <- bulk B overwrites the head of A
 *
 * `changes.json` now contains `<bulk B><tail of bulk A>` and
 * `JSON.parse('[' + content + ']')` - which is exactly what
 * `processChangesFileIfRequired()` does when it reads that file - throws
 * "Expected ',' or ']' after array element in JSON at position <len of bulk B>".
 *
 * During normal operation this stays invisible, because the end-of-run flush
 * prefers the in-memory `runState.knownChangesContent` over the file content and
 * afterwards truncates `changes.json` to 0. But while the write-run is still in
 * flight, the broken bytes ARE on disk. Measured with a randomized workload on
 * 15k documents: `changes.json` on disk was invalid JSON after 629 of 963 writes
 * (65% of the time).
 *
 * So whenever the tab / worker goes away before the run finished its final flush
 * (tab closed, reload, browser crash, OOM, worker terminated, or any error inside
 * the run - the TaskQueue promise chain dies on the first rejection), the corrupt
 * `changes.json` survives on disk. On the next start the very first read or write
 * calls `processChangesFileIfRequired()`, the JSON.parse throws and the database is
 * permanently unusable - which matches the customer report:
 *   - happens randomly, during normal usage, independent of migrations
 *   - more likely on filled up databases, because a bigger database makes the
 *     flush slower, so more write tasks are batched into a single run and the
 *     window in which the broken file is on disk gets much bigger
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
 * - 'npm run test:browser' so it runs in the browser
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

import { getRxStorageAbstractFilesystem } from 'rxdb-premium/plugins/storage-abstract-filesystem';


/**
 * A minimal in-memory AbstractFilesystem that behaves like the OPFS
 * FileSystemSyncAccessHandle bindings in
 * rxdb-premium/plugins/storage-opfs/worker-filesystem.js:
 * - write(data, {at}) writes the bytes at the given offset and grows the file
 * - read(from, to) returns exactly (to - from) bytes, zero-filled behind EOF
 * - truncate(len) / getSize()
 * Because everything is stored as plain bytes we can take a snapshot of the
 * "disk" at any point in time and later reopen a database on exactly those bytes.
 */
type FileMap = Map<string, Uint8Array>;

function snapshotFiles(files: FileMap): FileMap {
    const ret: FileMap = new Map();
    Array.from(files.entries()).forEach(entry => {
        ret.set(entry[0], new Uint8Array(entry[1]));
    });
    return ret;
}

class MemoryWritable {
    constructor(
        public files: FileMap,
        public path: string,
        public onWrite: (path: string) => void
    ) { }
    write(data: Uint8Array, options: { at: number; }) {
        const before = this.files.get(this.path) as Uint8Array;
        const next = new Uint8Array(Math.max(before.byteLength, options.at + data.byteLength));
        next.set(before, 0);
        next.set(data, options.at);
        this.files.set(this.path, next);
        this.onWrite(this.path);
    }
    close() { }
}

class MemoryAccessHandle {
    constructor(
        public files: FileMap,
        public path: string,
        public onWrite: (path: string) => void
    ) { }
    read(from: number, to?: number) {
        const content = this.files.get(this.path) as Uint8Array;
        const end = typeof to === 'number' ? to : content.byteLength;
        const ret = new Uint8Array(Math.max(0, end - from));
        ret.set(content.subarray(from, Math.min(end, content.byteLength)));
        return ret;
    }
    getWritable() {
        return new MemoryWritable(this.files, this.path, this.onWrite);
    }
    truncate(len: number) {
        const content = this.files.get(this.path) as Uint8Array;
        const next = new Uint8Array(len);
        next.set(content.subarray(0, Math.min(len, content.byteLength)));
        this.files.set(this.path, next);
        this.onWrite(this.path);
    }
    getSize() {
        return (this.files.get(this.path) as Uint8Array).byteLength;
    }
    close() { }
}

class MemoryFileHandle {
    constructor(
        public files: FileMap,
        public path: string,
        public name: string,
        public onWrite: (path: string) => void
    ) { }
    async createAccessHandle() {
        return new MemoryAccessHandle(this.files, this.path, this.onWrite);
    }
}

class MemoryDirectory {
    constructor(
        public files: FileMap,
        public path: string,
        public onWrite: (path: string) => void
    ) { }
    async getDirectoryHandle(name: string) {
        return new MemoryDirectory(this.files, this.path + name + '/', this.onWrite);
    }
    async getFileHandle(filename: string, options: { create: boolean; }) {
        const fullPath = this.path + filename;
        if (!this.files.has(fullPath)) {
            if (!options.create) {
                throw new Error('file does not exist ' + fullPath);
            }
            this.files.set(fullPath, new Uint8Array(0));
        }
        return new MemoryFileHandle(this.files, fullPath, filename, this.onWrite);
    }
    async removeEntry(filename: string) {
        this.files.delete(this.path + filename);
    }
}

class MemoryFilesystem {
    constructor(
        public files: FileMap,
        public onWrite: (path: string) => void = () => { }
    ) { }
    async getDirectory() {
        return new MemoryDirectory(this.files, '/', this.onWrite);
    }
}

/**
 * Same semantic as navigator.locks / the web-locks package:
 * only one task per lockId at the same time.
 */
function createMemoryLock() {
    const queues: Map<string, Promise<any>> = new Map();
    return {
        request(lockId: string, fn: () => Promise<any>) {
            const before = queues.get(lockId) || Promise.resolve();
            const run = before.then(() => fn());
            queues.set(lockId, run.catch(() => { }));
            return run;
        }
    };
}

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

const textDecoder = new TextDecoder();

describe('bug-report.test.ts', () => {

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);

    it('should fail because it reproduces the bug', async function () {
        this.timeout(20000);

        const databaseName = randomToken(10);

        /**
         * The "disk". Every time the storage writes something, we remember the
         * full byte state of all files. Each of these snapshots is a state that
         * really existed on disk, so each of them is a state that a browser tab
         * can be closed in.
         */
        const files: FileMap = new Map();
        const diskStates: FileMap[] = [];
        const storage = wrappedValidateAjvStorage({
            storage: getRxStorageAbstractFilesystem({
                name: 'in-memory-test-filesystem',
                abstractFilesystem: new MemoryFilesystem(files, () => {
                    diskStates.push(snapshotFiles(files));
                }) as any,
                abstractLock: createMemoryLock() as any,
                inWorker: false
            })
        });

        const db = await createRxDatabase({
            name: databaseName,
            storage,
            eventReduce: true,
            ignoreDuplicate: true
        });
        const collections = await db.addCollections({
            mycollection: {
                schema: mySchema as any
            }
        });
        const collection: RxCollection<any> = collections.mycollection;

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

        const changesFilePath = Array.from(files.keys())
            .filter(path => path.indexOf('-mycollection-') !== -1)
            .filter(path => path.indexOf('changes.json') !== -1)[0];

        /**
         * The content of changes.json is read back with
         * JSON.parse('[' + content + ']') by processChangesFileIfRequired().
         * So on every state that ever existed on disk, that must be parseable.
         */
        function getChangesFileParseError(diskState: FileMap): Error | undefined {
            const content = textDecoder.decode(diskState.get(changesFilePath) as Uint8Array);
            if (content.length === 0) {
                return undefined;
            }
            try {
                JSON.parse('[' + content + ']');
                return undefined;
            } catch (err) {
                return err as Error;
            }
        }

        const brokenDiskStateIndex = diskStates.findIndex(diskState => !!getChangesFileParseError(diskState));

        if (brokenDiskStateIndex !== -1) {
            const brokenDiskState = diskStates[brokenDiskStateIndex];
            const parseError = getChangesFileParseError(brokenDiskState) as Error;
            const brokenContent = textDecoder.decode(brokenDiskState.get(changesFilePath) as Uint8Array);
            console.log(
                'broken changes.json on disk (' + brokenContent.length + ' bytes), ' +
                'JSON.parse("[" + content + "]") fails with: ' + parseError.message
            );
            console.log('content around the corruption: ' + JSON.stringify(
                brokenContent.substring(Math.max(0, brokenContent.length - 60))
            ));

            /**
             * Reopen the database on exactly the bytes that were on disk at that
             * moment, like a browser tab that was closed and opened again.
             * The first read triggers processChangesFileIfRequired(), the JSON.parse
             * throws inside of the TaskQueue promise chain, the queue dies and the
             * query never resolves -> the database is permanently unusable.
             */
            const reopenedDb = await createRxDatabase({
                name: databaseName,
                storage: wrappedValidateAjvStorage({
                    storage: getRxStorageAbstractFilesystem({
                        name: 'in-memory-test-filesystem',
                        abstractFilesystem: new MemoryFilesystem(brokenDiskState) as any,
                        abstractLock: createMemoryLock() as any,
                        inWorker: false
                    })
                }),
                eventReduce: true,
                ignoreDuplicate: true
            });
            const reopenedCollections = await reopenedDb.addCollections({
                mycollection: {
                    schema: mySchema as any
                }
            });
            const readResult = await Promise.race([
                reopenedCollections.mycollection.find().exec().then(() => 'read-worked'),
                new Promise<string>(res => setTimeout(() => res('read-never-resolved'), 2000))
            ]);
            console.log('reading the reopened database: ' + readResult);
            assert.strictEqual(
                readResult,
                'read-worked',
                'the database can no longer be read after the write-run was interrupted'
            );
        }

        assert.strictEqual(
            brokenDiskStateIndex,
            -1,
            'changes.json must always contain valid JSON on disk, but disk state ' +
            brokenDiskStateIndex + ' of ' + diskStates.length + ' does not'
        );

        await db.close();
    });
});
