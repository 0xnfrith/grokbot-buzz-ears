import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { Event } from "nostr-tools";
import {
  ACP_STREAM_KINDS,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BACKOFF_RESET_AFTER_MS,
  ChannelTracker,
  FORUM_KINDS,
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  KIND_MEMBER_ADDED,
  KIND_MEMBER_REMOVED,
  SEEN_CAP,
  SeenRing,
  buildChannelFilter,
  buildFilter,
  buildMembersDiscoveryFilter,
  buildMembershipNotifFilter,
  buildMetadataDiscoveryFilter,
  buildPayload,
  channelId,
  deprecationMessage,
  isIgnoredAuthor,
  isMention,
  isRetryableWebhookError,
  loadBotSecretKey,
  logLooksLikeSecret,
  membershipNotifAction,
  mergeDiscoveredChannels,
  nextBackoff,
  parseBool,
  parsePubkey,
  parseSecretKey,
  pickBotSecretSource,
  resolveKeyFile,
  shouldWake,
  threadRoot,
  webhookAttemptLog,
  webhookHeaders,
  wsUrl,
} from "./lib";
import { loadConfigFromEnv } from "./config";

function ev(over: Partial<Event> = {}): Event {
  return {
    id: over.id ?? "a".repeat(64),
    pubkey: over.pubkey ?? "b".repeat(64),
    created_at: over.created_at ?? 1_700_000_000,
    kind: over.kind ?? 9,
    tags: over.tags ?? [["h", "channel-1"]],
    content: over.content ?? "hello",
    sig: over.sig ?? "c".repeat(128),
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-ears-"));
  tmpDirs.push(dir);
  return dir;
}

describe("isMention", () => {
  test("matches p-tag pubkey", () => {
    const pk = "d".repeat(64);
    expect(
      isMention(ev({ tags: [["p", pk.toUpperCase()]] }), {
        botPubkey: pk,
      }),
    ).toBe(true);
  });

  test("p-tag mention is false when the tag is someone else", () => {
    expect(
      isMention(ev({ tags: [["p", "e".repeat(64)]] }), {
        botPubkey: "d".repeat(64),
      }),
    ).toBe(false);
  });

  test("requires at least one mention signal", () => {
    expect(isMention(ev({ content: "hello" }), {})).toBe(false);
  });

  test("does not wake on substring-only (BOT_MENTION_TEXT is gone)", () => {
    expect(
      isMention(ev({ content: "hey @Bot Name, status?" }), {
        botPubkey: "d".repeat(64),
      }),
    ).toBe(false);
    expect(
      shouldWake(
        ev({
          pubkey: "a".repeat(64),
          content: "@grokbot please look",
          tags: [["h", "channel-1"]],
        }),
        "d".repeat(64),
      ),
    ).toBe(false);
  });

  test("thread replies wake only when they p-mention us", () => {
    const us = "d".repeat(64);
    const reply = ev({
      pubkey: "a".repeat(64),
      tags: [
        ["e", "root".padEnd(64, "4"), "", "root"],
        ["e", "parent".padEnd(64, "5"), "", "reply"],
        ["h", "channel-1"],
      ],
      content: "following up",
    });
    expect(shouldWake(reply, us)).toBe(false);
    expect(
      shouldWake(
        ev({
          ...reply,
          tags: [...reply.tags, ["p", us]],
        }),
        us,
      ),
    ).toBe(true);
  });
});

describe("isIgnoredAuthor", () => {
  test("drops the bot's own events", () => {
    const bot = "e".repeat(64);
    expect(
      isIgnoredAuthor(ev({ pubkey: bot }), {
        botPubkey: bot,
        listenerPubkey: "f".repeat(64),
      }),
    ).toBe(true);
  });

  test("drops the listener's own events", () => {
    const listener = "f".repeat(64);
    expect(
      isIgnoredAuthor(ev({ pubkey: listener }), {
        botPubkey: "e".repeat(64),
        listenerPubkey: listener,
      }),
    ).toBe(true);
  });

  test("keeps other authors", () => {
    expect(
      isIgnoredAuthor(ev({ pubkey: "a".repeat(64) }), {
        botPubkey: "e".repeat(64),
        listenerPubkey: "f".repeat(64),
      }),
    ).toBe(false);
  });

  test("ignore self when bot and listener are the same identity", () => {
    const us = "e".repeat(64);
    expect(shouldWake(ev({ pubkey: us, tags: [["p", us]] }), us)).toBe(false);
    expect(
      shouldWake(
        ev({ pubkey: "a".repeat(64), tags: [["p", us]] }),
        us,
      ),
    ).toBe(true);
  });
});

describe("threadRoot and payload", () => {
  test("uses e tag with root marker", () => {
    const event = ev({
      id: "1".repeat(64),
      tags: [
        ["e", "rootid".padEnd(64, "0"), "", "root"],
        ["e", "replyid".padEnd(64, "1"), "", "reply"],
        ["h", "channel-1"],
      ],
    });
    expect(threadRoot(event)).toBe("rootid".padEnd(64, "0"));
  });

  test("falls back to reply marker, then first e, then event id", () => {
    expect(
      threadRoot(
        ev({
          id: "1".repeat(64),
          tags: [["e", "parent".padEnd(64, "2"), "", "reply"]],
        }),
      ),
    ).toBe("parent".padEnd(64, "2"));
    expect(
      threadRoot(ev({ id: "1".repeat(64), tags: [["e", "only".padEnd(64, "3")]] })),
    ).toBe("only".padEnd(64, "3"));
    expect(threadRoot(ev({ id: "1".repeat(64), tags: [] }))).toBe("1".repeat(64));
  });

  test("buildPayload maps the webhook JSON", () => {
    const event = ev({
      id: "1".repeat(64),
      pubkey: "2".repeat(64),
      content: "@Bot hello",
      kind: 9,
      created_at: 42,
      tags: [
        ["h", "channel-1"],
        ["e", "root".padEnd(64, "4"), "", "root"],
      ],
    });
    expect(buildPayload(event, "wss://relay.example.com")).toEqual({
      source: "buzz",
      relay: "wss://relay.example.com",
      channel: "channel-1",
      event_id: "1".repeat(64),
      thread_root: "root".padEnd(64, "4"),
      reply_to: "1".repeat(64),
      author: "2".repeat(64),
      kind: 9,
      created_at: 42,
      text: "@Bot hello",
    });
    expect(channelId(event)).toBe("channel-1");
  });

  test("payload shape is unchanged from the current webhook JSON fields", () => {
    const payload = buildPayload(ev(), "wss://relay.example.com");
    expect(Object.keys(payload).sort()).toEqual([
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
    expect(payload.source).toBe("buzz");
  });
});

describe("filter and env helpers", () => {
  test("buildFilter uses kind 9 unless forum kinds are enabled", () => {
    expect(
      buildFilter({
        channelIds: ["ch-a", "ch-b"],
        since: 99,
        includeForumKinds: false,
      }),
    ).toEqual({
      kinds: [9],
      since: 99,
      "#h": ["ch-a", "ch-b"],
    });
    expect(
      buildFilter({
        channelIds: ["ch-a"],
        since: 1,
        includeForumKinds: true,
      }).kinds,
    ).toEqual([9, ...FORUM_KINDS]);
  });

  test("buildChannelFilter is one REQ per channel and does not enable acp kinds", () => {
    const pk = "d".repeat(64);
    expect(
      buildChannelFilter({
        channelId: "ch-a",
        since: 10,
        includeForumKinds: false,
        mentionPubkey: pk,
      }),
    ).toEqual({
      kinds: [9],
      since: 10,
      "#h": ["ch-a"],
      "#p": [pk],
    });
    expect(
      buildFilter({
        channelIds: ["ch-a"],
        since: 1,
        includeForumKinds: false,
        includeAcpStreamKinds: true,
      }).kinds,
    ).toEqual([9, ...ACP_STREAM_KINDS]);
  });

  test("parseBool defaults and accepts truthy tokens", () => {
    expect(parseBool(undefined, false)).toBe(false);
    expect(parseBool("true", false)).toBe(true);
    expect(parseBool("YES", false)).toBe(true);
    expect(parseBool("0", true)).toBe(false);
  });

  test("wsUrl upgrades http(s)", () => {
    expect(wsUrl("https://relay.example.com")).toBe("wss://relay.example.com");
    expect(wsUrl("http://localhost:3000")).toBe("ws://localhost:3000");
    expect(wsUrl("wss://relay.example.com")).toBe("wss://relay.example.com");
  });
});

describe("discovery merge", () => {
  const live = "11111111-1111-1111-1111-111111111111";
  const archived = "22222222-2222-2222-2222-222222222222";
  const unknown = "33333333-3333-3333-3333-333333333333";

  function members(...ids: string[]): Event[] {
    return ids.map((id, i) =>
      ev({
        id: String(i).repeat(64),
        kind: KIND_GROUP_MEMBERS,
        tags: [
          ["d", id],
          ["p", "d".repeat(64)],
        ],
      }),
    );
  }

  function meta(id: string, extra: string[][] = []): Event {
    return ev({
      id: id.replace(/-/g, "").padEnd(64, "0"),
      kind: KIND_GROUP_METADATA,
      tags: [["d", id], ["name", "n"], ...extra],
    });
  }

  test("39002 membership becomes the channel set and archived metadata is skipped", () => {
    expect(
      mergeDiscoveredChannels(
        members(live, archived),
        [meta(live), meta(archived, [["archived", "true"]])],
      ),
    ).toEqual([live]);
  });

  test("archived=true is skipped even when we are still a member", () => {
    expect(
      mergeDiscoveredChannels(members(archived), [meta(archived, [["archived", "true"]])]),
    ).toEqual([]);
  });

  test("archived=false is kept", () => {
    expect(
      mergeDiscoveredChannels(members(live), [meta(live, [["archived", "false"]])]),
    ).toEqual([live]);
  });

  test("a member channel with no metadata is kept", () => {
    expect(mergeDiscoveredChannels(members(unknown), [])).toEqual([unknown]);
  });

  test("discovery filters match buzz-acp (39002 #p, then 39000 #d)", () => {
    const pk = "d".repeat(64);
    expect(buildMembersDiscoveryFilter(pk)).toEqual({
      kinds: [KIND_GROUP_MEMBERS],
      "#p": [pk],
    });
    expect(buildMetadataDiscoveryFilter([live, archived])).toEqual({
      kinds: [KIND_GROUP_METADATA],
      "#d": [live, archived],
    });
  });
});

describe("membership-notif", () => {
  const pk = "d".repeat(64);
  const ch = "11111111-1111-1111-1111-111111111111";

  test("join extracts the channel from h and uses created_at as replay_since", () => {
    expect(
      membershipNotifAction(
        ev({
          kind: KIND_MEMBER_ADDED,
          created_at: 1_700_000_042,
          tags: [
            ["p", pk],
            ["h", ch],
          ],
        }),
        pk,
      ),
    ).toEqual({ type: "join", channelId: ch, replaySince: 1_700_000_042 });
  });

  test("leave removes the channel", () => {
    expect(
      membershipNotifAction(
        ev({
          kind: KIND_MEMBER_REMOVED,
          tags: [
            ["p", pk],
            ["h", ch],
          ],
        }),
        pk,
      ),
    ).toEqual({ type: "leave", channelId: ch });
  });

  test("membership-notif filter is kinds 44100+44101 with #p", () => {
    expect(buildMembershipNotifFilter(pk, 9)).toEqual({
      kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED],
      "#p": [pk],
      since: 9,
    });
  });

  test("leave removes a tracked sub", () => {
    const tracker = new ChannelTracker();
    tracker.add(ch, 100);
    expect(tracker.ids()).toEqual([ch]);
    const action = membershipNotifAction(
      ev({
        kind: KIND_MEMBER_REMOVED,
        created_at: 200,
        tags: [
          ["p", pk],
          ["h", ch],
        ],
      }),
      pk,
    );
    expect(action.type).toBe("leave");
    if (action.type === "leave") {
      expect(tracker.acceptMembership(action.channelId, 200)).toBe(true);
      expect(tracker.remove(action.channelId)).toBe(true);
    }
    expect(tracker.has(ch)).toBe(false);
    expect(tracker.ids()).toEqual([]);
  });

  test("stale membership notifs older than the newest for that channel are ignored", () => {
    const tracker = new ChannelTracker();
    expect(tracker.acceptMembership(ch, 200)).toBe(true);
    expect(tracker.acceptMembership(ch, 199)).toBe(false);
    expect(tracker.acceptMembership(ch, 200)).toBe(true);
  });

  test("rediscovery sync adds missing channels and removes leftovers", () => {
    const tracker = new ChannelTracker();
    tracker.add("old", 1);
    tracker.add("keep", 2);
    const { add, remove } = tracker.sync(["keep", "new"], 50);
    expect(remove).toEqual(["old"]);
    expect(add).toEqual([{ id: "new", since: 50 }]);
  });
});

describe("keys and webhook headers", () => {
  test("parses nsec and hex secret keys", () => {
    const sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    const hex = Buffer.from(sk).toString("hex");
    expect(parseSecretKey(nsec)).toEqual(sk);
    expect(parseSecretKey(hex)).toEqual(sk);
    expect(parseSecretKey(`${hex}\n`)).toEqual(sk);
  });

  test("parses npub and hex pubkeys", () => {
    const pk = getPublicKey(generateSecretKey());
    expect(parsePubkey(pk.toUpperCase())).toBe(pk.toLowerCase());
    expect(parsePubkey(nip19.npubEncode(pk))).toBe(pk.toLowerCase());
  });

  test("resolveKeyFile joins systemd credentials dir for relative paths", () => {
    expect(resolveKeyFile("listener_key", "/run/credentials/svc")).toBe(
      "/run/credentials/svc/listener_key",
    );
    expect(resolveKeyFile("/etc/credstore/listener_key", "/run/credentials/svc")).toBe(
      "/etc/credstore/listener_key",
    );
    expect(resolveKeyFile("grokbot_ears_key", "/run/credentials/svc")).toBe(
      "/run/credentials/svc/grokbot_ears_key",
    );
  });

  test("webhookHeaders adds both auth headers only when bearer is set", () => {
    expect(webhookHeaders()).toEqual({ "content-type": "application/json" });
    expect(webhookHeaders("secret-token")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret-token",
      "x-automation-key": "secret-token",
    });
  });
});

describe("key file load", () => {
  test("BOT_PRIVATE_KEY_FILE wins and LISTENER_* is accepted with deprecation", () => {
    const sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    const dir = tmpDir();
    writeFileSync(join(dir, "grokbot_ears_key"), `${nsec}\n`, { mode: 0o400 });
    const loaded = loadBotSecretKey(
      {
        BOT_PRIVATE_KEY_FILE: "grokbot_ears_key",
        CREDENTIALS_DIRECTORY: dir,
      },
      (path) => readFileSync(path, "utf8"),
    );
    expect(loaded.secret).toEqual(sk);
    expect(loaded.source).toBe("BOT_PRIVATE_KEY_FILE");
    expect(loaded.deprecated).toBe(false);

    writeFileSync(join(dir, "listener_key"), `${nsec}\n`, { mode: 0o400 });
    const legacy = loadBotSecretKey(
      {
        LISTENER_PRIVATE_KEY_FILE: "listener_key",
        CREDENTIALS_DIRECTORY: dir,
      },
      (path) => readFileSync(path, "utf8"),
    );
    expect(legacy.secret).toEqual(sk);
    expect(legacy.source).toBe("LISTENER_PRIVATE_KEY_FILE");
    expect(legacy.deprecated).toBe(true);
    expect(deprecationMessage(legacy.source)).toBe(
      "LISTENER_PRIVATE_KEY_FILE is deprecated; use BOT_PRIVATE_KEY_FILE",
    );
  });

  test("BOT_PRIVATE_KEY is preferred over LISTENER_PRIVATE_KEY", () => {
    const bot = generateSecretKey();
    const old = generateSecretKey();
    const picked = pickBotSecretSource({
      BOT_PRIVATE_KEY: Buffer.from(bot).toString("hex"),
      LISTENER_PRIVATE_KEY: Buffer.from(old).toString("hex"),
    });
    expect(picked.source).toBe("BOT_PRIVATE_KEY");
    expect(picked.deprecated).toBe(false);
    expect(parseSecretKey(picked.inline!)).toEqual(bot);
  });
});

describe("SeenRing", () => {
  test("dedupes and evicts oldest after cap", () => {
    const ring = new SeenRing(3);
    expect(ring.add("a")).toBe(true);
    expect(ring.add("a")).toBe(false);
    expect(ring.add("b")).toBe(true);
    expect(ring.add("c")).toBe(true);
    expect(ring.add("d")).toBe(true);
    expect(ring.add("a")).toBe(true);
  });

  test("default cap is 1000", () => {
    const ring = new SeenRing();
    for (let i = 0; i < SEEN_CAP; i++) ring.add(String(i));
    expect(ring.add("0")).toBe(false);
    expect(ring.add("new")).toBe(true);
    expect(ring.add("0")).toBe(true);
  });
});

describe("secret hygiene", () => {
  test("a malformed nsec never appears in the error", () => {
    const bad = `nsec1${"q".repeat(58)}zzzzz`;
    expect(() => parseSecretKey(bad)).toThrow("invalid nsec secret key");
    try {
      parseSecretKey(bad);
    } catch (err) {
      const e = err as Error;
      expect(e.message).not.toContain("nsec1");
      expect(String(e.stack)).not.toContain(bad);
    }
  });

  test("a malformed hex secret never appears in the error", () => {
    try {
      parseSecretKey("deadbeef");
    } catch (err) {
      expect((err as Error).message).not.toContain("deadbeef");
    }
  });

  test("nothing logs secrets when loading keys or warning about aliases", () => {
    const sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    const hex = Buffer.from(sk).toString("hex");
    const warnings: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    const origError = console.error;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    console.log = (msg?: unknown) => {
      logs.push(String(msg));
    };
    console.error = (msg?: unknown) => {
      logs.push(String(msg));
    };
    try {
      loadConfigFromEnv(
        {
          RELAY_URL: "wss://relay.example.com",
          WEBHOOK_URL: "https://webhook.example.com/hook",
          LISTENER_PRIVATE_KEY: nsec,
          WEBHOOK_BEARER: "super-secret-bearer",
          BOT_MENTION_TEXT: "@should-not-wake",
        },
        {
          readFile: () => {
            throw new Error("not used");
          },
          warn: (msg) => warnings.push(msg),
        },
      );
      expect(() =>
        loadBotSecretKey({ BOT_PRIVATE_KEY: "deadbeef" }, () => ""),
      ).toThrow("invalid hex secret key");
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origError;
    }
    const all = [...warnings, ...logs].join("\n");
    expect(logLooksLikeSecret(all, [nsec, hex, "super-secret-bearer"])).toBe(false);
    expect(all).not.toContain(nsec);
    expect(all).not.toContain(hex);
    expect(warnings.some((w) => w.includes("LISTENER_PRIVATE_KEY is deprecated"))).toBe(
      true,
    );
    expect(webhookAttemptLog("ab".repeat(32), "200", 3)).not.toContain(nsec);
  });
});

describe("isRetryableWebhookError", () => {
  test("a timeout or abort is not retried", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isRetryableWebhookError(timeout)).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableWebhookError(abort)).toBe(false);
  });

  test("a connection failure is retried", () => {
    expect(isRetryableWebhookError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("nextBackoff", () => {
  test("escalates while connections keep dying young", () => {
    let b = BACKOFF_MIN_MS;
    b = nextBackoff(b, 300);
    expect(b).toBe(2000);
    b = nextBackoff(b, 300);
    expect(b).toBe(4000);
  });

  test("caps at the maximum", () => {
    expect(nextBackoff(BACKOFF_MAX_MS, 0)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(20_000, 0)).toBe(BACKOFF_MAX_MS);
  });

  test("resets only after a connection that stayed up", () => {
    expect(nextBackoff(16_000, BACKOFF_RESET_AFTER_MS)).toBe(BACKOFF_MIN_MS);
    expect(nextBackoff(16_000, BACKOFF_RESET_AFTER_MS - 1)).toBe(BACKOFF_MAX_MS);
  });
});
