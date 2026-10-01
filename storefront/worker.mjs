import { createShopService } from './server.mjs';

// systemd supervises this process independently from the request-serving process.
const service = createShopService({ runWorkers: true });
const heartbeat = setInterval(() => service.store.setSetting('worker_heartbeat', { at: Date.now() }), 15000);
service.store.setSetting('worker_heartbeat', { at: Date.now() });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  clearInterval(heartbeat);
  void service.close().then(() => process.exit(0));
});
