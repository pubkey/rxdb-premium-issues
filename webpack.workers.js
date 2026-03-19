const path = require('path');
const webpack = require('webpack');

module.exports = {
    mode: 'production',
    entry: {
        'opfs-with-encryption': './workers/opfs-with-encryption.ts',
        'opfs-bare': './workers/opfs-bare.ts'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js'
    },
    resolve: {
        extensions: ['.ts', '.js'],
        fallback: {
            events: require.resolve('events/'),
            process: require.resolve('process/browser'),
            querystring: require.resolve('querystring-es3'),
            assert: false, buffer: false, crypto: false, fs: false,
            http: false, https: false, net: false, os: false,
            path: false, stream: false, tls: false, url: false,
            util: false, vm: false, zlib: false
        }
    },
    module: {
        rules: [{
            test: /\.ts$/,
            use: 'ts-loader',
            exclude: /node_modules/
        }]
    },
    plugins: [
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
            resource.request = resource.request.replace(/^node:/, '');
        }),
        new webpack.ProvidePlugin({ process: 'process' })
    ]
};
