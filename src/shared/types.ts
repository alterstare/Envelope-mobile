// Types shared by the backend and the screens (from Envelope src/shared/types.ts,
// trimmed to what the phone uses).

export type SePref = 'on' | 'off'
export type FormatPref = 'lossless' | 'mp3' // wav/flac first, or mp3 first
export type Repeat = 'off' | 'all' | 'one'
export type LibSort = 'recent' | 'title' | 'added' | 'code' | 'length' | 'rank' | 'plays' | 'random'
export type SubMode = 'both' | 'original' | 'translation' | 'off'

// A library folder on the phone: "/nas/<conn>/<path>" or a phone path.
export interface LibrarySource {
  id: string
  path: string
}

// Envelope 모바일's settings (the PC app's, minus what a phone has no use for).
export interface Settings {
  sources: LibrarySource[] // 라이브러리 폴더
  sePref: SePref // default version to play (per work it can be changed)
  formatPref: FormatPref
  seekStep: number // seconds for ±
  volume: number // 0–1 (the phone's own volume keys do the rest)
  rate: number // playback speed
  repeat: Repeat
  shuffle: boolean
  libSort: LibSort
  libDir: 'asc' | 'desc'
  libLayout: 'grid' | 'list'
  subMode: SubMode // which subtitle lines to show
  subSize: number // subtitle font size (px)
  subsVisible: boolean // subtitles over the picture in 지금 재생
  lyricsPanel: boolean
  resume: boolean // 이어 듣기: start where it was left
  theme: 'light' | 'dark'
  pageSize: number // works per library page
  overlaySize: number // 떠 있는 자막: text size (sp)
  overlayOpacity: number // 떠 있는 자막: background 0.3–1
  overlayHideInApp: boolean // 떠 있는 자막: hidden while Envelope itself is on screen
}

export interface ProgressEvent {
  jobId: number
  label: string // what it is doing now
  title?: string // the job itself (label when it was added)
  startedAt?: number // screen side: when it was first seen
  done: number
  total: number // 0 = indeterminate
  unit?: 'bytes' // done/total are bytes (shown as MB)
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
  background?: boolean // never blocks other actions; yields to any other job
  paused?: boolean // queued while the queue is paused (모두 일시정지)
}

export interface AppInfo {
  version: string
  embedded: boolean // running inside Halftone (no own updater / window chrome)
  dataDir: string
  dbPath: string
  schemaVersion: number
}

export interface UndoResult {
  ok: boolean
  label: string | null // what was undone; null = nothing left
}

// ---- library ----

export type Se = 'on' | 'off' | 'unknown'
// ja = Japanese original, ko-sub = Korean subtitled release, ko-voice = Korean voice
export type WorkLang = 'ja' | 'ko-sub' | 'ko-voice'

// What a work has to read along (언어 분류): scripts and subtitles by
// language (ISO 639-1: ja, ko, en, zh …, whatever the folder holds), and the
// voice's language. A subtitle language is 'app' when only Envelope made it
// ([자체 생성]).
export interface WorkContent {
  scripts: string[]
  subs: Record<string, 'user' | 'app' | undefined>
  voice: string
}
export type WorkAge = 'r18' | 'general' | null // DLsite (null: not known)

export interface Cue {
  start: number // seconds
  end: number
  text: string // may contain line breaks
  low?: boolean // script alignment wasn't sure of this line's timing (vtt cue id "low")
}
export type SubLang = 'ja' | 'ko' | 'other'
export interface SubFile {
  path: string
  lang: SubLang | null // from the file name; null = tell from the text
}
export type TrackRole = 'main' | 'extra' | 'sample'

export interface WorkSummary {
  id: number
  path: string
  code: string | null // RJ01234567
  title: string // repaired
  cover: string | null
  tracks: number // main tracks of the shown edition
  duration: number | null // seconds, sum of those tracks
  played: number // tracks started
  finished: number // tracks heard to the end
  addedAt: number
  lastPlayedAt: number | null
  mojibake: boolean // some names in it were 뷁어 (shown repaired)
  favorite: boolean
  rank: number // 0–5 stars (평점)
  plays: number // 감상 횟수: playback of the work started
  groupIds: number[] // 그룹
  lang: WorkLang
  subtitled: number // main tracks with a subtitle file
  folderTitle: string // from the folder name (title may be DLsite's)
  circle: string | null // DLsite
  voices: string[] // DLsite
  tags: { ko: string; ja: string }[] // DLsite 장르 (shown in Korean, searched in both)
  content: WorkContent
  age: WorkAge
  dlFetched: boolean // DLsite was asked (found or not)
  // the folder's cover and DLsite's, and the work's own choice (null = the setting)
  covers: { folder: string | null; dlsite: string | null; pref: 'folder' | 'dlsite' | null }
}

export interface Group {
  id: number
  name: string
  count: number
}

// One file of a track (SE on/off × format folder).
export interface TrackVersion {
  id: number
  path: string
  title: string
  ext: string // '.mp3'
  kind: 'audio' | 'video'
  se: Se
  formatDir: string // folder it sits in by format ("wav"), '' if none
  relDir: string // folder inside the work
  bitrate: number | null
  duration: number | null
  subs: SubFile[]
}

export interface TrackGroup {
  key: string
  title: string // of the chosen version
  role: TrackRole
  versions: TrackVersion[]
  chosen: number // TrackVersion id to play by default
  position: number // resume point (s)
  duration: number | null
  finished: boolean
  subOffset: number // s, added to subtitle times
  originalTitle?: string // when a translated name is shown
}

export interface Edition {
  key: string
  label: string
}

export interface WorkDetail {
  id: number
  path: string
  code: string | null
  title: string
  cover: string | null
  images: string[] // background order
  editions: Edition[] // empty: only one
  edition: string // chosen edition key
  sePref: SePref
  hasSeChoice: boolean // some track has both SE versions
  groups: TrackGroup[] // main tracks of the edition, then 덤, then 샘플
  lastGroup: string | null
  mojibake: boolean
  favorite: boolean
  rank: number
  groupIds: number[]
  lang: WorkLang
  folderTitle: string
  dlTitle: string | null
  circle: string | null
  tags: { ko: string; ja: string }[] // DLsite 장르
  content: WorkContent
  age: WorkAge
  voices: string[]
  bookmarks: Bookmark[] // in track order, then time
}

export interface Bookmark {
  id: number
  workId: number
  groupKey: string
  position: number // s
  name: string
  createdAt: number
}

export interface SubtitleText {
  path: string
  lang: SubLang
  cues: Cue[]
  envMade: boolean // written by Env (may be updated without asking)
}
