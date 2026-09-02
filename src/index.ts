import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { finalizeEvent } from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import type { Event, EventTemplate } from "nostr-tools";
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  SeenRing,
  buildFilter,
  buildPayload,
  isIgnoredAuthor,
  isMention,
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

async function postWebhook(cfg: Config, event: Event): Promise<void> {
  const body = JSON.stringify(buildPayload(event, cfg.relayUrl));
  const headers = webhookHeaders(cfg.webhookBearer);
  const attempt = async (): Promise<{
    status: string;
    latency: number;
    networkError: boolean;
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
        networkError: false,
      };
    } catch {
      return {
        status: "network_error",
        latency: Date.now() - started,
        networkError: true,
      };
    }
  };

  let result = await attempt();
  console.log(
    `event=${event.id} status=${result.status} latency_ms=${result.latency}`,
  );
  if (result.networkError) {
    result = await attempt();
    console.log(
      `event=${event.id} status=${result.status} latency_ms=${result.latency} retry=1`,
    );
  }
}

function handleEvent(cfg: Config, runtime: Runtime, event: Event): void {
  if (!runtime.seen.add(event.id)) return;
  if (event.created_at > runtime.lastSeen) {
    runtime.lastSeen = event.created_at;
    writeLastSeen(cfg.stateFile, runtime.lastSeen);
  }
  runtime.lastEventAt = event.created_at;
  if (
    isIgnoredAuthor(event, {
      botPubkey: cfg.botPubkey,
      listenerPubkey: cfg.listenerPubkey,
    })
  ) {
    return;
  }
  if (
    !isMention(event, {
      botMentionText: cfg.botMentionText,
      botPubkey: cfg.botPubkey,
    })
  ) {
    return;
  }
  void postWebhook(cfg, event);
}

async function listen(cfg: Config, runtime: Runtime): Promise<void> {
  const relay = new Relay(cfg.wsUrl, { enablePing: true });
  const sign = async (evt: EventTemplate) =>
    finalizeEvent(evt, cfg.listenerSk);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      runtime.connected = false;
      try {
        relay.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };

    relay.onauth = sign;
    relay.onclose = () => done();
    relay.onnotice = () => {
      // notices can contain relay-local detail; drop them
    };

    const subscribe = () => {
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
  };
  if (cfg.healthPort) startHealth(cfg.healthPort, runtime);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let backoff = 1000;
  while (!stopping) {
    try {
      await listen(cfg, runtime);
      backoff = 1000;
    } catch (err) {
      console.error(
        `disconnected: ${err instanceof Error ? err.message : "error"}`,
      );
    }
    runtime.connected = false;
    if (stopping) break;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "fatal");
    process.exit(1);
  });
}
