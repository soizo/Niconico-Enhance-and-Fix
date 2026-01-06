# Niconico Enhance and Fix

Auto-switches to the embedded player when watch metrics look abnormal (or for Japanese accounts); skips/blocks ads where possible; keeps key controls usable in the embed.

## Features
- Auto-switch to embedded player when view/comment metrics appear abnormal.
- Auto-switch to embedded player for Japanese-locale accounts.
- In the original (non-embed) player, tries to skip/fast-forward ads and click “Skip” buttons when available.
- Hides common ad areas on the watch page with CSS.
- When using the embedded player, hides some embed ad/overlay UI with CSS.
- Preserves key controls while embedded:
  - Re-positions the watch “Settings” button into an overlay control area near fullscreen.
  - Keeps overlay controls clickable/usable.
- Playback speed sync:
  - Syncs playback speed changes from host page → embed player.
  - Syncs embed player playback speed when changed via host UI.
  - Unlocks/adds higher rates (x1.5 / x1.75 / x2.0) where possible by enabling options/items.

## Notes
- Runs on `www.nicovideo.jp/watch/*`, `nicovideo.jp/watch/*`, and `embed.nicovideo.jp/watch/*`.
- Uses DOM observation and periodic scanning to keep the embed and controls in sync.