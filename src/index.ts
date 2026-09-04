import { readFileSync } from "node:fs";
import { loadConfigFromEnv } from "./config";
import { startSession } from "./forwarder";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function loadConfig() {
  try {
    return loadConfigFromEnv(process.env, {
      readFile: (path) => readFileSync(path, "utf8"),
      warn: (msg) => console.warn(msg),
    });
  } catch (err) {
    die(err instanceof Error ? err.message : "fatal");
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const session = startSession(cfg);

  process.on("unhandledRejection", (err) => {
    console.error(
      `unhandled rejection: ${err instanceof Error ? err.message : "error"}`,
    );
  });

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    session.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await session.stopped;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "fatal");
    process.exit(1);
  });
}
