# buzz-webhook-bridge

A small forwarder that connects a Buzz relay (Nostr, NIP-29 groups) to any agent that can be woken by an HTTP webhook.

It keeps one authenticated WebSocket open to the relay as a low-privilege *listener* identity, watches the channels you configure, and when a message mentions your bot it `POST`s the message as JSON to the bot's webhook. The bot answers back into the relay on its own, with its own identity — this process never publishes.

All configuration is by environment variables. Nothing specific to any deployment lives in this repository.

## What it does

1. Opens a WebSocket to `RELAY_URL`, authenticates with [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) using the listener key, and subscribes:

   ```json
   { "#h": ["<channel ids>"], "kinds": [9], "since": <now or last seen> }
   ```

2. Treats an event as a mention when its content contains `BOT_MENTION_TEXT` (case-insensitive) **or** it has a `p` tag equal to `BOT_PUBKEY`. Events authored by the bot or by the listener are ignored. Event ids are de-duplicated in memory (last 1000).

3. On a mention, `POST`s JSON to `WEBHOOK_URL`:

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

4. Reconnects with exponential backoff (1s … 30s) on any close, resubscribing with `since` = last seen `created_at`. Optional `STATE_FILE` persists that timestamp across process restarts.

The listener key should be a plain channel member, never an owner. Revoke it by removing it from the channel.

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
| `CHANNEL_IDS` | yes | — | Comma-separated NIP-29 channel ids (`h` tags) |
| `BOT_MENTION_TEXT` | one of\* | — | Substring that counts as a mention, e.g. `@Bot Name` |
| `BOT_PUBKEY` | one of\* | — | Bot pubkey (hex or `npub`) matched against `p` tags |
| `LISTENER_PRIVATE_KEY` | one of† | — | Listener secret (hex or `nsec`) |
| `LISTENER_PRIVATE_KEY_FILE` | one of† | — | File containing that secret; see systemd below |
| `WEBHOOK_URL` | yes | — | `POST` target |
| `WEBHOOK_BEARER` | no | unset | Shared secret for the two webhook auth headers |
| `WEBHOOK_TIMEOUT_MS` | no | `8000` | Per-attempt timeout; one retry on **network error only** (not 4xx) |
| `INCLUDE_FORUM_KINDS` | no | `false` | Also subscribe to kinds `45001` and `45003` |
| `STATE_FILE` | no | unset | Path written with last-seen unix timestamp |
| `HEALTH_PORT` | no | unset | If set, `GET /healthz` → `{"ok":true,"connected":bool,"last_event_at":…}` |
| `CREDENTIALS_DIRECTORY` | no | unset | Set by systemd `LoadCredential=`; used to resolve a relative key file |

\* At least one of `BOT_MENTION_TEXT` / `BOT_PUBKEY`.  
† At least one of `LISTENER_PRIVATE_KEY` / `LISTENER_PRIVATE_KEY_FILE` (`LISTENER_PRIVATE_KEY` wins if both are set).

Logs one line per webhook attempt: event id, status code (or `network_error`), latency in ms. The bearer and the POST body are never logged.

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

Store the listener secret outside the unit file. `LoadCredential=` copies it into `$CREDENTIALS_DIRECTORY` at runtime (mode `0400`, not visible in `/proc`).

`/etc/credstore/listener_key` — the nsec or hex secret, one line.

`/etc/buzz-webhook-bridge.env` — everything else (`RELAY_URL`, `CHANNEL_IDS`, `WEBHOOK_URL`, …). Do not put the listener secret here.

```ini
[Unit]
Description=buzz webhook bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/buzz-webhook-bridge
EnvironmentFile=/etc/buzz-webhook-bridge.env
LoadCredential=listener_key:/etc/credstore/listener_key
Environment=LISTENER_PRIVATE_KEY_FILE=listener_key
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

A relative `LISTENER_PRIVATE_KEY_FILE` is resolved against `$CREDENTIALS_DIRECTORY` when that variable is set, so `listener_key` reads `$CREDENTIALS_DIRECTORY/listener_key`. Absolute paths are used as-is.

## Docker

```bash
docker build -t buzz-webhook-bridge .
docker run --rm --env-file .env buzz-webhook-bridge
```

Pass `LISTENER_PRIVATE_KEY` in the env file, or mount a key file and set `LISTENER_PRIVATE_KEY_FILE`.

## License

MIT — copyright 0xnfrith.
