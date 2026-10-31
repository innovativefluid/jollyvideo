# Changelog

## 0.6.0

- The time bar's preview shows a small picture of the video at that time, from YouTube's storyboards (fetched through the server like the thumbnails).

## 0.5.0

- The time bar shows the time (and chapter) under the mouse, and where a drag goes; it seeks when let go. It is easier to hit.
- YouTube chapters: marks on the time bar, and the chapter playing under the title.

## 0.4.0

- Captions: the Captions button in the panel shows the video's captions under the controls, for you alone, in the language you pick. The uploader's captions come first, then YouTube's automatic ones in the video's language.

## 0.3.2

- The stream shows the video's title and thumbnail again, in private voice channels too.

## 0.3.1

A performance and security pass.

- About a quarter less CPU per video, and YouTube's Opus sound is passed through instead of encoded again.
- One YouTube lookup per video instead of three; only the next few queued videos are looked up ahead.
- The next video downloads once the one playing is in, and reordering the queue no longer starts and stops downloads.
- Stopped downloads no longer leave 80 MB behind in the temp folder each time.
- Installing ffmpeg needs about 20 MB of memory instead of 400 MB.
- One channel's lookups no longer hold up the others'.
- Long searches can no longer stop the panel updating for everyone in the channel.
- In private voice channels, the stream in the channel list no longer shows the video's title to the whole server.
- Someone a moderator disconnected can no longer control the player.
- Videos of unknown length are refused while there is a length limit.
- yt-dlp sees only the environment it needs, and prefers Deno or Node for YouTube's JavaScript.
- ffmpeg opens only local files and livestream playlists, in YouTube's formats.
- Releases are built in a job of their own, with pinned actions and build provenance.

## 0.3.0

- Videos start playing while they download, after about 20 seconds are in.
- YouTube playlist links add their videos to the queue.
- Drag queued videos into a new order, or move them with the arrow keys; clear the queue.
- German and Polish, following the browser's language.
- Downloads check the server's free disk space first.
- Tested end to end in a real Sharkord.

## 0.2.0

- Rewritten from scratch, now MIT licensed.
- A smaller panel in Sharkord's own style, opened from the voice controls.
- One ffmpeg per video for picture and sound, so they stay in sync.
- Thumbnails come through the server; browsers never contact YouTube.
- Settings cut down to quality, length limit, videos at once and yt-dlp updates.
