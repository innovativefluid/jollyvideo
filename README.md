# Jollyvideo

Watch YouTube videos and livestreams together in Sharkord voice channels.

## Install

Install `jollyvideo-<version>.tar.gz` from the releases with Sharkord's plugin installer, or unpack `jollyvideo-<version>.zip` into the server's plugins folder. Then enable the plugin.

On first start the server downloads yt-dlp and ffmpeg into the plugin's data folder and checks them against their SHA-256. A copy on `PATH`, or one set with `JOLLYVIDEO_YT_DLP` / `JOLLYVIDEO_FFMPEG`, is used instead.

## Use

Join a voice channel, click the popcorn button next to the camera button, and paste a YouTube link or type a search.

Moderators (anyone with *Move members*) can lock the player. While it is locked, only they can add or control videos.

Commands: `/watch`, `/watch-skip`, `/watch-stop`, `/watch-lock`, `/watch-update`.

## Settings

- **Video quality**: 480p to 1080p, 30 or 60 fps. Each playing video keeps about one CPU core busy.
- **Longest video**: in minutes, 0 for no limit.
- **Videos at once**: across all voice channels.
- **Update yt-dlp weekly**

If YouTube asks the server to sign in, put a `cookies.txt` into the plugin's `bin` data folder.

## Development

```sh
bun install
bun run sharkord       # Sharkord's source: for the class check and the preview
bun run check
bun run test
bun run test:media     # needs ffmpeg (JOLLYVIDEO_FFMPEG or PATH), and yt-dlp for its part
bun run build          # dist/
bun run test:package
bun run preview        # the panel in Sharkord's styles, without a server
```

The client may only use classes that Sharkord's stylesheet has. They all live in `src/client/classes.ts`, and `bun run check` checks them against Sharkord's source.

Push a tag such as `v0.2.0` to publish a release.

## License

MIT
