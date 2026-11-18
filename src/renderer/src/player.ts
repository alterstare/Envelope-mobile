// Playback: the phone's player is native (PlaybackService — ExoPlayer in a
// media session, so it plays on in the background and the 떠 있는 자막 window
// can follow it). This file keeps Envelope's player API for the screens: the
// queue is the work's main tracks (or the one extra / sample), the service
// reports position / track changes back, progress is saved per track.
import { useStore } from './store'
import { loadSubs, pushCues } from './subs'
import type { TrackGroup, TrackVersion, WorkDetail } from '../../shared/types'
import { native } from '../../backend/native'
import type { PlayerState } from '../../backend/native'

const SAVE_EVERY_MS = 5000
const RESUME_MIN = 3 // s: earlier positions start from the top
const DONE = 1e300 // the service's "heard to the end"

const st = useStore.getState
const set = useStore.setState

// What the service holds: one entry per queue item.
interface Entry {
  groupKey: string
  trackId: number
}
let queue: Entry[] = []
let lastSave = 0

const keyOf = (workId: number, groupKey: string): string => `${workId}:${groupKey}`
function parseKey(k: string): { workId: number; groupKey: string } {
  const i = k.indexOf(':')
  return { workId: Number(k.slice(0, i)), groupKey: k.slice(i + 1) }
}

// The screens read "the media element" for the position (bookmarks, ±N초).
export const media = (): { currentTime: number; paused: boolean; duration: number; volume: number } => ({
  currentTime: st().time,
  paused: !st().playing,
  duration: st().duration,
  volume: 1
})

// Video tracks (특전 영상) play as sound only on the phone.
export function attachVideo(_v: HTMLVideoElement | null): void {}

function groupOf(w: WorkDetail, key: string): TrackGroup | undefined {
  return w.groups.find((g) => g.key === key)
}

function versionOf(g: TrackGroup, id?: number): TrackVersion {
  return g.versions.find((v) => v.id === (id ?? g.chosen)) ?? g.versions[0]
}

// Start a track of a work (its chosen version unless `versionId`), resuming
// where it was left; `at` overrides the start point.
export async function play(work: WorkDetail, groupKey: string, opts: { versionId?: number; at?: number; autoplay?: boolean } = {}): Promise<void> {
  const g = groupOf(work, groupKey)
  if (!g) return
  save()
  const list = g.role === 'main' ? work.groups.filter((x) => x.role === 'main') : [g]
  queue = list.map((x) => ({ groupKey: x.key, trackId: x.key === groupKey ? versionOf(x, opts.versionId).id : x.chosen }))
  const index = list.indexOf(g)
  const v = versionOf(g, opts.versionId)
  const start = opts.at ?? (resumeOn() && g.position > RESUME_MIN && !g.finished ? g.position : 0)
  set({ now: { work, groupKey, trackId: v.id }, time: start, duration: v.duration ?? g.duration ?? 0, subs: null, imgIndex: 0 })
  await native.playerLoad({
    items: list.map((x, i) => {
      const xv = x.versions.find((y) => y.id === queue[i].trackId) ?? x.versions[0]
      return { key: keyOf(work.id, x.key), path: xv.path, title: x.title, artist: work.title, album: work.code ?? '' }
    }),
    index,
    start,
    play: opts.autoplay !== false,
    cover: work.cover ?? ''
  })
  applyModes()
  void loadSubs(work, groupKey, v.id)
  // every track's subtitles go to the service (the overlay follows it in the background)
  void (async () => {
    for (let i = 0; i < list.length; i++) {
      if (st().now?.work.id !== work.id) return
      await pushCues(i, work, list[i], queue[i].trackId)
    }
  })()
  if (opts.autoplay !== false) countPlay()
}

// 감상 횟수 (Halftone viewCount): +1 when a work starts playing; the next
// tracks of the same work don't count again — only after another work played
let counted: number | null = null
function countPlay(): void {
  const id = st().now?.work.id
  if (id === undefined || id === counted) return
  counted = id
  void window.api.countPlay(id).then((n) => st().patchWork(id, { plays: n }))
}

// 설정 › 재생 › 이어 듣기 (off: every track from the top, every work from its first track)
export const resumeOn = (): boolean => st().settings?.resume ?? true

// Where "play" on a work starts: the last track if it wasn't heard to the end,
// else the next main track after it (wrapping to the first).
export function resumeTarget(w: WorkDetail): TrackGroup | undefined {
  if (!resumeOn()) return w.groups.find((g) => g.role === 'main') ?? w.groups[0]
  const last = w.lastGroup ? groupOf(w, w.lastGroup) : undefined
  if (last && !last.finished) return last
  const main = w.groups.filter((g) => g.role === 'main')
  if (!last) return main[0] ?? w.groups[0]
  const i = main.findIndex((g) => g.key === last.key)
  return main[i + 1] ?? main[0] ?? w.groups[0]
}

export async function playWork(id: number): Promise<void> {
  const w = await window.api.work(id)
  const g = w && resumeTarget(w)
  if (w && g) await play(w, g.key)
}

export function toggle(): void {
  if (!st().now) {
    const w = st().shown
    const g = w && resumeTarget(w)
    if (w && g) void play(w, g.key)
    return
  }
  const playing = st().playing
  set({ playing: !playing }) // at once; the service confirms
  void native.playerControl({ op: playing ? 'pause' : 'play' })
  if (!playing) countPlay()
}

// End playback altogether: nothing loaded, the mini player disappears.
export function stop(): void {
  if (!st().now) return
  save()
  queue = []
  void native.playerControl({ op: 'stop' })
  set({ now: null, playing: false, time: 0, duration: 0, subs: null, sleep: { ...st().sleep, mode: 'off', endsAt: null } })
}

export function seek(t: number): void {
  if (!st().now) return
  const d = st().duration
  const v = Math.max(0, d ? Math.min(t, d) : t)
  set({ time: v })
  void native.playerControl({ op: 'seek', value: v })
}

export const skip = (d: number): void => seek(st().time + d)

export function next(): void {
  void native.playerControl({ op: 'next' })
}

export function prev(): void {
  void native.playerControl({ op: 'prev' })
}

export function setVolume(v: number): void {
  const cur = st().settings
  if (cur) set({ settings: { ...cur, volume: v } })
}

export function setRate(r: number): void {
  void native.playerControl({ op: 'rate', value: r })
  void st().saveSettings({ rate: r })
}

export function setSleep(mode: 'off' | 'time' | 'track' | 'work', minutes?: number): void {
  const m = minutes ?? st().sleep.minutes
  set({ sleep: { mode, minutes: m, endsAt: mode === 'time' ? Date.now() + m * 60_000 : null } })
  void native.playerSleep({ mode, minutes: m })
}

// 반복 · 무작위 · 속도 · 자막 표시 → the service
function applyModes(): void {
  const s = st().settings
  if (!s) return
  void native.playerControl({ op: 'repeat', value: s.repeat === 'all' ? 1 : s.repeat === 'one' ? 2 : 0 })
  void native.playerControl({ op: 'shuffle', value: s.shuffle ? 1 : 0 })
  void native.playerControl({ op: 'rate', value: s.rate })
  void native.playerSubMode({ mode: s.subMode })
}
useStore.subscribe((s, p) => {
  const a = s.settings
  const b = p.settings
  if (!a || !b || !s.now) return
  if (a.repeat !== b.repeat || a.shuffle !== b.shuffle || a.subMode !== b.subMode) applyModes()
})

// ---- progress ----

function patchShown(groupKey: string, position: number, d: number | undefined): void {
  const n = st().now
  if (!n) return
  const patch = (w: WorkDetail): WorkDetail => ({
    ...w,
    lastGroup: groupKey,
    groups: w.groups.map((g) => (g.key === groupKey ? { ...g, position, duration: g.duration ?? d ?? null, finished: !!(d ?? g.duration) && position >= (d ?? g.duration ?? 0) - 10 } : g))
  })
  const shown = st().shown
  set({ now: { ...n, work: patch(n.work) }, shown: shown && shown.id === n.work.id ? patch(shown) : shown })
}

function save(final?: number): void {
  const n = st().now
  if (!n) return
  const d = st().duration || undefined
  const position = final ?? st().time
  lastSave = Date.now()
  void window.api.saveProgress({ workId: n.work.id, groupKey: n.groupKey, position, duration: d })
  patchShown(n.groupKey, position, d)
}

// Progress the service kept while the app slept (and the ends of tracks).
export async function drain(): Promise<void> {
  const { progress } = await native.playerDrain().catch(() => ({ progress: {} as Record<string, { p: number; d: number; t: number }> }))
  let changed = false
  for (const [k, v] of Object.entries(progress)) {
    const { workId, groupKey } = parseKey(k)
    if (!isFinite(workId)) continue
    const d = v.d > 0 ? v.d : undefined
    const position = v.p >= DONE ? (d ?? Number.MAX_SAFE_INTEGER) : v.p
    await window.api.saveProgress({ workId, groupKey, position, duration: d, at: v.t })
    changed = true
  }
  if (changed) {
    const s = st()
    void s.loadWorks()
    if (s.shown) void s.refreshWork(s.shown.id)
    if (s.now && s.now.work.id !== s.shown?.id) void s.refreshWork(s.now.work.id)
  }
}

// The service's reports: position, playing, the track it moved to.
export function onPlayerState(p: PlayerState): void {
  const n = st().now
  if (!n || p.index < 0) {
    if (n && p.index < 0 && !p.playing) set({ playing: false })
    return
  }
  const e = queue[p.index]
  if (!e) return
  if (e.groupKey !== n.groupKey) {
    // moved on by itself (end of track) or by the notification's buttons
    set({ now: { ...n, groupKey: e.groupKey, trackId: e.trackId }, imgIndex: 0 })
    void loadSubs(n.work, e.groupKey, e.trackId)
  }
  const wasPlaying = st().playing
  set({ time: p.position, duration: p.duration || st().duration, playing: p.playing })
  if ((wasPlaying && !p.playing) || (p.playing && Date.now() - lastSave > SAVE_EVERY_MS)) save()
}

// App started again while the service still holds a queue (Android closed
// the screen, or the app was reopened): show what it plays.
export async function restore(): Promise<void> {
  const p = await native.playerState().catch(() => null)
  if (!p || !p.keys.length || p.index < 0) return
  const { workId } = parseKey(p.keys[0])
  const w = await window.api.work(workId)
  if (!w) return
  queue = p.keys.map((k) => {
    const g = groupOf(w, parseKey(k).groupKey)
    return { groupKey: parseKey(k).groupKey, trackId: g?.chosen ?? 0 }
  })
  const e = queue[p.index]
  if (!e) return
  counted = w.id
  set({ now: { work: w, groupKey: e.groupKey, trackId: e.trackId }, time: p.position, duration: p.duration, playing: p.playing })
  void loadSubs(w, e.groupKey, e.trackId)
  queue.forEach((q, i) => {
    const g = groupOf(w, q.groupKey)
    if (g) void pushCues(i, w, g, q.trackId)
  })
}

export const queueIndex = (groupKey: string): number => queue.findIndex((q) => q.groupKey === groupKey)
