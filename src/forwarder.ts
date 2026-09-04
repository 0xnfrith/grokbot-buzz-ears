import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { finalizeEvent } from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import type { Event, EventTemplate, Filter } from "nostr-tools";
import type { Subscription } from "nostr-tools/abstract-relay";
import type { Config } from "./config";
import {
  BACKOFF_MIN_MS,
  ChannelTracker,
  SeenRing,
  buildChannelFilter,
  buildMembersDiscoveryFilter,
  buildMembershipNotifFilter,
  buildMetadataDiscoveryFilter,
  buildPayload,
  isRetryableWebhookError,
  memberChannelIds,
  membershipNotifAction,
  mergeDiscoveredChannels,
  nextBackoff,
  shouldWake,
  webhookAttemptLog,
  webhookHeaders,
} from "./lib";

export type Runtime = {
  connected: boolean;
  lastEventAt: number | null;
  lastSeen: number;
  seen: SeenRing;
  queue: Promise<void>;
  channels: ChannelTracker;
};

export type Session = {
  runtime: Runtime;
  stopped: Promise<void>;
  stop: () => Promise<void>;
};

type QueryRelay = {
  connected: boolean;
  subscribe: Relay["subscribe"];
};

export function readLastSeen(path: string | undefined, fallback: number): number {
  if (!path) return fallback;
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function writeLastSeen(path: string | undefined, ts: number): void {
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

export function startHealth(
  port: number,
  runtime: Runtime,
): { stop: () => void } {
  const server = Bun.serve({
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
  return { stop: () => server.stop(true) };
}

export function queryEvents(
  relay: QueryRelay,
  filters: Filter[],
  timeoutMs = 8000,
): Promise<{ events: Event[]; eosed: boolean }> {
  return new Promise((resolve, reject) => {
    if (!relay.connected) {
      reject(new Error("not connected"));
      return;
    }
    const events: Event[] = [];
    let settled = false;
    let eosed = false;
    let sub: Subscription | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sub?.close();
      } catch {
        // ignore
      }
      resolve({ events, eosed });
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      sub = relay.subscribe(filters, {
        onevent(event) {
          events.push(event);
        },
        oneose() {
          eosed = true;
          finish();
        },
        onclose: finish,
        eoseTimeout: timeoutMs,
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function discoverChannelIds(
  relay: QueryRelay,
  pubkey: string,
  timeoutMs = 8000,
): Promise<string[] | undefined> {
  const members = await queryEvents(
    relay,
    [buildMembersDiscoveryFilter(pubkey)],
    timeoutMs,
  );
  if (!members.eosed) return undefined;
  const ids = memberChannelIds(members.events);
  if (ids.length === 0) return [];
  const metas = await queryEvents(
    relay,
    [buildMetadataDiscoveryFilter(ids)],
    timeoutMs,
  );
  if (!metas.eosed) return undefined;
  return mergeDiscoveredChannels(members.events, metas.events);
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
  console.log(webhookAttemptLog(event.id, result.status, result.latency));
  if (result.retryable) {
    result = await attempt();
    console.log(webhookAttemptLog(event.id, result.status, result.latency, true));
  }
  return result.ok;
}

function advanceLastSeen(cfg: Config, runtime: Runtime, createdAt: number): void {
  if (createdAt > runtime.lastSeen) {
    runtime.lastSeen = createdAt;
    writeLastSeen(cfg.stateFile, runtime.lastSeen);
  }
}

export function handleEvent(cfg: Config, runtime: Runtime, event: Event): void {
  if (!runtime.seen.add(event.id)) return;
  runtime.lastEventAt = event.created_at;
  const forwardable = shouldWake(event, cfg.botPubkey);
  if (!forwardable) {
    advanceLastSeen(cfg, runtime, event.created_at);
    return;
  }
  runtime.queue = runtime.queue
    .then(async () => {
      const delivered = await postWebhook(cfg, event);
      if (delivered) advanceLastSeen(cfg, runtime, event.created_at);
    })
    .catch(() => {
      // postWebhook already logged; never let the chain die.
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function listen(
  cfg: Config,
  runtime: Runtime,
  register: (abort: () => void) => void,
  opts: { enablePing: boolean },
): Promise<number> {
  const relay = new Relay(cfg.wsUrl, {
    enablePing: opts.enablePing,
    enableReconnect: false,
  });
  const sign = async (evt: EventTemplate) => finalizeEvent(evt, cfg.botSk);
  const closers = new Map<string, { close: () => void }>();
  const intentionalClose = new Set<string>();
  let membershipSub: Subscription | undefined;
  let rediscoveryTimer: ReturnType<typeof setInterval> | undefined;

  const dropCloser = (id: string) => {
    const cur = closers.get(id);
    if (!cur) return;
    intentionalClose.add(id);
    try {
      cur.close();
    } catch {
      // ignore
    }
    closers.delete(id);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectedAt = 0;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      runtime.connected = false;
      if (rediscoveryTimer) clearInterval(rediscoveryTimer);
      for (const id of [...closers.keys()]) dropCloser(id);
      if (membershipSub) {
        intentionalClose.add("membership-notif");
        try {
          membershipSub.close();
        } catch {
          // ignore
        }
        membershipSub = undefined;
      }
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

    const onLiveClose = (subId: string, reason: string) => {
      if (settled) return;
      if (intentionalClose.has(subId)) return;
      if (typeof reason === "string" && reason.startsWith("auth-required:")) {
        relay
          .auth(sign)
          .then(() => rebuildLive())
          .catch((err) => done(err));
        return;
      }
      done();
    };

    const subscribeChannel = (channelId: string, since: number) => {
      if (settled || !relay.connected) {
        done();
        return;
      }
      const subId = `ch-${channelId}`;
      dropCloser(subId);
      const filter = buildChannelFilter({
        channelId,
        since,
        includeForumKinds: cfg.includeForumKinds,
        includeAcpStreamKinds: cfg.includeAcpStreamKinds,
        mentionPubkey: cfg.botPubkey,
      });
      const sub = relay.subscribe([filter], {
        id: subId,
        onevent(event) {
          handleEvent(cfg, runtime, event);
        },
        onclose(reason) {
          onLiveClose(subId, reason);
        },
      });
      closers.set(subId, sub);
      runtime.channels.add(channelId, since);
      console.log(`subscribe channel=${channelId} since=${since}`);
    };

    const unsubscribeChannel = (channelId: string) => {
      dropCloser(`ch-${channelId}`);
      if (runtime.channels.remove(channelId)) {
        console.log(`unsubscribe channel=${channelId}`);
      }
    };

    const applyDiscovery = async () => {
      if (settled || !relay.connected) return;
      const desired = await discoverChannelIds(relay, cfg.botPubkey);
      if (!desired) return;
      const { add, remove } = runtime.channels.sync(desired, runtime.lastSeen);
      for (const id of remove) unsubscribeChannel(id);
      for (const { id, since } of add) subscribeChannel(id, since);
      console.log(`discovered ${desired.length} channel(s)`);
    };

    const handleMembership = (event: Event) => {
      const action = membershipNotifAction(event, cfg.botPubkey);
      if (action.type === "ignore") return;
      if (!runtime.channels.acceptMembership(action.channelId, event.created_at)) {
        return;
      }
      if (action.type === "join") {
        if (!runtime.channels.has(action.channelId)) {
          subscribeChannel(action.channelId, action.replaySince);
        }
        return;
      }
      unsubscribeChannel(action.channelId);
    };

    const subscribeMembership = () => {
      if (settled || !relay.connected) {
        done();
        return;
      }
      if (membershipSub) {
        intentionalClose.add("membership-notif");
        try {
          membershipSub.close();
        } catch {
          // ignore
        }
      }
      intentionalClose.delete("membership-notif");
      membershipSub = relay.subscribe(
        [buildMembershipNotifFilter(cfg.botPubkey, runtime.lastSeen)],
        {
          id: "membership-notif",
          onevent: handleMembership,
          onclose(reason) {
            onLiveClose("membership-notif", reason);
          },
        },
      );
    };

    const rebuildLive = () => {
      if (settled || !relay.connected) {
        done();
        return;
      }
      const current = runtime.channels
        .ids()
        .map((id) => ({ id, since: runtime.channels.since(id) ?? runtime.lastSeen }));
      for (const { id } of current) {
        dropCloser(`ch-${id}`);
        runtime.channels.remove(id);
      }
      subscribeMembership();
      for (const { id, since } of current) subscribeChannel(id, since);
    };

    relay
      .connect({ timeout: 10_000 })
      .then(async () => {
        runtime.connected = true;
        connectedAt = Date.now();
        console.log("connected");
        await sleep(150);
        try {
          await relay.auth(sign);
        } catch {
          // relay did not issue a challenge
        }
        subscribeMembership();
        await applyDiscovery();
        rediscoveryTimer = setInterval(() => {
          applyDiscovery().catch(() => {
            // next cadence retries; connection loss is handled by onclose
          });
        }, cfg.rediscoveryIntervalMs);
      })
      .catch((err) => done(err));
  });
}

export function createRuntime(cfg: Config, now = Math.floor(Date.now() / 1000)): Runtime {
  return {
    connected: false,
    lastEventAt: null,
    lastSeen: readLastSeen(cfg.stateFile, now),
    seen: new SeenRing(),
    queue: Promise.resolve(),
    channels: new ChannelTracker(),
  };
}

export function startSession(
  cfg: Config,
  opts?: { enablePing?: boolean; runtime?: Runtime },
): Session {
  const runtime = opts?.runtime ?? createRuntime(cfg);
  const enablePing = opts?.enablePing ?? true;
  let stopping = false;
  let abortListen: (() => void) | null = null;
  let health: { stop: () => void } | undefined;
  if (cfg.healthPort) health = startHealth(cfg.healthPort, runtime);

  const stopped = (async () => {
    let backoff = BACKOFF_MIN_MS;
    while (!stopping) {
      try {
        const uptime = await listen(cfg, runtime, (abort) => {
          abortListen = abort;
        }, { enablePing });
        backoff = nextBackoff(backoff, uptime);
      } catch (err) {
        console.error(
          `disconnected: ${err instanceof Error ? err.message : "error"}`,
        );
        backoff = nextBackoff(backoff, 0);
      }
      abortListen = null;
      runtime.connected = false;
      runtime.channels = new ChannelTracker();
      if (stopping) break;
      await sleep(backoff);
    }
    await runtime.queue;
    health?.stop();
  })();

  return {
    runtime,
    stopped,
    stop: async () => {
      if (stopping) {
        await stopped;
        return;
      }
      stopping = true;
      abortListen?.();
      await stopped;
    },
  };
}
