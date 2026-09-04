import { afterEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event, EventTemplate, Filter } from "nostr-tools";
import { matchFilter } from "nostr-tools/filter";
import { loadConfigFromEnv } from "./config";
import { startSession } from "./forwarder";
import type { WebhookPayload } from "./lib";
import {
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  KIND_MEMBER_ADDED,
} from "./lib";

type Sub = { id: string; filters: Filter[] };

function sign(sk: Uint8Array, tmpl: EventTemplate): Event {
  return finalizeEvent(tmpl, sk);
}

class MockRelay {
  readonly events: Event[] = [];
  readonly reqs: Sub[] = [];
  private readonly sockets = new Set<WebSocket>();
  private readonly live = new Map<WebSocket, Map<string, Filter[]>>();
  readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    const self = this;
    this.server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws);
          self.live.set(ws, new Map());
        },
        close(ws) {
          self.sockets.delete(ws);
          self.live.delete(ws);
        },
        message(ws, raw) {
          let msg: unknown;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
          if (msg[0] === "REQ") {
            const id = String(msg[1]);
            const filters = msg.slice(2) as Filter[];
            self.reqs.push({ id, filters });
            const bySub = self.live.get(ws);
            bySub?.set(id, filters);
            for (const event of self.events) {
              if (filters.some((f) => matchFilter(f, event))) {
                ws.send(JSON.stringify(["EVENT", id, event]));
              }
            }
            ws.send(JSON.stringify(["EOSE", id]));
            return;
          }
          if (msg[0] === "CLOSE") {
            self.live.get(ws)?.delete(String(msg[1]));
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}`;
  }

  store(event: Event): void {
    this.events.push(event);
  }

  publish(event: Event): void {
    this.store(event);
    for (const ws of this.sockets) {
      const bySub = this.live.get(ws);
      if (!bySub) continue;
      for (const [id, filters] of bySub) {
        if (filters.some((f) => matchFilter(f, event))) {
          ws.send(JSON.stringify(["EVENT", id, event]));
        }
      }
    }
  }

  stop(): void {
    this.server.stop(true);
  }
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 4000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

function startHook(): { url: string; payloads: WebhookPayload[]; stop: () => void } {
  const payloads: WebhookPayload[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("no", { status: 404 });
      payloads.push((await req.json()) as WebhookPayload);
      return new Response("ok", { status: 200 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/hook`,
    payloads,
    stop: () => server.stop(true),
  };
}

describe("mock relay integration", () => {
  test("invite notif then mention in the same second is forwarded", async () => {
    const botSk = generateSecretKey();
    const botPk = getPublicKey(botSk);
    const authorSk = generateSecretKey();
    const relaySk = generateSecretKey();
    const channel = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const ts = Math.floor(Date.now() / 1000);

    const relay = new MockRelay();
    const hook = startHook();
    cleanups.push(() => relay.stop(), () => hook.stop());

    const cfg = loadConfigFromEnv(
      {
        RELAY_URL: relay.url,
        WEBHOOK_URL: hook.url,
        BOT_PRIVATE_KEY: Buffer.from(botSk).toString("hex"),
        REDISCOVERY_INTERVAL_MS: "60000",
      },
      { readFile: () => "" },
    );
    const session = startSession(cfg, { enablePing: false });
    cleanups.push(() => session.stop());

    await waitFor(
      () => relay.reqs.some((r) => r.id === "membership-notif"),
      4000,
      "membership-notif sub",
    );

    const join = sign(relaySk, {
      kind: KIND_MEMBER_ADDED,
      created_at: ts,
      content: "",
      tags: [
        ["p", botPk],
        ["h", channel],
      ],
    });
    relay.publish(join);

    await waitFor(
      () => relay.reqs.some((r) => r.id === `ch-${channel}`),
      4000,
      "channel subscribe after invite",
    );
    const channelReq = relay.reqs.find((r) => r.id === `ch-${channel}`);
    expect(channelReq?.filters[0]?.since).toBe(ts);

    const mention = sign(authorSk, {
      kind: 9,
      created_at: ts,
      content: "wake up",
      tags: [
        ["h", channel],
        ["p", botPk],
      ],
    });
    relay.publish(mention);

    await waitFor(() => hook.payloads.length === 1, 4000, "webhook payload");
    expect(hook.payloads[0]?.event_id).toBe(mention.id);
    expect(hook.payloads[0]?.channel).toBe(channel);
    expect(hook.payloads[0]?.text).toBe("wake up");
    expect(Object.keys(hook.payloads[0]!).sort()).toEqual([
      "author",
      "channel",
      "created_at",
      "event_id",
      "kind",
      "relay",
      "reply_to",
      "source",
      "text",
      "thread_root",
    ]);
  });

  test("rediscovery adds a channel without restart", async () => {
    const botSk = generateSecretKey();
    const botPk = getPublicKey(botSk);
    const authorSk = generateSecretKey();
    const relaySk = generateSecretKey();
    const channel = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const relay = new MockRelay();
    const hook = startHook();
    cleanups.push(() => relay.stop(), () => hook.stop());

    const cfg = loadConfigFromEnv(
      {
        RELAY_URL: relay.url,
        WEBHOOK_URL: hook.url,
        BOT_PRIVATE_KEY: Buffer.from(botSk).toString("hex"),
        REDISCOVERY_INTERVAL_MS: "80",
      },
      { readFile: () => "" },
    );
    const session = startSession(cfg, { enablePing: false });
    cleanups.push(() => session.stop());

    await waitFor(
      () => relay.reqs.some((r) => r.filters[0]?.kinds?.includes(KIND_GROUP_MEMBERS)),
      4000,
      "initial member discovery",
    );
    const before = relay.reqs.filter((r) => r.id === `ch-${channel}`).length;
    expect(before).toBe(0);

    relay.store(
      sign(relaySk, {
        kind: KIND_GROUP_MEMBERS,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["d", channel],
          ["p", botPk],
        ],
      }),
    );
    relay.store(
      sign(relaySk, {
        kind: KIND_GROUP_METADATA,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["d", channel],
          ["name", "new"],
        ],
      }),
    );

    await waitFor(
      () => relay.reqs.some((r) => r.id === `ch-${channel}`),
      4000,
      "channel subscribe after rediscovery",
    );

    const mention = sign(authorSk, {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "found you",
      tags: [
        ["h", channel],
        ["p", botPk],
      ],
    });
    relay.publish(mention);

    await waitFor(() => hook.payloads.length === 1, 4000, "webhook after rediscovery");
    expect(hook.payloads[0]?.event_id).toBe(mention.id);
    expect(hook.payloads[0]?.channel).toBe(channel);
    expect(session.runtime.channels.has(channel)).toBe(true);
  });
});
