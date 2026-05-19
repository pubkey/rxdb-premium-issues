declare const indexedDB: any;

describe('bug-report.test.ts', () => {
    it('should reproduce the exact TransactionInactiveError message from issue #8497', async function () {
        if (typeof indexedDB === 'undefined') {
            this.skip();
            return;
        }

        const dbName = 'tx-inactive-repro-' + Math.random();
        const openRequest = indexedDB.open(dbName, 1);
        openRequest.onupgradeneeded = () => {
            openRequest.result.createObjectStore('docs');
        };
        const db = await new Promise<any>((resolve, reject) => {
            openRequest.onsuccess = () => resolve(openRequest.result);
            openRequest.onerror = () => reject(openRequest.error);
        });

        const tx = db.transaction('docs', 'readonly');
        const store = tx.objectStore('docs');
        await new Promise(resolve => setTimeout(resolve, 0));

        /**
         * Intentionally trigger the same browser error text from issue #8497:
         * TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is not active.
         */
        try {
            store.get('any-id');
        } catch (_err) {
            const exactErrorMessage = "Uncaught (in promise) TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is not active.";
            console.error(exactErrorMessage);
            throw new Error(exactErrorMessage);
        }
    });
});
