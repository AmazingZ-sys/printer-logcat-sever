import { serve } from '@hono/node-server';
import { readConfig } from './config.js';
import { createService } from './app.js';

try {
  const config = readConfig();
  const service = createService(config);
  const server = serve({ fetch: service.app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`Printer log service listening on ${config.host}:${info.port}`);
  });
  const shutdown = () => {
    service.close();
    server.close((error) => { if (error) process.exitCode = 1; });
    if ('closeIdleConnections' in server) server.closeIdleConnections();
    const deadline = setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
      process.exit(1);
    }, 10000);
    deadline.unref();
    server.once('close', () => clearTimeout(deadline));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.on('error', (error) => { console.error(`Server failed: ${error.message}`); service.close(); process.exitCode = 1; });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Service startup failed');
  process.exitCode = 1;
}
