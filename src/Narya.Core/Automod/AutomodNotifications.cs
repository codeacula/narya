using MediatR;

namespace Narya.Core.Automod;

/// <summary>
/// Published for <c>automod.message.hold</c> (v2) — a port of legacy's <c>recordAutomodHold</c>
/// input shape (<c>legacy/src/server/eventsub.ts</c>'s <c>automod.message.hold</c> case).
/// Deliberately a plain <see cref="INotification"/>, never an
/// <c>Narya.Core.Realtime.IRealtimeNotification</c> — moderated content must never reach an
/// overlay browser source (see <c>Narya.Core.Realtime.RealtimeEventNames</c>'s doc comment), and
/// broadcasting a hold before <c>Narya.Application.Automod.RecordAutomodHoldHandler</c> has
/// persisted it would let a client observe <c>automod:held</c> for a message the queue does not
/// yet contain.
///
/// <see cref="Channel"/>/<see cref="Category"/>/<see cref="Level"/> are additive relative to
/// Phase 2's original shape (which carried only <see cref="MessageId"/>/<see cref="Username"/>/
/// <see cref="DisplayName"/>/<see cref="Message"/>/<see cref="Reason"/>/<see cref="HeldAt"/>) —
/// <c>Narya.Database.Automod.AutomodHoldDocument</c> needs all three (legacy <c>automod_holds</c>
/// columns this notification never carried before this phase wired a consumer).
/// <see cref="Channel"/> is Twitch's raw <c>broadcaster_user_login</c> (possibly empty —
/// TwitchLib string properties default to <see cref="string.Empty"/>, never null);
/// <c>Narya.Application.Automod.RecordAutomodHoldHandler</c> falls back to the configured
/// channel when it is, mirroring legacy's <c>event.broadcaster_user_login ?? appConfig.twitchChannel</c>
/// — a config lookup the dispatcher itself cannot perform (twitchlib-spec.md §3.5/§4: the
/// dispatcher is a pure function, no I/O). <see cref="Category"/>/<see cref="Level"/> come from
/// Twitch's nested <c>automod</c> object (null when the hold was caught by a blocked term
/// instead), matching legacy's <c>automod?.category ?? null</c>/<c>automod?.level ?? null</c>.
///
/// Originally defined in <c>Narya.Twitch.EventSub.Notifications</c> (Phase 2); moved here in
/// Phase 3 Task 6 for the same reference-direction reason <c>Narya.Core.Chat.ChatMessage</c>
/// moved — <c>Narya.Application.Automod.RecordAutomodHoldHandler</c> (this notification's
/// consumer) lives in Narya.Application, and Narya.Application deliberately does not reference
/// Narya.Twitch (see <c>Narya.Application.csproj</c>: only Narya.Core/Narya.Domain).
/// Narya.Twitch already references Narya.Core, so <c>EventSubDispatcher</c> publishing this type
/// is unaffected by the move — only its <c>using</c> and the fields it populates changed.
/// </summary>
public sealed record AutomodHeldNotification(
  string MessageId,
  string Channel,
  string Username,
  string DisplayName,
  string Message,
  string Reason,
  string? Category,
  int? Level,
  DateTimeOffset HeldAt) : INotification;

/// <summary>
/// Published for <c>automod.message.update</c> (v2) — Twitch's own, authoritative verdict on a
/// previously held message. <see cref="Status"/> is Twitch's raw value
/// (<c>Approved</c>/<c>Denied</c>/<c>Expired</c>) — <c>Narya.Application.Automod.ResolveAutomodHoldHandler</c>
/// normalizes it to <c>Narya.Core.Automod.IAutomodStore</c>'s <c>allowed</c>/<c>denied</c>/
/// <c>expired</c> resolution vocabulary and calls <c>IAutomodStore.ResolveHoldAsync</c> with
/// <c>authoritative: true</c> — Twitch's own verdict outranks any <c>expired</c> this process
/// recorded provisionally (the sweep, or a "gone" allow/deny outcome), matching legacy's comment
/// on this exact call site verbatim.
///
/// Deliberately a plain <see cref="INotification"/> — same ingested-not-broadcast rationale as
/// <see cref="AutomodHeldNotification"/>.
///
/// Originally defined in <c>Narya.Twitch.EventSub.Notifications</c> (Phase 2); moved here in
/// Phase 3 Task 6 for the same reference-direction reason <see cref="AutomodHeldNotification"/>
/// moved. Shape unchanged by the move.
/// </summary>
public sealed record AutomodResolvedNotification(string MessageId, string Status, string ModeratorUserName) : INotification;
