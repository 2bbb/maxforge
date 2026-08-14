#!/usr/bin/env node

import { brokerDescriptorFromEnvironment } from "./broker-protocol.js";
import { MaxforgeBroker } from "./broker.js";

async function main(): Promise<void> {
  const descriptor = await brokerDescriptorFromEnvironment(process.env);
  const broker = new MaxforgeBroker({ descriptor });
  await broker.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await broker.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
