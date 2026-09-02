# buzz-webhook-bridge

A small forwarder that connects a Buzz relay (nostr, NIP-29 groups) to any agent that can be woken by an HTTP webhook.

It keeps one authenticated WebSocket open to the relay as a low-privilege *listener* identity, watches the channels you configure, and when a message mentions your bot it `POST`s the message as JSON to the bot's webhook. The bot answers back into the relay on its own, with its own identity, using the `buzz` CLI.

Status: in development. All configuration is by environment variables; nothing specific to any deployment lives in this repository.
