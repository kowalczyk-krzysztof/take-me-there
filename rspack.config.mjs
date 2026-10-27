// Build config for the MV3 extension. Four entries in, four self-contained
// bundles out. No shared runtime chunk, no code splitting: the service worker
// must load its bundle with zero extra requests. Source maps are inline in
// dev and off in prod. No eval-based devtool, ever: the MV3 content security
// policy blocks eval.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rspack/cli';
import { CopyRspackPlugin, SwcJsMinimizerRspackPlugin } from '@rspack/core';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig((_env, argv) => {
  const isProd = argv?.mode === 'production';
  return {
    mode: isProd ? 'production' : 'development',
    context: root,
    entry: {
      'service-worker': './src/service-worker.ts',
      sidepanel: './src/sidepanel.ts',
      options: './src/options.tsx',
      onboarding: './src/onboarding.tsx',
    },
    output: {
      path: path.join(root, 'dist'),
      filename: '[name].js',
      cssFilename: '[name].css',
      clean: true,
    },
    experiments: {
      css: true,
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
      parser: {
        'css/auto': {
          namedExports: false,
        },
      },
      rules: [
        {
          test: /\.css$/,
          type: 'css/auto',
        },
        {
          test: /\.tsx?$/,
          exclude: [/node_modules/],
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2022',
            },
          },
          type: 'javascript/auto',
        },
      ],
    },
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
      // JS minify only: the CSS minifier silently truncates multi-module
      // output, and 14 KB of unminified local CSS is fine.
      minimizer: [new SwcJsMinimizerRspackPlugin()],
    },
    devtool: isProd ? false : 'inline-source-map',
    plugins: [
      new CopyRspackPlugin({
        patterns: [{ from: 'public' }, { from: 'LICENSE' }, { from: 'THIRD_PARTY_NOTICES' }],
      }),
    ],
  };
});
