import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import type { Configuration } from 'webpack';

/** Bundles the bench player (the app's ReplayPlayer, standalone) and the bench recorder. */
const config: Configuration = {
  mode: 'development',
  devtool: false,
  context: here,
  entry: { player: './player.tsx', recorder: './recorder.ts' },
  output: { path: path.resolve(here, 'dist'), filename: '[name].js', clean: true },
  resolve: { extensions: ['.tsx', '.ts', '.js', '.jsx'] },
  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2020',
            },
          },
        },
      },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.(woff2?|ttf|eot|svg|png)$/, type: 'asset/inline' },
    ],
  },
  performance: { hints: false },
};

export default config;
