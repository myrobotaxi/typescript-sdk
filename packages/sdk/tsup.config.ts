import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react/index.ts',
    types: 'src/types.ts',
  },
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: 'es2022',
  splitting: false,
  external: ['react', '@myrobotaxi/contracts', '@myrobotaxi/contracts/types'],
});
