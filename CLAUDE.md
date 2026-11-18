# Envelope 모바일 — handoff

Android app (Capacitor 8 + React + TS + zustand, same setup as Sorta 모바일) for
**Envelope** (PC, `Desktop/code/doujin_player`): the doujin voice player on a phone.
Main feature: **떠 있는 자막** — only the subtitle lines float over other apps (no
picture-in-picture). Commits: subject-only, **no Claude trailer**.

## How it works

- 라이브러리 폴더 = NAS (SMB / WebDAV, `/nas/<conn>/<path>`) or a phone folder
  (MANAGE_EXTERNAL_STORAGE, real paths). NAS code copied from Sorta 모바일
  (`Vfs` / `WebDavFs` / `SmbFs` / `DualFs` / `NasStore`), plus `openAt(rel, offset)`
  for seeking (WebDAV Range, SMB read at offset).
- A folder with Envelope's **모바일 정보 파일** `.envelope/mobile.envpack` (gzip JSON,
  `src/shared/mobilePack.ts` — **must stay identical in the Envelope repo**) is read
  from it; else scanned with Envelope's own scan ported to the plugin's readdir
  (`src/backend/envcore/` — no 뷁어 repair, no length probe). Cached as
  `<filesDir>/library-<source>.json`; packs re-read at start when their mtime changes,
  scans only on 다시 읽기.
- `backend/library.ts` builds Envelope's `WorkSummary` / `WorkDetail` (ports of
  core/library buildGroups / listWorks / workDetail). Phone-side state (즐겨찾기, 평점,
  그룹, 이어 듣기, 북마크, 싱크, SE / 판) in localStorage `env-state`
  (`backend/state.ts`); a work first seen in a pack takes the PC's state once.
- `backend/api.ts` = `window.api` with the PC app's call names, so the Envelope
  screens run almost unchanged.

## Native (`android/app/src/main/java/com/alterstare/envelope`)

- `PlaybackService` — Media3 ExoPlayer in a `MediaSessionService` (background play,
  media notification with extra buttons 떠 있는 자막 on/off + 잠금, headset keys).
  The queue = one work's main tracks (or the one extra). JS sends each item's cues
  (`playerCues`); progress is recorded natively (prefs `player`) and drained by JS
  (`playerDrain`) since the WebView may sleep. Sleep timer native (fade 10 s, pause at
  end of track / work via `setPauseAtEndOfMediaItems`).
- `NasDataSource` (+ `Routing`) — `envnas://f/nas/...` for ExoPlayer.
- `SubOverlay` — TYPE_APPLICATION_OVERLAY window, Envelope `.sub-strip` look (each
  line a dark rounded box, 600 white, translation 0.85× #e3dcff). Unlocked: vertical
  drag, tap → [작게][크게][잠금][닫기]. Locked: FLAG_NOT_TOUCHABLE + alpha 0.8 (Android
  12+ only passes touches through windows ≤ 0.8 opaque). Hidden while the app is on
  screen (setting). Needs "다른 앱 위에 표시" (`overlayPermission`).
- `EnvWebViewClient` — `https://localhost/_s/{img|th|raw}/<b64url>`.

## UI (`src/renderer/src`)

Envelope's renderer files copied (styles.css + env.css untouched, `mobile.css` after
them) — the phone is always Envelope's "small window" (Spotify mobile). Removed: LP
tabs, file tools, editor, auto subtitles, context menus, volume. 설정 = round icon at
the library head's top right. Android back: `touch.ts` stack → App `back()`; on the
library the app goes behind (`exitApp` = moveTaskToBack, playback stays).

## Build / test

```
npm run typecheck
npm run sync                       # vite build + cap sync android
cd android && JAVA_HOME=~/.jdks/jdk-21.0.12.1+1 ./gradlew.bat assembleDebug
```
Emulator (`mm_test`): `.scratch/gen.mjs` (fake library: sine wavs, vtt, solid covers)
→ `.scratch/dav.mjs` (WebDAV :8765, test/test → `http://10.0.2.2:8765/`),
`.scratch/fwd.sh` then `node .scratch/cdp.mjs "<js>"` evaluates in the WebView.
Overlay permission on the emulator: `adb shell appops set com.alterstare.envelope SYSTEM_ALERT_WINDOW allow`.

## Not done yet

- **Envelope (PC) side writing `.envelope/mobile.envpack` + `.envelope/covers/`**
  (format fixed in mobilePack.ts; until then every folder is scanned).
- App icon (`npm run icons` from `Env_icon_v2.png` — script still Sorta's), release
  signing / update notice, notification artwork check, video tracks play as audio only.
