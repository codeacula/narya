---
name: eventsub-integration
description: Twitch EventSub WebSocket integration — how credentials are stored, what events are subscribed, and where to find the code
metadata:
  type: project
---

Twitch EventSub WebSocket client is implemented inline in `server/index.ts` (around line 150+). It auto-connects on server startup.

**Credentials** (env vars take precedence over DB):
- `TWITCH_CLIENT_ID` / DB key `twitch_client_id`
- `TWITCH_USER_TOKEN` / DB key `twitch_user_token`
- Stored in the `settings` SQLite table; editable via Dashboard → Settings → Connections

**Subscribed events**: channel.follow, channel.subscribe, channel.subscription.message, channel.subscription.gift, channel.cheer, channel.raid, channel.channel_points_custom_reward_redemption.add

**Storage**: real events are stored in `stream_events` table; served from `/api/dashboard/events`

**Frontend**: Dashboard.tsx uses `useSocket('stream:event')` for real-time updates; Settings page has Connections group for entering Client ID + User Token

**Why:** User requested follows, raids, subs, and other Twitch channel events. PubSub is deprecated; EventSub WebSocket is the correct modern API.

**How to apply:** When touching event handling or Twitch API calls, look here first. The broadcaster ID is lazily fetched and cached in memory.
