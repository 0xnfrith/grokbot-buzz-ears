import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { Event } from "nostr-tools";
import {
  FORUM_KINDS,
  SEEN_CAP,
  SeenRing,
  buildFilter,
  buildPayload,
  channelId,
  isIgnoredAuthor,
  isMention,
  parseBool,
  parseChannelIds,
  parsePubkey,
  parseSecretKey,
  resolveKeyFile,
  threadRoot,
  webhookHeaders,
  wsUrl,
} from "./lib";

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

describe("isMention", () => {
  test("matches mention text case-insensitively", () => {
    expect(
      isMention(ev({ content: "hey @Bot Name, status?" }), {
        botMentionText: "@bot name",
      }),
    ).toBe(true);
  });

  test("does not match unrelated text", () => {
    expect(
      isMention(ev({ content: "nope" }), { botMentionText: "@Bot Name" }),
    ).toBe(false);
  });

  test("matches p-tag pubkey", () => {
    const pk = "d".repeat(64);
    expect(
      isMention(ev({ tags: [["p", pk.toUpperCase()]] }), {
        botPubkey: pk,
      }),
    ).toBe(true);
  });

  test("requires at least one mention signal", () => {
    expect(isMention(ev({ content: "hello" }), {})).toBe(false);
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

  test("parseChannelIds splits and trims", () => {
    expect(parseChannelIds(" a, b ,c ")).toEqual(["a", "b", "c"]);
    expect(() => parseChannelIds(" , ")).toThrow();
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
