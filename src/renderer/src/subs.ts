// Subtitles for the track playing: which files belong to it, which one is the
// Japanese original and which the Korean translation, and the line to show.
// On the phone each queue item's lines also go to the player service, which
// draws the 떠 있는 자막 window from them.
import { useStore } from './store'
import type { Subs } from './store'
import type { Cue, SubFile, SubtitleText, TrackGroup, WorkDetail } from '../../shared/types'
import { native } from '../../backend/native'
import type { CueArrays } from '../../backend/native'
import { queueIndex } from './player'

// Own files first; a version without any borrows from its siblings (SE 포함 /
// 제외 share timing).
export function subFilesOf(g: TrackGroup, trackId: number): { files: SubFile[]; borrowed: boolean } {
  const own = g.versions.find((v) => v.id === trackId)?.subs ?? []
  if (own.length) return { files: own, borrowed: false }
  const seen = new Set<string>()
  const files = g.versions.flatMap((v) => v.subs).filter((s) => !seen.has(s.path) && seen.add(s.path))
  return { files, borrowed: files.length > 0 }
}

// Read texts are kept while the app runs (the queue asks for each track once
// for the service and again when it becomes the track on screen).
const cache = new Map<string, Promise<SubtitleText | null>>()
function read(path: string): Promise<SubtitleText | null> {
  let p = cache.get(path)
  if (!p) {
    p = window.api.readSubtitle(path).catch(() => null)
    cache.set(path, p)
  }
  return p
}

async function subsOf(g: TrackGroup, trackId: number): Promise<Subs> {
  const { files, borrowed } = subFilesOf(g, trackId)
  const texts = (await Promise.all(files.map((f) => read(f.path)))).filter((t): t is SubtitleText => !!t)
  const first = (lang: string): SubtitleText | null => texts.find((t) => t.lang === lang && t.cues.length) ?? null
  return { trackId, ja: first('ja'), ko: first('ko'), other: first('other'), borrowed }
}

let loading = 0

export async function loadSubs(work: WorkDetail, groupKey: string, trackId: number): Promise<void> {
  const g = work.groups.find((x) => x.key === groupKey)
  const ticket = ++loading
  if (!g) return useStore.setState({ subs: null })
  const subs = await subsOf(g, trackId)
  if (ticket !== loading) return // another track started meanwhile
  useStore.setState({ subs })
}

const arrays = (s: SubtitleText | null): CueArrays | null =>
  s ? { s: s.cues.map((c) => c.start), e: s.cues.map((c) => c.end), t: s.cues.map((c) => c.text) } : null

// One queue item's original / translation → the service.
export async function pushCues(index: number, _work: WorkDetail, g: TrackGroup, trackId: number): Promise<void> {
  const subs = await subsOf(g, trackId)
  await native.playerCues({ index, orig: arrays(subs.ja ?? subs.other), trans: arrays(subs.ko), offset: g.subOffset })
}

// Index of the cue on screen at time t (after the offset), or -1.
export function cueAt(cues: Cue[], t: number): number {
  let lo = 0
  let hi = cues.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 && t < cues[found].end ? found : -1
}

// The lines the overlay shows for the current mode: [original, translation].
export function linesFor(subs: Subs | null, mode: string): { main: SubtitleText | null; second: SubtitleText | null } {
  if (!subs || mode === 'off') return { main: null, second: null }
  const orig = subs.ja ?? subs.other
  const trans = subs.ko
  if (mode === 'original') return { main: orig ?? trans, second: null }
  if (mode === 'translation') return { main: trans ?? orig, second: null }
  return orig && trans ? { main: orig, second: trans } : { main: orig ?? trans, second: null }
}

// 자막 싱크: set (or nudge) the offset of the track playing. Saved per track;
// the subtitle file is not touched.
export function setSubOffset(value: number): void {
  const st = useStore.getState()
  const n = st.now
  if (!n) return
  const v = Math.round(value * 10) / 10
  void window.api.setSubOffset(n.work.id, n.groupKey, v)
  void native.playerOffset({ index: queueIndex(n.groupKey), offset: v })
  const patch = (w: WorkDetail): WorkDetail => ({ ...w, groups: w.groups.map((x) => (x.key === n.groupKey ? { ...x, subOffset: v } : x)) })
  useStore.setState({ now: { ...n, work: patch(n.work) }, shown: st.shown?.id === n.work.id ? patch(st.shown) : st.shown })
}

export function nudgeSubOffset(delta: number): void {
  const n = useStore.getState().now
  const g = n?.work.groups.find((x) => x.key === n.groupKey)
  if (g) setSubOffset(g.subOffset + delta)
}
