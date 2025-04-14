import assert from 'assert';

import { createRxDatabase, randomToken, addRxPlugin } from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import {
	RxDBFlexSearchPlugin,
	addFulltextSearch,
} from 'rxdb-premium/plugins/flexsearch';

import {
	getRxStorageSQLiteTrial,
	getSQLiteBasicsNodeNative,
} from 'rxdb/plugins/storage-sqlite';

import { wrappedKeyEncryptionCryptoJsStorage } from 'rxdb/plugins/encryption-crypto-js';

const mySchema = {
	version: 0,
	primaryKey: 'id',
	type: 'object',
	properties: {
		id: {
			type: 'string',
			maxLength: 100,
		},
		title: {
			type: 'string',
		},
	},
	encrypted: ['title'],
};

describe('bug-report.test.ts', () => {
	addRxPlugin(RxDBFlexSearchPlugin);
	addRxPlugin(RxDBDevModePlugin);
	addRxPlugin(RxDBQueryBuilderPlugin);

	it('fails because of full search plugin in combination with encryption', async function () {
		const { DatabaseSync } = require('node:sqlite' + '');
		let storage = wrappedKeyEncryptionCryptoJsStorage({
			storage: getRxStorageSQLiteTrial({
				sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync),
			}),
		});

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
			password: 'testpasswordddd',
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
			title: 'title-1',
		});

		// insert a document
		await collections.mycollection.insert({
			id: 'g2eaeeee-b3e2-411d-8edc-c62b6ec4a1ab',
			title: 'title-2',
		});

		const title1Result = await db.mycollection
			.findOne({
				selector: {
					id: 'g2eaeeee-b3e2-411d-8edc-c62b6ec4a1ab',
				},
			})
			.exec();

		assert.equal(title1Result?.title, 'title-2');

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

		const result = await fullTextSearchInstance.find('title', {
			limit: Infinity,
		});

		assert.equal(result.length, 2);

		db.close();
	});
});
