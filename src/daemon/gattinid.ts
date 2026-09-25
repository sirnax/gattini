#!/usr/bin/env node
import { startDaemon } from "./server.js";

try {
  const daemon = await startDaemon();
  process.stdout.write(`gattinid listening at ${daemon.socketPath}\n`);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void daemon.close().then(() => { process.exitCode = 0; }, error => {
      process.stderr.write(`gattinid shutdown failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  process.stderr.write(`gattinid startup failed: ${String(error)}\n`);
  process.exitCode = 1;
}
