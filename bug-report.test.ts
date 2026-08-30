/**
 * Bug: after a crash, a filesystem-node database whose last write batch
 * contained two updates can no longer be opened - the read never resolves
 * and "SyntaxError: Expected ',' or ']' after array element" is thrown
 * (unhandled) inside the storage while it reads changes.json.
 *
 * Node only ('npm run test:node').
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

async function openDatabase(basePath: string) {
    const { createRxDatabase } = await import('rxdb/plugins/core');
    const { getRxStorageFilesystemNode } = await import('rxdb-premium/plugins/storage-filesystem-node');
    const db = await createRxDatabase({ name: 'crash', storage: getRxStorageFilesystemNode({ basePath }) });
    const { docs } = await db.addCollections({ docs: { schema } });
    return { db, docs };
}

// child process: insert two docs, update both in one batch, then crash
async function writeThenCrash(basePath: string) {
    const { docs } = await openDatabase(basePath);
    const [a, b] = await Promise.all([
        docs.insert({ id: 'a', text: 'a' }),
        docs.insert({ id: 'b', text: 'b' })
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.all([
        a.incrementalPatch({ text: 'x'.repeat(500) }),
        b.incrementalPatch({ text: 'y' })
    ]);
    process.kill(process.pid, 'SIGKILL');
}

if (process.env.CRASH_BASE_PATH) {
    writeThenCrash(process.env.CRASH_BASE_PATH);
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
                await new Promise((resolve) => child.on('exit', resolve));

                const { db, docs } = await openDatabase(basePath);
                const doc = await Promise.race([
                    docs.findOne('b').exec(),
                    new Promise((resolve) => setTimeout(() => resolve(null), 3000))
                ]);
                assert.ok(doc, 'database cannot be read after the crash');
                assert.strictEqual(doc!.text, 'y');
                await db.close();
            } finally {
                await rm(basePath, { recursive: true, force: true });
            }
        });
    });
}
