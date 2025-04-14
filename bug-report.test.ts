import assert from 'assert';

import { createRxDatabase, randomToken, addRxPlugin } from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import {
	RxDBFlexSearchPlugin,
	addFulltextSearch,
} from 'rxdb-premium/plugins/flexsearch';

import { isNode } from 'rxdb/plugins/test-utils';

import { getRxStorageIndexedDB } from 'rxdb-premium/plugins/storage-indexeddb';
import {
	getRxStorageSQLiteTrial,
	getSQLiteBasicsNodeNative,
} from 'rxdb/plugins/storage-sqlite';

const mySchema = {
	version: 0,
	primaryKey: 'id',
	type: 'object',
	properties: {
		id: {
			type: 'string',
			maxLength: 36,
		},
		title: {
			type: 'string',
		},
	},
};

describe('bug-report.test.ts', () => {
	addRxPlugin(RxDBFlexSearchPlugin);
	addRxPlugin(RxDBDevModePlugin);
	addRxPlugin(RxDBQueryBuilderPlugin);

	it('fails because of full search plugin avj validation', async function () {
		let storage: any;

		if (isNode) {
			const { DatabaseSync } = require('node:sqlite' + '');
			storage = getRxStorageSQLiteTrial({
				sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync),
			});
		} else {
			storage = getRxStorageIndexedDB();
		}
		storage = wrappedValidateAjvStorage({
			storage,
		});

		const name = randomToken(10);

		// create a database
		const db = await createRxDatabase({
			name,
			storage: storage,
			eventReduce: true,
			ignoreDuplicate: true,
		});

		// create a collection
		const collections = await db.addCollections({
			mycollection: {
				schema: mySchema,
			},
		});

		// insert a document
		await collections.mycollection.insert({
			id: 'd7eaedeb-b3e4-411d-8edc-c62b6ec4a1aa',
			title: 'title',
		});

		// insert a document
		await collections.mycollection.insert({
			id: 'g2eaeeee-b3e2-411d-8edc-c62b6ec4a1ab',
			title: 'title',
		});

		const fullTextSearchInstance = await addFulltextSearch({
			identifier: String(randomToken(10)),
			collection: db.mycollection,
			docToString: (doc) => doc.title,
			initialization: 'instant',
			indexOptions: {
				charset: 'latin:advanced',
				tokenize: 'forward',
			},
		});

		/**
		 * DELAY IS NEEDED,
		 * FOR SOME REASON FLEX SEARCH PLUGIN
		 * DOES NOT FIND ANY EVENTS WITHOUT THIS DELAY
		 */
		await new Promise((resolve) => setTimeout(resolve, 2000));

		/**
		 * FAILING HERE
		 */
		const result = await fullTextSearchInstance.find('title', {
			limit: Infinity,
		});

		assert.equal(result.length, 2);

		db.close();
	});
});
