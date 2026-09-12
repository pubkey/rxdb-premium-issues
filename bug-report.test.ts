/**
 * abstract-filesystem storage: two instances writing one collection append
 * positions to a shared changelog.txt, and the file stops being replayable.
 * After both close cleanly, reopening builds the index rows out of order, and a
 * document that is still stored - findOne() by primary key returns it -
 * disappears from every indexed range query.
 *
 * No crash, no cleanup, no filesystem override: both processes call db.close()
 * and exit 0.
 *
 * ---------------------------------------------------------------------------
 * ROOT CAUSE
 * ---------------------------------------------------------------------------
 * Writes never touch the index files. `processChangesFileIfRequired()` mutates
 * the in-memory rows and appends the operations to `changelog.txt`, where each
 * one records an ARRAY POSITION computed against the writer's own rows:
 *
 *   appendWriteOperations() -> pushAtSortPosition(this.rows, row, comparator)
 *   ops.push([indexId, positionInThisInstancesRows, 'A', row]);
 *
 * On open, `getStorageInstanceInternalState()` replays the whole log over the
 * loaded index files, applying each operation at its recorded position:
 *
 *   if ('A' === op[2]) this.rows.splice(op[1], 0, op[3]);
 *
 * Those positions are private to whichever instance wrote them, but the file is
 * shared by all of them and no entry records who wrote it. Two instances that
 * have not seen each other's writes both append positions computed against
 * their own view:
 *
 *   process B (rows [])  inserts b -> ['A', 0, b]
 *   process A (rows [])  inserts c -> ['A', 0, c]
 *
 * Each entry is correct for its writer. Replayed in file order they produce
 * [c, b], which is not sorted, and reads binary-search these rows (`query.js`
 * and `find-by-ids.js` via `boundEQ`/`boundGT`). A binary search over an
 * unsorted array returns the wrong answer silently:
 * `find({selector:{id:{$lt:'c'}}})` gives [] although b is present, and
 * `find()` gives [c, b].
 *
 * Two processes is just the shortest way to get two instances that have not
 * seen each other's writes. The same divergence is reachable whenever one has
 * not yet applied another's broadcast: `broadcastChangelogOperations()`
 * delivers asynchronously and no write waits for delivery.
 *
 * Not the same as #30 - nothing is interrupted, cleanup never runs, and the
 * index files are still 0 bytes. There the index files and the log disagreed
 * about what was already applied; here the log disagrees with itself.
 *
 * ---------------------------------------------------------------------------
 * SUGGESTED FIX
 * ---------------------------------------------------------------------------
 * Log what to insert rather than where: `ops.push([indexId, 'A', row])`, and
 * let the reader place it with `pushAtSortPosition()` against its own rows.
 * Insertion by sort position is commutative, so replay order stops mattering.
 * The cost is about nil - the writer already runs that binary search, the fix
 * moves it to the reader. Deletes and replaces additionally need a "row not
 * found -> rebuild from documents.json" fallback instead of splicing blindly.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 */
import assert from 'assert';
import { isNode } from 'rxdb/plugins/test-utils';

/**
 * Control: set to true so the first process opens AFTER the other has finished
 * writing. It then derives its position from rows that already hold b, logs
 * position 1 for c, and the same assertion passes.
 */
const OPEN_AFTER_OTHER_PROCESS_WROTE = false;

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

async function openDatabase(basePath: string) {
    const { createRxDatabase } = await import('rxdb/plugins/core');
    const { getRxStorageFilesystemNode } = await import('rxdb-premium/plugins/storage-filesystem-node');
    const db = await createRxDatabase({
        name: 'replay',
        multiInstance: true,
        storage: getRxStorageFilesystemNode({ basePath })
    });
    const { docs } = await db.addCollections({ docs: { schema } });
    return { db, docs };
}

async function runChild(file: string, basePath: string, role: string) {
    const { fork } = await import('node:child_process' + '');
    const child = fork(file, [], {
        env: { ...process.env, REPLAY_BASE_PATH: basePath, REPLAY_ROLE: role },
        execArgv: ['--import=tsx']
    });
    return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
}

async function writeFromTwoProcesses(basePath: string) {
    if (process.env.REPLAY_ROLE === 'writer') {
        const { db, docs } = await openDatabase(basePath);
        await docs.insert({ id: 'b', text: 'b' });
        await db.close();
        process.exit(0);
    }
    // Opened BEFORE the other process writes, so these rows never learn about b.
    let first = OPEN_AFTER_OTHER_PROCESS_WROTE ? undefined : await openDatabase(basePath);
    const writer = await runChild(process.argv[1], basePath, 'writer');
    assert.deepStrictEqual(writer, { code: 0, signal: null });
    first = first || await openDatabase(basePath);
    await first.docs.insert({ id: 'c', text: 'c' });
    await first.db.close();
    process.exit(0);
}

if (process.env.REPLAY_BASE_PATH) {
    writeFromTwoProcesses(process.env.REPLAY_BASE_PATH).catch(error => {
        console.error(error);
        process.exit(1);
    });
} else {
    describe('bug-report.test.ts', () => {
        it('should fail because it reproduces the bug', async function () {
            if (!isNode) {
                return;
            }
            this.timeout(60 * 1000);
            const { mkdtemp, rm } = await import('node:fs/promises' + '');
            const { tmpdir } = await import('node:os' + '');
            const { join } = await import('node:path' + '');

            const basePath = await mkdtemp(join(tmpdir(), 'rxdb-replay-'));
            try {
                const exit = await runChild(this.test!.file!, basePath, 'coordinator');
                assert.deepStrictEqual(exit, { code: 0, signal: null }, 'both processes exit cleanly');

                const { db, docs } = await openDatabase(basePath);
                try {
                    const storedById = await docs.findOne('b').exec();
                    assert.ok(storedById, 'precondition: b is still stored and reachable by primary key');

                    const belowC = await docs.find({ selector: { id: { $lt: 'c' } } }).exec();
                    assert.deepStrictEqual(
                        belowC.map(d => d.id),
                        ['b'],
                        'b is stored but missing from the indexed query id < c'
                    );
                } finally {
                    await db.close();
                }
            } finally {
                await rm(basePath, { recursive: true, force: true });
            }
        });
    });
}
