import { getPublicKey, nip19 } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";
import { join, isAbsolute } from "node:path";

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 8000;
export const DEFAULT_REDISCOVERY_INTERVAL_MS = 60_000;
export const SEEN_CAP = 1000;
export const CHANNEL_KIND = 9;
export const FORUM_KINDS = [45001, 45003] as const;
export const ACP_STREAM_KINDS = [46010, 40007] as const;
export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_MEMBERS = 39002;
export const KIND_MEMBER_ADDED = 44100;
export const KIND_MEMBER_REMOVED = 44101;

export type MentionOpts = {
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

export type KeySource =
  | "BOT_PRIVATE_KEY"
  | "BOT_PRIVATE_KEY_FILE"
  | "LISTENER_PRIVATE_KEY"
  | "LISTENER_PRIVATE_KEY_FILE";

export type EnvMap = Record<string, string | undefined>;

export type MembershipAction =
  | { type: "join"; channelId: string; replaySince: number }
  | { type: "leave"; channelId: string }
  | { type: "ignore" };

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

export function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("expected a positive integer");
  }
  return n;
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
  includeAcpStreamKinds?: boolean;
  mentionPubkey?: string;
}): Filter {
  const kinds: number[] = opts.includeForumKinds
    ? [CHANNEL_KIND, ...FORUM_KINDS]
    : [CHANNEL_KIND];
  if (opts.includeAcpStreamKinds) {
    kinds.push(...ACP_STREAM_KINDS);
  }
  const filter: Filter = {
    kinds,
    since: opts.since,
    "#h": opts.channelIds,
  };
  if (opts.mentionPubkey) {
    filter["#p"] = [opts.mentionPubkey];
  }
  return filter;
}

export function buildChannelFilter(opts: {
  channelId: string;
  since: number;
  includeForumKinds: boolean;
  includeAcpStreamKinds?: boolean;
  mentionPubkey: string;
}): Filter {
  return buildFilter({
    channelIds: [opts.channelId],
    since: opts.since,
    includeForumKinds: opts.includeForumKinds,
    includeAcpStreamKinds: opts.includeAcpStreamKinds,
    mentionPubkey: opts.mentionPubkey,
  });
}

export function buildMembersDiscoveryFilter(pubkey: string): Filter {
  return { kinds: [KIND_GROUP_MEMBERS], "#p": [pubkey] };
}

export function buildMetadataDiscoveryFilter(channelIds: string[]): Filter {
  return { kinds: [KIND_GROUP_METADATA], "#d": channelIds };
}

export function buildMembershipNotifFilter(pubkey: string, since: number): Filter {
  return {
    kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED],
    "#p": [pubkey],
    since,
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
  const pk = opts.botPubkey?.toLowerCase();
  if (!pk) return false;
  for (const tag of event.tags) {
    if (tag[0] === "p" && tag[1]?.toLowerCase() === pk) return true;
  }
  return false;
}

export function shouldWake(
  event: Pick<Event, "pubkey" | "content" | "tags">,
  ourPubkey: string,
): boolean {
  if (
    isIgnoredAuthor(event, {
      botPubkey: ourPubkey,
      listenerPubkey: ourPubkey,
    })
  ) {
    return false;
  }
  return isMention(event, { botPubkey: ourPubkey });
}

export function channelId(event: Pick<Event, "tags">): string {
  const tag = event.tags.find((t) => t[0] === "h" && t[1]);
  return tag?.[1] ?? "";
}

export function dTag(event: Pick<Event, "tags">): string {
  const tag = event.tags.find((t) => t[0] === "d" && t[1]);
  return tag?.[1] ?? "";
}

export function isArchivedMetadata(event: Pick<Event, "tags">): boolean {
  return event.tags.some((t) => t[0] === "archived" && t[1] === "true");
}

export function memberChannelIds(
  memberEvents: Pick<Event, "kind" | "tags">[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ev of memberEvents) {
    if (ev.kind !== KIND_GROUP_MEMBERS) continue;
    const id = dTag(ev);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Build the subscribe set from kind:39002 membership events and kind:39000
 * metadata, skipping any channel flagged `archived=true`. A member channel
 * with no metadata is kept (treated as live / unknown), matching buzz-acp.
 */
export function mergeDiscoveredChannels(
  memberEvents: Pick<Event, "kind" | "tags">[],
  metaEvents: Pick<Event, "kind" | "tags">[],
): string[] {
  const archived = new Set<string>();
  for (const ev of metaEvents) {
    if (ev.kind !== KIND_GROUP_METADATA) continue;
    const id = dTag(ev);
    if (id && isArchivedMetadata(ev)) archived.add(id);
  }
  return memberChannelIds(memberEvents).filter((id) => !archived.has(id));
}

export function membershipNotifAction(
  event: Pick<Event, "kind" | "created_at" | "tags">,
  ourPubkey: string,
): MembershipAction {
  if (event.kind !== KIND_MEMBER_ADDED && event.kind !== KIND_MEMBER_REMOVED) {
    return { type: "ignore" };
  }
  const pk = ourPubkey.toLowerCase();
  const mentionsUs = event.tags.some(
    (t) => t[0] === "p" && t[1]?.toLowerCase() === pk,
  );
  if (!mentionsUs) return { type: "ignore" };
  const id = channelId(event);
  if (!id) return { type: "ignore" };
  if (event.kind === KIND_MEMBER_ADDED) {
    return { type: "join", channelId: id, replaySince: event.created_at };
  }
  return { type: "leave", channelId: id };
}

/** In-memory set of channel ids we currently subscribe to, plus the since used. */
export class ChannelTracker {
  private readonly channels = new Map<string, number>();
  private readonly membershipNewest = new Map<string, number>();

  has(id: string): boolean {
    return this.channels.has(id);
  }

  ids(): string[] {
    return [...this.channels.keys()];
  }

  since(id: string): number | undefined {
    return this.channels.get(id);
  }

  /** Returns true if the channel was not already tracked. */
  add(id: string, since: number): boolean {
    if (this.channels.has(id)) return false;
    this.channels.set(id, since);
    return true;
  }

  /** Returns true if the channel was present and is now gone. */
  remove(id: string): boolean {
    return this.channels.delete(id);
  }

  /**
   * Accept a membership notification if it is not older than the newest one
   * already applied for that channel. Uses strict `<` so add→remove in the
   * same second both apply (buzz-acp membership_newest_ts).
   */
  acceptMembership(channelId: string, createdAt: number): boolean {
    const newest = this.membershipNewest.get(channelId);
    if (newest !== undefined && createdAt < newest) return false;
    this.membershipNewest.set(channelId, createdAt);
    return true;
  }

  sync(
    desired: Iterable<string>,
    defaultSince: number,
  ): { add: { id: string; since: number }[]; remove: string[] } {
    const want = new Set(desired);
    const remove = this.ids().filter((id) => !want.has(id));
    const add = [...want]
      .filter((id) => !this.channels.has(id))
      .map((id) => ({ id, since: defaultSince }));
    return { add, remove };
  }
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

export function webhookAttemptLog(
  eventId: string,
  status: string,
  latency: number,
  retry?: boolean,
): string {
  return retry
    ? `event=${eventId} status=${status} latency_ms=${latency} retry=1`
    : `event=${eventId} status=${status} latency_ms=${latency}`;
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

function trimEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

export function deprecationMessage(source: KeySource): string | undefined {
  if (source === "LISTENER_PRIVATE_KEY") {
    return "LISTENER_PRIVATE_KEY is deprecated; use BOT_PRIVATE_KEY";
  }
  if (source === "LISTENER_PRIVATE_KEY_FILE") {
    return "LISTENER_PRIVATE_KEY_FILE is deprecated; use BOT_PRIVATE_KEY_FILE";
  }
  return undefined;
}

export function pickBotSecretSource(env: EnvMap): {
  source: KeySource;
  deprecated: boolean;
  inline?: string;
  file?: string;
} {
  const botInline = trimEnv(env.BOT_PRIVATE_KEY);
  if (botInline) {
    return { source: "BOT_PRIVATE_KEY", deprecated: false, inline: botInline };
  }
  const botFile = trimEnv(env.BOT_PRIVATE_KEY_FILE);
  if (botFile) {
    return { source: "BOT_PRIVATE_KEY_FILE", deprecated: false, file: botFile };
  }
  const oldInline = trimEnv(env.LISTENER_PRIVATE_KEY);
  if (oldInline) {
    return {
      source: "LISTENER_PRIVATE_KEY",
      deprecated: true,
      inline: oldInline,
    };
  }
  const oldFile = trimEnv(env.LISTENER_PRIVATE_KEY_FILE);
  if (oldFile) {
    return {
      source: "LISTENER_PRIVATE_KEY_FILE",
      deprecated: true,
      file: oldFile,
    };
  }
  throw new Error("set BOT_PRIVATE_KEY_FILE or BOT_PRIVATE_KEY");
}

export function loadBotSecretKey(
  env: EnvMap,
  readFile: (path: string) => string,
): { secret: Uint8Array; source: KeySource; deprecated: boolean } {
  const picked = pickBotSecretSource(env);
  if (picked.inline !== undefined) {
    return {
      secret: parseSecretKey(picked.inline),
      source: picked.source,
      deprecated: picked.deprecated,
    };
  }
  const path = resolveKeyFile(picked.file!, trimEnv(env.CREDENTIALS_DIRECTORY));
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    throw new Error(`failed to read ${picked.source}`);
  }
  return {
    secret: parseSecretKey(raw),
    source: picked.source,
    deprecated: picked.deprecated,
  };
}

export function logLooksLikeSecret(text: string, secrets: string[]): boolean {
  return secrets.some((s) => s.length > 0 && text.includes(s));
}
