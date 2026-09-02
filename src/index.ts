import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { finalizeEvent } from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import type { Event, EventTemplate } from "nostr-tools";
import {
  BACKOFF_MIN_MS,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  SeenRing,
  buildFilter,
  buildPayload,
  isIgnoredAuthor,
  isMention,
  isRetryableWebhookError,
  nextBackoff,
  parseBool,
  parseChannelIds,
  parsePubkey,
  parseSecretKey,
  pubkeyOf,
  resolveKeyFile,
  webhookHeaders,
  wsUrl,
} from "./lib";

type Config = {
  relayUrl: string;
  wsUrl: string;
  channelIds: string[];
  botMentionText?: string;
  botPubkey?: string;
  listenerSk: Uint8Array;
  listenerPubkey: string;
  webhookUrl: string;
  webhookBearer?: string;
  webhookTimeoutMs: number;
  includeForumKinds: boolean;
  stateFile?: string;
  healthPort?: number;
};

type Runtime = {
  connected: boolean;
  lastEventAt: number | null;
  lastSeen: number;
  seen: SeenRing;
  queue: Promise<void>;
};

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function loadSecretKey(): Uint8Array {
  const inline = env("LISTENER_PRIVATE_KEY");
  if (inline) return parseSecretKey(inline);
  const file = env("LISTENER_PRIVATE_KEY_FILE");
  if (!file) {
    die("set LISTENER_PRIVATE_KEY or LISTENER_PRIVATE_KEY_FILE");
  }
  const path = resolveKeyFile(file, env("CREDENTIALS_DIRECTORY"));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die("failed to read LISTENER_PRIVATE_KEY_FILE");
  }
  return parseSecretKey(raw);
}

function loadConfig(): Config {
  const relayUrl = env("RELAY_URL") ?? die("missing RELAY_URL");
  const channelIds = parseChannelIds(
    env("CHANNEL_IDS") ?? die("missing CHANNEL_IDS"),
  );
  const webhookUrl = env("WEBHOOK_URL") ?? die("missing WEBHOOK_URL");
  const botMentionText = env("BOT_MENTION_TEXT");
  const botPubkeyRaw = env("BOT_PUBKEY");
  if (!botMentionText && !botPubkeyRaw) {
    die("set BOT_MENTION_TEXT and/or BOT_PUBKEY");
  }
  const listenerSk = loadSecretKey();
  const timeoutRaw = env("WEBHOOK_TIMEOUT_MS");
  const timeoutMs = timeoutRaw
    ? Number.parseInt(timeoutRaw, 10)
    : DEFAULT_WEBHOOK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    die("WEBHOOK_TIMEOUT_MS must be a positive integer");
  }
  const healthRaw = env("HEALTH_PORT");
  const healthPort = healthRaw ? Number.parseInt(healthRaw, 10) : undefined;
  if (healthPort !== undefined && (!Number.isFinite(healthPort) || healthPort <= 0)) {
    die("HEALTH_PORT must be a positive integer");
  }
  return {
    relayUrl,
    wsUrl: wsUrl(relayUrl),
    channelIds,
    botMentionText,
    botPubkey: botPubkeyRaw ? parsePubkey(botPubkeyRaw) : undefined,
    listenerSk,
    listenerPubkey: pubkeyOf(listenerSk),
    webhookUrl,
    webhookBearer: env("WEBHOOK_BEARER"),
    webhookTimeoutMs: timeoutMs,
    includeForumKinds: parseBool(env("INCLUDE_FORUM_KINDS"), false),
    stateFile: env("STATE_FILE"),
    healthPort,
  };
}

function readLastSeen(path: string | undefined, fallback: number): number {
  if (!path) return fallback;
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeLastSeen(path: string | undefined, ts: number): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${ts}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(
      `state write failed: ${err instanceof Error ? err.message : "error"}`,
    );
  }
}

function startHealth(port: number, runtime: Runtime): void {
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          connected: runtime.connected,
          last_event_at: runtime.lastEventAt,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function postWebhook(cfg: Config, event: Event): Promise<boolean> {
  const body = JSON.stringify(buildPayload(event, cfg.relayUrl));
  const headers = webhookHeaders(cfg.webhookBearer);
  const attempt = async (): Promise<{
    status: string;
    latency: number;
    ok: boolean;
    retryable: boolean;
  }> => {
    const started = Date.now();
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(cfg.webhookTimeoutMs),
      });
      return {
        status: String(res.status),
        latency: Date.now() - started,
        ok: res.ok,
        retryable: false,
      };
    } catch (err) {
      const retryable = isRetryableWebhookError(err);
      return {
        status: retryable ? "network_error" : "timeout",
        latency: Date.now() - started,
        ok: false,
        retryable,
      };
    }
  };

  let result = await attempt();
  console.log(
    `event=${event.id} status=${result.status} latency_ms=${result.latency}`,
  );
  if (result.retryable) {
    result = await attempt();
    console.log(
      `event=${event.id} status=${result.status} latency_ms=${result.latency} retry=1`,
    );
  }
  return result.ok;
}

function advanceLastSeen(cfg: Config, runtime: Runtime, createdAt: number): void {
  if (createdAt > runtime.lastSeen) {
    runtime.lastSeen = createdAt;
    writeLastSeen(cfg.stateFile, runtime.lastSeen);
  }
}

function handleEvent(cfg: Config, runtime: Runtime, event: Event): void {
  if (!runtime.seen.add(event.id)) return;
  runtime.lastEventAt = event.created_at;
  const forwardable =
    !isIgnoredAuthor(event, {
      botPubkey: cfg.botPubkey,
      listenerPubkey: cfg.listenerPubkey,
    }) &&
    isMention(event, {
      botMentionText: cfg.botMentionText,
      botPubkey: cfg.botPubkey,
    });
  if (!forwardable) {
    // Nothing to deliver, so this event can never need replaying.
    advanceLastSeen(cfg, runtime, event.created_at);
    return;
  }
  // Serialize deliveries so `lastSeen` only ever moves past events we have
  // actually handed to the webhook, and so a burst cannot fan out unbounded.
  runtime.queue = runtime.queue
    .then(async () => {
      const delivered = await postWebhook(cfg, event);
      if (delivered) advanceLastSeen(cfg, runtime, event.created_at);
    })
    .catch(() => {
      // postWebhook already logged; never let the chain die.
    });
}

async function listen(
  cfg: Config,
  runtime: Runtime,
  register: (abort: () => void) => void,
): Promise<number> {
  const relay = new Relay(cfg.wsUrl, { enablePing: true });
  const sign = async (evt: EventTemplate) =>
    finalizeEvent(evt, cfg.listenerSk);

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectedAt = 0;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      runtime.connected = false;
      const uptime = connectedAt ? Date.now() - connectedAt : 0;
      try {
        relay.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(uptime);
    };
    register(() => done());

    relay.onauth = sign;
    relay.onclose = () => done();
    relay.onnotice = () => {
      // notices can contain relay-local detail; drop them
    };

    const subscribe = () => {
      // `Relay.subscribe` fires the REQ through an async `send`, so on a socket
      // that has already closed it rejects outside our promise chain and takes
      // the process down. Never subscribe once this attempt is over.
      if (settled || !relay.connected) {
        done();
        return;
      }
      const filter = buildFilter({
        channelIds: cfg.channelIds,
        since: runtime.lastSeen,
        includeForumKinds: cfg.includeForumKinds,
      });
      relay.subscribe([filter], {
        onevent(event) {
          handleEvent(cfg, runtime, event);
        },
        onclose(reason) {
          if (typeof reason === "string" && reason.startsWith("auth-required:")) {
            relay
              .auth(sign)
              .then(() => subscribe())
              .catch((err) => done(err));
            return;
          }
          done();
        },
      });
    };

    relay
      .connect({ timeout: 10_000 })
      .then(async () => {
        runtime.connected = true;
        connectedAt = Date.now();
        console.log("connected");
        await new Promise((r) => setTimeout(r, 150));
        try {
          await relay.auth(sign);
        } catch {
          // relay did not issue a challenge
        }
        subscribe();
      })
      .catch((err) => done(err));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const now = Math.floor(Date.now() / 1000);
  const runtime: Runtime = {
    connected: false,
    lastEventAt: null,
    lastSeen: readLastSeen(cfg.stateFile, now),
    seen: new SeenRing(),
    queue: Promise.resolve(),
  };
  if (cfg.healthPort) startHealth(cfg.healthPort, runtime);

  // nostr-tools rejects out-of-band on a racing socket close (see `subscribe`).
  // The reconnect loop below is the recovery path, so log and carry on rather
  // than letting the default handler kill a long-running forwarder.
  process.on("unhandledRejection", (err) => {
    console.error(
      `unhandled rejection: ${err instanceof Error ? err.message : "error"}`,
    );
  });

  let stopping = false;
  let abortListen: (() => void) | null = null;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    abortListen?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let backoff = BACKOFF_MIN_MS;
  while (!stopping) {
    try {
      const uptime = await listen(cfg, runtime, (abort) => {
        abortListen = abort;
      });
      backoff = nextBackoff(backoff, uptime);
    } catch (err) {
      console.error(
        `disconnected: ${err instanceof Error ? err.message : "error"}`,
      );
      backoff = nextBackoff(backoff, 0);
    }
    abortListen = null;
    runtime.connected = false;
    if (stopping) break;
    await sleep(backoff);
  }
  await runtime.queue;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "fatal");
    process.exit(1);
  });
}
