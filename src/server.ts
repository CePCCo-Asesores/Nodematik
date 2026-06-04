import { config } from './config';
import { buildApp } from './app';

const app = buildApp();

app.listen({ port: config.PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
