// karma.conf.js
const path = require('path');
const webpack = require('webpack');

module.exports = function (config) {
    config.set({
        // The testing framework you'll be using
        frameworks: ['mocha'],

        // Files/patterns to load into the browser
        files: [
            { pattern: 'bug-report.test.ts', watched: false },
            // Pre-built worker files (served but not included in page)
            { pattern: 'dist/*.js', included: false, served: true, watched: false }
        ],

        // Preprocess the test file with webpack (bundles TypeScript + dependencies for the browser)
        preprocessors: {
            'bug-report.test.ts': ['webpack', 'sourcemap']
        },

        // webpack configuration for bundling the tests
        webpack: {
            mode: 'development',
            devtool: 'inline-source-map',
            target: 'web',
            resolve: {
                extensions: ['.ts', '.tsx', '.js'],
                alias: {
                    // rxdb/plugins/test-utils is Node-only (reads DEFAULT_STORAGE env var etc.)
                    // In the browser we just need isNode = false
                    'rxdb/plugins/test-utils': path.resolve(__dirname, 'config/rxdb-test-utils-browser-stub.js')
                },
                fallback: {
                    // polyfills used by rxdb and its deps in the browser
                    events: require.resolve('events/'),
                    process: require.resolve('process/browser'),
                    querystring: require.resolve('querystring-es3'),
                    // remaining Node.js built-ins: disable (not needed at runtime in browser)
                    assert: false,
                    buffer: false,
                    crypto: false,
                    fs: false,
                    http: false,
                    https: false,
                    net: false,
                    os: false,
                    path: false,
                    stream: false,
                    tls: false,
                    url: false,
                    util: false,
                    vm: false,
                    zlib: false
                }
            },
            module: {
                rules: [{
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/
                }]
            },
            plugins: [
                // strip "node:" protocol prefix so webpack can resolve Node built-ins via fallback
                new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
                    resource.request = resource.request.replace(/^node:/, '');
                }),
                new webpack.ProvidePlugin({
                    process: 'process'
                })
            ]
        },

        // Report test results
        reporters: ['progress'],

        // Custom launcher for headless Chrome (used in CI)
        customLaunchers: {
            ChromeHeadlessCI: {
                base: 'ChromeHeadless',
                flags: ['--no-sandbox', '--disable-gpu']
            }
        },

        // Use ChromeHeadlessCI in CI environments, Chrome locally
        browsers: [process.env.CI ? 'ChromeHeadlessCI' : 'Chrome'],

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

        // Exit after running tests once
        singleRun: true
    });
};
