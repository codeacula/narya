---
name: eventsub-integration
description: Twitch EventSub WebSocket integration - which env credentials are used, what events are subscribed, and where to find the code
metadata:
  type: project
---

Twitch EventSub WebSocket client is implemented in `src/server/index.ts` alongside the Twitch OAuth/API helpers. It auto-connects during server startup.

**Credentials**:
- `TWITCH_CLIENT_ID`
- `TWITCH_USER_TOKEN`
- Read from `.env` / process environment only; the dashboard does not collect or store Twitch credentials

**Subscribed events**: channel.follow, channel.subscribe, channel.subscription.message, channel.subscription.gift, channel.cheer, channel.raid, channel.channel_points_custom_reward_redemption.add

**Storage**: real events are stored in `stream_events` table; served from `/api/dashboard/events`

**Frontend**: `src/client/pages/Dashboard.tsx` uses `useSocket('stream:event')` for real-time updates

**Why:** User requested follows, raids, subs, and other Twitch channel events. PubSub is deprecated; EventSub WebSocket is the correct modern API.

**How to apply:** When touching event handling or Twitch API calls, look here first. The broadcaster ID is lazily fetched and cached in memory.
