# grokbot-ears

GROKBOT's ears: a small forwarder that connects a Buzz relay (Nostr, NIP-29 groups) to any agent that can be woken by an HTTP webhook.

It signs in with the **bot's own key** (the same identity the agent uses), discovers every channel that key is a member of, and when a message `#p`-mentions the bot it `POST`s the message as JSON to the webhook. The bot answers back into the relay on its own — this process never publishes.

There is no `CHANNEL_IDS` list. New invites work without a config edit: membership is rediscovered on a cadence and on membership-notification events.

The GitHub repository slug may still be `buzz-webhook-bridge` until an operator renames it. The process, package, unit, and install paths are `grokbot-ears`.

All configuration is by environment variables. Nothing specific to any deployment lives in this repository.

## What it does

1. Opens a WebSocket to `RELAY_URL` and authenticates with [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) using the bot key.

2. Discovers channels the way Block's `buzz-acp` harness does:
   - Query NIP-29 `kind:39002` (group members) with `#p` = our pubkey, then `kind:39000` metadata; skip `archived=true`.
   - Subscribe to membership notifications (`kind:44100` added / `kind:44101` removed, `#p` = our pubkey). On join, subscribe immediately with `replay_since` = the membership timestamp so a mention in the same second is not missed.
   - Re-query membership every `REDISCOVERY_INTERVAL_MS` (default 60s) as a safety net.
   - One `REQ` per discovered channel id. Drop the sub when rediscovery or a leave notification shows we are no longer a member.

3. Subscribes to **kind 9 only** by default (DM channels are kind 9 too). Forum kinds (`45001`, `45003`) and ACP stream kinds (`46010`, `40007`) stay off unless you opt in.

4. Wakes only when an event has a `p` tag equal to our pubkey. Events we authored are ignored. A text substring is **not** a wake signal (`BOT_MENTION_TEXT` is gone). Thread replies wake only if that reply `#p`-mentions us — there is no auto-wake for every reply in a prior thread. DMs: subscribe when we are a member; wake only on `#p`.

   Anyone who `#p`-mentions the bot is forwarded. A future `RESPOND_TO` author allowlist may restrict that; it is not implemented here.

5. On a mention, `POST`s JSON to `WEBHOOK_URL`:

   ```json
   {
     "source": "buzz",
     "relay": "<RELAY_URL>",
     "channel": "<h tag>",
     "event_id": "…",
     "thread_root": "<e tag marker=root, else reply target, else this event id>",
     "reply_to": "<this event id>",
     "author": "<pubkey hex>",
     "kind": 9,
     "created_at": 0,
     "text": "<content>"
   }
   ```

6. Reconnects with exponential backoff (1s … 30s) on any close, resubscribing with `since` = last seen `created_at`. The backoff only resets after a connection that stayed up for a minute, so a relay that accepts the socket and drops it immediately is backed off rather than hammered once a second. Optional `STATE_FILE` persists that timestamp across process restarts. Event ids are de-duplicated in memory (last 1000).

The forwarder never holds the agent's webhook bearer unless you set `WEBHOOK_BEARER`; it may instead `POST` through an egress proxy that injects the secret.

### Delivery semantics

At-least-once. **The webhook must be idempotent on `event_id`.**

`since` only advances past a mention once the webhook has accepted it (`2xx`), so a
webhook that is down or erroring does not silently drop mentions. Two things can
still deliver the same event twice, and both are cheap to absorb with an
`event_id` check:

- `since` is inclusive, and the in-process dedup ring does not survive a restart,
  so any event sharing the last-seen second is re-sent on the next start.
- The one retry fires only when the request never reached the server. A timeout is
  *not* retried, precisely because the server may already have acted on it.

## Run

```bash
cp .env.example .env
# fill in values — never commit .env
bun install
set -a && . ./.env && set +a
bun run start
```

Requires [Bun](https://bun.sh). Tests: `bun test`.

## Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RELAY_URL` | yes | — | Relay WebSocket URL (`ws://` / `wss://`; `http`/`https` are upgraded) |
| `BOT_PRIVATE_KEY_FILE` | one of\* | — | File containing the bot secret (hex or `nsec`); see systemd below |
| `BOT_PRIVATE_KEY` | one of\* | — | Bot secret inline (hex or `nsec`). Prefer the file form. |
| `BOT_PUBKEY` | no | derived | Hex or `npub`. If set, must match the key. Required in the sense that a pubkey (explicit or derived) is always used as the `#p` wake signal. |
| `WEBHOOK_URL` | yes | — | `POST` target |
| `WEBHOOK_BEARER` | no | unset | Shared secret for the two webhook auth headers |
| `WEBHOOK_TIMEOUT_MS` | no | `8000` | Per-attempt timeout; one retry on **network error only** (not on any HTTP status, not on timeout) |
| `REDISCOVERY_INTERVAL_MS` | no | `60000` | How often to re-query kind:39002 membership |
| `INCLUDE_FORUM_KINDS` | no | `false` | Also subscribe to kinds `45001` and `45003` |
| `INCLUDE_ACP_STREAM_KINDS` | no | `false` | Also subscribe to ACP stream kinds `46010` and `40007` |
| `STATE_FILE` | no | unset | Path written with last-seen unix timestamp |
| `HEALTH_PORT` | no | unset | If set, `GET /healthz` → `{"ok":true,"connected":bool,"last_event_at":…}` |
| `CREDENTIALS_DIRECTORY` | no | unset | Set by systemd `LoadCredential=`; used to resolve a relative key file |

\* At least one of `BOT_PRIVATE_KEY_FILE` / `BOT_PRIVATE_KEY`. For one release, `LISTENER_PRIVATE_KEY_FILE` / `LISTENER_PRIVATE_KEY` are still accepted and log a deprecation warning. `BOT_*` wins when both generations are set. Inline `BOT_PRIVATE_KEY` wins over `BOT_PRIVATE_KEY_FILE`.

`CHANNEL_IDS` and `BOT_MENTION_TEXT` are ignored (a warning is logged if they are set).

Logs one line per webhook attempt: event id, status code (or `network_error` / `timeout`), latency in ms. The bearer, the bot key and the POST body are never logged — including on a malformed key, where the bech32 decoder would otherwise echo the input.

## Webhook auth modes

**Direct.** Set `WEBHOOK_BEARER`. Every POST includes:

```
Authorization: Bearer <WEBHOOK_BEARER>
X-Automation-Key: <WEBHOOK_BEARER>
Content-Type: application/json
```

Use this when the forwarder is allowed to hold the webhook secret.

**Egress proxy.** Leave `WEBHOOK_BEARER` unset. The process sends `Content-Type` only. Put a reverse proxy in front of the webhook (or on the forwarder's outbound path) that injects the secret. The workload then *uses* a credential on outbound calls without ever holding it — the same property as a sidecar that injects secrets. Point `WEBHOOK_URL` at the proxy.

## systemd

Place the bot key via a root-only file and systemd `LoadCredential=` (copied into `$CREDENTIALS_DIRECTORY` at runtime, mode `0400`, not visible in `/proc`). Use placeholders only; never put key material in the unit or in git.

`/etc/credstore/grokbot_ears_key` — the nsec or hex secret, one line.

`/etc/grokbot-ears.env` — everything else (`RELAY_URL`, `WEBHOOK_URL`, …). Do not put the bot secret here.

Unit file `grokbot-ears.service`:

```ini
[Unit]
Description=grokbot-ears
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/grokbot-ears
EnvironmentFile=/etc/grokbot-ears.env
LoadCredential=grokbot_ears_key:/etc/credstore/grokbot_ears_key
Environment=BOT_PRIVATE_KEY_FILE=grokbot_ears_key
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

A relative `BOT_PRIVATE_KEY_FILE` is resolved against `$CREDENTIALS_DIRECTORY` when that variable is set, so `grokbot_ears_key` reads `$CREDENTIALS_DIRECTORY/grokbot_ears_key`. Absolute paths are used as-is.

## Docker

```bash
docker build -t grokbot-ears .
docker run --rm --env-file .env grokbot-ears
```

Mount a key file and set `BOT_PRIVATE_KEY_FILE`, or pass `BOT_PRIVATE_KEY` in the env file (not recommended).

## Cutover

Cutover is an operator/deploy concern. After a live test of the new process, do a hard flip: start `grokbot-ears` and stop the old forwarder unit. Leave the old unit **stopped (not deleted) for one day** so it can be started again if you need to roll back. Channel lists in the old env file are unused; membership is discovered from the relay.

## License

MIT — copyright 0xnfrith.
