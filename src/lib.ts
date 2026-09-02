import { getPublicKey, nip19 } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";
import { join, isAbsolute } from "node:path";

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 8000;
export const SEEN_CAP = 1000;
export const CHANNEL_KIND = 9;
export const FORUM_KINDS = [45001, 45003] as const;

export type MentionOpts = {
  botMentionText?: string;
  botPubkey?: string;
};

export type WebhookPayload = {
  source: "buzz";
  relay: string;
  channel: string;
  event_id: string;
  thread_root: string;
  reply_to: string;
  author: string;
  kind: number;
  created_at: number;
  text: string;
};

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error("invalid hex secret key");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("nsec1")) {
    // bech32 decode errors embed the input verbatim ("Invalid checksum in nsec1..."),
    // so never let the original error escape — it would put the key in the logs.
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(trimmed);
    } catch {
      throw new Error("invalid nsec secret key");
    }
    if (decoded.type !== "nsec") {
      throw new Error("expected nsec");
    }
    return decoded.data;
  }
  return hexToBytes(trimmed);
}

export function parsePubkey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("expected npub");
    }
    return decoded.data.toLowerCase();
  }
  const hex = trimmed.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("invalid pubkey");
  }
  return hex;
}

export function resolveKeyFile(
  file: string,
  credentialsDirectory?: string,
): string {
  if (isAbsolute(file)) return file;
  if (credentialsDirectory) return join(credentialsDirectory, file);
  return file;
}

export function parseChannelIds(raw: string): string[] {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("CHANNEL_IDS is empty");
  }
  return ids;
}

export function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function wsUrl(relayUrl: string): string {
  const u = relayUrl.trim();
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}`;
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}`;
  return u;
}

export function buildFilter(opts: {
  channelIds: string[];
  since: number;
  includeForumKinds: boolean;
}): Filter {
  const kinds = opts.includeForumKinds
    ? [CHANNEL_KIND, ...FORUM_KINDS]
    : [CHANNEL_KIND];
  return {
    kinds,
    since: opts.since,
    "#h": opts.channelIds,
  };
}

export function isIgnoredAuthor(
  event: Pick<Event, "pubkey">,
  opts: { botPubkey?: string; listenerPubkey: string },
): boolean {
  const author = event.pubkey.toLowerCase();
  if (author === opts.listenerPubkey.toLowerCase()) return true;
  if (opts.botPubkey && author === opts.botPubkey.toLowerCase()) return true;
  return false;
}

export function isMention(
  event: Pick<Event, "content" | "tags">,
  opts: MentionOpts,
): boolean {
  const text = opts.botMentionText?.trim();
  if (text && event.content.toLowerCase().includes(text.toLowerCase())) {
    return true;
  }
  const pk = opts.botPubkey?.toLowerCase();
  if (pk) {
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1]?.toLowerCase() === pk) return true;
    }
  }
  return false;
}

export function channelId(event: Pick<Event, "tags">): string {
  const tag = event.tags.find((t) => t[0] === "h" && t[1]);
  return tag?.[1] ?? "";
}

export function threadRoot(event: Pick<Event, "id" | "tags">): string {
  const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => t[3] === "root");
  if (root?.[1]) return root[1];
  const reply = eTags.find((t) => t[3] === "reply");
  if (reply?.[1]) return reply[1];
  if (eTags[0]?.[1]) return eTags[0][1];
  return event.id;
}

export function buildPayload(event: Event, relayUrl: string): WebhookPayload {
  return {
    source: "buzz",
    relay: relayUrl,
    channel: channelId(event),
    event_id: event.id,
    thread_root: threadRoot(event),
    reply_to: event.id,
    author: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    text: event.content,
  };
}

export function webhookHeaders(bearer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
    headers["x-automation-key"] = bearer;
  }
  return headers;
}

export class SeenRing {
  private readonly ids: string[] = [];
  private readonly set = new Set<string>();

  constructor(private readonly cap = SEEN_CAP) {}

  /** Returns true if `id` was not already present. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.ids.push(id);
    if (this.ids.length > this.cap) {
      const old = this.ids.shift();
      if (old) this.set.delete(old);
    }
    return true;
  }
}

export function pubkeyOf(secret: Uint8Array): string {
  return getPublicKey(secret);
}

/**
 * A webhook attempt is only retried when the request never reached the server.
 * A timeout/abort means the server may well have received and acted on it, so
 * retrying would double-deliver; treat it as final, like any HTTP status.
 */
export function isRetryableWebhookError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return false;
  return true;
}

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** A connection is only "good" once it has stayed up this long. */
export const BACKOFF_RESET_AFTER_MS = 60_000;

/**
 * Escalate unless the connection we just lost was healthy for a while. Resetting
 * on every disconnect pins the delay at the minimum against a relay that accepts
 * the socket and drops it immediately.
 */
export function nextBackoff(current: number, connectionUptimeMs: number): number {
  if (connectionUptimeMs >= BACKOFF_RESET_AFTER_MS) return BACKOFF_MIN_MS;
  return Math.min(current * 2, BACKOFF_MAX_MS);
}
