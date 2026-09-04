import {
  DEFAULT_REDISCOVERY_INTERVAL_MS,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  deprecationMessage,
  loadBotSecretKey,
  parseBool,
  parsePositiveInt,
  parsePubkey,
  pubkeyOf,
  wsUrl,
  type EnvMap,
} from "./lib";

export type Config = {
  relayUrl: string;
  wsUrl: string;
  botSk: Uint8Array;
  botPubkey: string;
  webhookUrl: string;
  webhookBearer?: string;
  webhookTimeoutMs: number;
  includeForumKinds: boolean;
  includeAcpStreamKinds: boolean;
  rediscoveryIntervalMs: number;
  stateFile?: string;
  healthPort?: number;
};

function envVal(env: EnvMap, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function loadConfigFromEnv(
  env: EnvMap,
  opts: {
    readFile: (path: string) => string;
    warn?: (msg: string) => void;
  },
): Config {
  const warn = opts.warn ?? (() => {});
  const relayUrl = envVal(env, "RELAY_URL");
  if (!relayUrl) throw new Error("missing RELAY_URL");
  const webhookUrl = envVal(env, "WEBHOOK_URL");
  if (!webhookUrl) throw new Error("missing WEBHOOK_URL");

  if (envVal(env, "CHANNEL_IDS")) {
    warn("CHANNEL_IDS is unused; channels are discovered from membership");
  }
  if (envVal(env, "BOT_MENTION_TEXT")) {
    warn("BOT_MENTION_TEXT is removed; wake is #p only");
  }

  const loaded = loadBotSecretKey(env, opts.readFile);
  const dep = deprecationMessage(loaded.source);
  if (dep) warn(dep);

  const derived = pubkeyOf(loaded.secret);
  const botPubkeyRaw = envVal(env, "BOT_PUBKEY");
  const botPubkey = botPubkeyRaw ? parsePubkey(botPubkeyRaw) : derived;
  if (botPubkeyRaw && botPubkey !== derived) {
    throw new Error("BOT_PUBKEY does not match the private key");
  }

  let webhookTimeoutMs: number;
  let rediscoveryIntervalMs: number;
  let healthPort: number | undefined;
  try {
    webhookTimeoutMs = parsePositiveInt(
      envVal(env, "WEBHOOK_TIMEOUT_MS"),
      DEFAULT_WEBHOOK_TIMEOUT_MS,
    );
  } catch {
    throw new Error("WEBHOOK_TIMEOUT_MS must be a positive integer");
  }
  try {
    rediscoveryIntervalMs = parsePositiveInt(
      envVal(env, "REDISCOVERY_INTERVAL_MS"),
      DEFAULT_REDISCOVERY_INTERVAL_MS,
    );
  } catch {
    throw new Error("REDISCOVERY_INTERVAL_MS must be a positive integer");
  }
  const healthRaw = envVal(env, "HEALTH_PORT");
  if (healthRaw) {
    try {
      healthPort = parsePositiveInt(healthRaw, 0);
    } catch {
      throw new Error("HEALTH_PORT must be a positive integer");
    }
  }

  return {
    relayUrl,
    wsUrl: wsUrl(relayUrl),
    botSk: loaded.secret,
    botPubkey,
    webhookUrl,
    webhookBearer: envVal(env, "WEBHOOK_BEARER"),
    webhookTimeoutMs,
    includeForumKinds: parseBool(envVal(env, "INCLUDE_FORUM_KINDS"), false),
    includeAcpStreamKinds: parseBool(envVal(env, "INCLUDE_ACP_STREAM_KINDS"), false),
    rediscoveryIntervalMs,
    stateFile: envVal(env, "STATE_FILE"),
    healthPort,
  };
}
