/**
 * abstract-filesystem storage: a crash during cleanup() duplicates every index
 * row on the next open. The database opens without any error, but afterwards
 * every document is returned twice.
 *
 * ---------------------------------------------------------------------------
 * ROOT CAUSE
 * ---------------------------------------------------------------------------
 * Writes never touch the index files. `processChangesFileIfRequired()` mutates
 * the in-memory index rows and APPENDS the resulting operations to
 * `changelog.txt` (`changelog.js` -> `addChangelogOperations()`). On every open,
 * `helpers.js` -> `getStorageInstanceInternalState()` loads the index files and
 * replays the whole changelog on top of them, unconditionally:
 *
 *   const [, ops] = await Promise.all([
 *       Promise.all(indexStates.map(i => i.initRead(runState))),
 *       changelog.getChangelogOperations(runState)
 *   ]);
 *   ops.forEach((opsOfIndex, i) => opsOfIndex.forEach(op => indexStates[i].runChangelogOperation(op)));
 *
 * The only place that ever writes the index files and empties the changelog is
 * `cleanup.js` -> `cleanupChangelogOperations()`, and it does so in two steps
 * that are not atomic:
 *
 *   for (const indexState of indexStatesWithOperations) {
 *       await indexState.persistInMemoryRows(runState);   // 1. index files now CONTAIN the ops
 *   }
 *   await changelog.empty(runState);                       // 2. changelog.txt truncated
 *
 * If the process dies between step 1 and step 2 (crash, OOM, tab closed, power
 * loss), the index files on disk already contain the effect of every operation,
 * and `changelog.txt` still contains the operations themselves. The next open
 * loads the baked rows and replays the same operations on top, and
 * `IndexState.runChangelogOperation()` is purely positional:
 *
 *   if ('A' === op[2]) this.rows.splice(op[1], 0, op[3]);
 *
 * so every 'A' inserts its row a second time, at the position it had when the
 * array was shorter. No error is thrown at any point. The collection then
 * returns every document twice.
 *
 * The window is not small: step 1 rewrites one file per index (three for a
 * schema without custom indexes, more with them), each a full JSON dump of the
 * rows, which for a large collection is megabytes.
 *
 * This is not the changes.json problem from #28: `changelog.txt` is appended
 * correctly (`knownChangelogFileSize` IS kept up to date). It is the index
 * files and the changelog disagreeing about which operations are already
 * applied, and the boot path having no way to tell.
 *
 * ---------------------------------------------------------------------------
 * SUGGESTED FIX
 * ---------------------------------------------------------------------------
 * Record which part of the changelog the index files already contain, so the
 * boot replay can skip it. For example: `cleanupChangelogOperations()` writes
 * the changelog byte length it is about to bake to a small marker file BEFORE
 * the first `persistInMemoryRows()`, and `getStorageInstanceInternalState()`
 * only replays operations past that offset (the marker is removed after
 * `changelog.empty()`). A crash anywhere in the sequence then leaves a state
 * the next open can interpret correctly.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 */
import assert from 'assert';
import { isNode } from 'rxdb/plugins/test-utils';

const schema = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: { type: 'string', maxLength: 20 },
        text: { type: 'string' }
    },
    required: ['id', 'text']
};

const ids = ['a', 'b', 'c'];

async function openDatabase(basePath: string) {
    const { createRxDatabase, addRxPlugin } = await import('rxdb/plugins/core');
    const { RxDBCleanupPlugin } = await import('rxdb/plugins/cleanup');
    const { getRxStorageFilesystemNode } = await import('rxdb-premium/plugins/storage-filesystem-node');
    addRxPlugin(RxDBCleanupPlugin);
    const db = await createRxDatabase({ name: 'crash', storage: getRxStorageFilesystemNode({ basePath }) });
    const { docs } = await db.addCollections({ docs: { schema } });
    return { db, docs };
}

/**
 * child process: insert three docs, then run cleanup() and die at the exact
 * moment cleanup is about to empty changelog.txt - after every index file has
 * already been rewritten.
 */
async function writeThenCrashDuringCleanup(basePath: string) {
    const { NodeFilesystemFileSyncAccessHandle } = await import('rxdb-premium/plugins/storage-filesystem-node');
    const truncate = NodeFilesystemFileSyncAccessHandle.prototype.truncate;
    NodeFilesystemFileSyncAccessHandle.prototype.truncate = function (size: number) {
        if (this.fileHandle.name === 'changelog.txt') {
            process.kill(process.pid, 'SIGKILL');
        }
        return truncate.call(this, size);
    };

    const { docs } = await openDatabase(basePath);
    await docs.bulkInsert(ids.map(id => ({ id, text: id })));
    await docs.cleanup(0);
}

if (process.env.CRASH_BASE_PATH) {
    writeThenCrashDuringCleanup(process.env.CRASH_BASE_PATH);
} else {
    describe('bug-report.test.ts', () => {
        it('should fail because it reproduces the bug', async function () {
            if (!isNode) {
                return;
            }
            const { mkdtemp, rm } = await import('node:fs/promises' + '');
            const { tmpdir } = await import('node:os' + '');
            const { join } = await import('node:path' + '');
            const { fork } = await import('node:child_process' + '');

            const basePath = await mkdtemp(join(tmpdir(), 'rxdb-'));
            try {
                const child = fork(this.test!.file!, [], {
                    env: { ...process.env, CRASH_BASE_PATH: basePath },
                    execArgv: ['--import=tsx']
                });
                const signal = await new Promise((resolve) => child.on('exit', (_code, sig) => resolve(sig)));
                assert.strictEqual(signal, 'SIGKILL', 'the child must die inside cleanup()');

                const { db, docs } = await openDatabase(basePath);
                const found = await docs.find().exec();
                await db.close();
                assert.deepStrictEqual(found.map(d => d.id).sort(), ids, 'documents are duplicated after the crash');
            } finally {
                await rm(basePath, { recursive: true, force: true });
            }
        });
    });
}
