// 모바일 정보 파일 — what Envelope (PC) leaves in a library folder for
// Envelope 모바일: `<라이브러리 폴더>/.envelope/mobile.envpack` (gzip JSON) and
// small covers in `.envelope/covers/`. The phone reads them over the NAS
// instead of scanning (names repaired / translated, durations, DLsite info,
// subtitles made in the program). IDENTICAL FILE in both repos — change both.
//
// Every path is relative to the library folder, '/'-separated. Subtitles kept
// in the program are listed as "envsub:<lang>:<track rel>" and their text is
// in `subs`.

import type { Se, SubLang, TrackRole, WorkAge, WorkContent, WorkLang, SePref } from './types'

export const PACK_DIR = '.envelope'
export const PACK_FILE = '.envelope/mobile.envpack'
export const PACK_FORMAT = 'envelope-mobile'
export const PACK_VERSION = 1

export interface PackSub {
  rel: string // file next to the audio, or "envsub:<lang>:<track rel>"
  lang: SubLang | null
}

export interface PackTrack {
  id: number // Envelope's track id (stable while the work isn't rescanned)
  rel: string
  title: string // shown name (repaired; translated when Envelope shows translations)
  ext: string // '.mp3'
  kind: 'audio' | 'video'
  role: TrackRole
  edition: string
  editionKey: string
  se: Se
  formatDir: string
  groupKey: string // equal for versions of one track
  sort: number
  duration: number | null
  bitrate: number | null
  relDir: string
  subs: PackSub[]
}

export interface PackBookmark {
  groupKey: string
  position: number
  name: string
  createdAt: number
}

export interface PackWork {
  id: number // Envelope's work id
  rel: string // work folder ("" + "|RJ…" for works split by file codes)
  code: string | null
  title: string // as Envelope shows it
  folderTitle: string
  dlTitle: string | null
  cover: string | null // .envelope/covers/<id>.jpg
  images: string[] // background pictures in the work folder
  addedAt: number
  circle: string | null
  voices: string[]
  tags: { ko: string; ja: string }[]
  content: WorkContent
  age: WorkAge
  lang: WorkLang
  mojibake: boolean
  // the PC's own state, taken over once when the phone first sees the work
  sePref: SePref | null
  edition: string | null
  favorite: boolean
  rank: number
  plays: number
  lastPlayedAt: number | null
  lastGroup: string | null
  groupIds: number[]
  progress: Record<string, { position: number; duration: number | null }>
  offsets: Record<string, number>
  bookmarks: PackBookmark[]
  tracks: PackTrack[]
}

export interface MobilePack {
  format: typeof PACK_FORMAT
  v: number
  createdAt: number
  app: string // "Envelope 0.1.2"
  groups: { id: number; name: string }[]
  works: PackWork[]
  subs: Record<string, Record<string, string>> // track rel → lang → vtt (program subtitles)
}
