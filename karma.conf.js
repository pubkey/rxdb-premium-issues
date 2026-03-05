// karma.conf.js
module.exports = function (config) {
    config.set({
        // The testing framework you'll be using
        frameworks: ['mocha', 'karma-typescript'],

        // Files/patterns to load into the browser
        files: [
            // Worker script served (but not loaded) so it can be referenced by URL
            { pattern: 'test/unit/wa-sqlite-worker.js', included: false, served: true, watched: false },
            // wa-sqlite WASM build + source (needed by the worker)
            { pattern: 'node_modules/wa-sqlite/dist/**/*', included: false, served: true, watched: false },
            { pattern: 'node_modules/wa-sqlite/src/**/*.js', included: false, served: true, watched: false },
            // Comlink ESM build (needed by the worker)
            { pattern: 'node_modules/comlink/dist/esm/**/*', included: false, served: true, watched: false },
            // Main test file (compiled by karma-typescript)
            { pattern: 'bug-report.test.ts' }
        ],

        // Preprocess the test file for TypeScript
        preprocessors: {
            'bug-report.test.ts': ['karma-typescript']
        },

        // Report test results
        reporters: ['progress', 'karma-typescript'],

        // Karma will run tests in this browser
        browsers: ['Chrome'],
        // Karma plugins loaded
        plugins: [
            'karma-mocha',
            'karma-webpack',
            'karma-chrome-launcher',
            'karma-safari-launcher',
            'karma-firefox-launcher',
            'karma-ie-launcher',
            'karma-typescript',
            'karma-opera-launcher',
            'karma-detect-browsers',
            'karma-spec-reporter',
            'karma-sourcemap-loader'
        ],
        // Configuration for karma-typescript
        karmaTypescriptConfig: {
            // This overrides/adds the specified compilerOptions to whatever is in tsconfig.json
            compilerOptions: {
                "target": "ES2020",
                "module": "commonjs",
                strict: false,
                skipLibCheck: true,
                noEmitOnError: false,
                "esModuleInterop": true,
                "lib": ["ES2020", "ES2021.WeakRef"]
            },
            "include": [
                "bug-report.test.ts"
            ]
        },

        // Exit after running tests once
        singleRun: true
    });
};
