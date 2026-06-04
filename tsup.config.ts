import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['cjs'],
  target: 'node20',
  clean: true,
  dts: false,
  sourcemap: true,
});
