import type { JSX } from 'react'
import { useStore } from '../store'
import type { TrackGroup, TrackVersion, WorkDetail } from '../../../shared/types'
import { media, play, resumeTarget, toggle } from '../player'
import { clock, length } from '../format'
import {
  GraphicEqIcon,
  HistoryIcon,
  KeyboardArrowLeftIcon,
  LibraryMusicIcon,
  PauseIcon,
  PlayArrowIcon,
  ShuffleIcon,
  SubtitlesIcon
} from './icons'
import { Confirm, Dropdown, FavButton, GroupButton, Stars, TagLine } from './ui'
import { contentLabels, trackLabel } from '../workInfo'
import { useState } from 'react'

export function versionLabel(v: TrackVersion): string {
  const se = v.se === 'on' ? 'SE 포함' : v.se === 'off' ? 'SE 제외' : ''
  const fmt = v.ext.slice(1).toUpperCase() + (v.bitrate ? ` ${v.bitrate}kbps` : '')
  return [se, fmt].filter(Boolean).join(' · ')
}


// After SE / edition changes: reload, and keep the track playing on the
// newly chosen file from the same point.
async function afterPrefs(w: WorkDetail): Promise<void> {
  const st = useStore.getState()
  await st.refreshWork(w.id)
  const n = useStore.getState().now
  if (!n || n.work.id !== w.id) return
  const g = n.work.groups.find((x) => x.key === n.groupKey)
  if (g && g.chosen !== n.trackId) void play(n.work, g.key, { versionId: g.chosen, at: media().currentTime, autoplay: !media().paused })
}

function TrackRow({
  w,
  g,
  n,
  current,
  playing
}: {
  w: WorkDetail
  g: TrackGroup
  n: number
  current: boolean
  playing: boolean
}): JSX.Element {
  const nowTrack = useStore((s) => (current ? s.now?.trackId : undefined))
  const v = g.versions.find((x) => x.id === (current ? nowTrack : g.chosen)) ?? g.versions[0]
  const pct = g.duration && g.position && !g.finished ? Math.min(100, (g.position / g.duration) * 100) : 0
  const hasSubs = g.versions.some((x) => x.subs.length)
  return (
    <div className={`trow ${current ? 'current' : ''}`} onClick={() => (current ? toggle() : void play(w, g.key))}>
      <span className="trow-n">
        <span className="n">{current && playing ? <GraphicEqIcon /> : n}</span>
        <span className="hover">{current && playing ? <PauseIcon /> : <PlayArrowIcon />}</span>
      </span>
      <span className="trow-main">
        <span className="trow-title">{g.title}</span>
        <span className="trow-sub">
          {current && g.versions.length > 1 && nowTrack !== undefined ? (
            <Dropdown<number>
              kind="inline"
              value={nowTrack}
              title="이 트랙의 파일"
              options={g.versions.map((x) => [x.id, `${versionLabel(x)}${x.relDir ? ` · ${x.relDir}` : ''}`] as const)}
              onChange={(id) => void play(w, g.key, { versionId: id, at: media().currentTime, autoplay: !media().paused })}
            />
          ) : (
            versionLabel(v)
          )}
          {hasSubs && <SubtitlesIcon className="trow-submark" />}
        </span>
        {pct > 0 && (
          <span className="trow-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      <span className="trow-icon">{hasSubs && <SubtitlesIcon />}</span>
      <span className="trow-time">{clock(g.duration)}</span>
    </div>
  )
}

function Section({ w, title, groups }: { w: WorkDetail; title?: string; groups: TrackGroup[] }): JSX.Element | null {
  const now = useStore((s) => s.now)
  const playing = useStore((s) => s.playing)
  if (!groups.length) return null
  return (
    <>
      {title && <h3 className="tsection">{title}</h3>}
      {groups.map((g, i) => (
        <TrackRow key={g.key} w={w} g={g} n={i + 1} current={now?.work.id === w.id && now.groupKey === g.key} playing={playing} />
      ))}
    </>
  )
}

// Spotify's album page on mobile — centred cover, title, people, meta; ♥ ·
// 그룹 · 평점 left and shuffle + the big play right; then SE / 판 and the
// track list.
export default function WorkPage(): JSX.Element | null {
  const w = useStore((s) => s.shown)
  const works = useStore((s) => s.works)
  const now = useStore((s) => s.now)
  const playing = useStore((s) => s.playing)
  const settings = useStore((s) => s.settings)
  const resumeOk = useStore((s) => s.settings?.resume ?? true)
  const [reset, setReset] = useState(false)
  if (!w) return null
  const sum = works.find((x) => x.id === w.id)
  const fav = sum?.favorite ?? w.favorite
  const rank = sum?.rank ?? w.rank
  const groupIds = sum?.groupIds ?? w.groupIds
  const main = w.groups.filter((g) => g.role === 'main')
  const total = main.reduce((n, g) => n + (g.duration ?? 0), 0)
  const here = now?.work.id === w.id
  const target = resumeTarget(w)
  const resumable = resumeOk && !!target && target.position > 3 && !target.finished
  const coverUrl = w.cover ? window.api.thumbUrl(w.cover) : null

  const top = (
    <div className="wp-top">
      <div className="flat-group">
        <button className="mini icon" title="뒤로" onClick={() => void useStore.getState().navBack()}>
          <KeyboardArrowLeftIcon />
        </button>
      </div>
      <div className="flat-group">
        <button className="mini icon" title="듣기 기록을 지우고 처음부터" onClick={() => setReset(true)}>
          <HistoryIcon />
        </button>
      </div>
    </div>
  )
  const playBtn = (
    <button
      className="btn primary play-main"
      title={here ? (playing ? '일시정지' : '계속 재생') : resumable ? '이어 듣기' : '재생'}
      onClick={() => (here ? toggle() : target && void play(w, target.key))}
    >
      {here && playing ? <PauseIcon /> : <PlayArrowIcon />}
    </button>
  )
  const shuffle = (
    <div className="flat-group">
      <button
        className={`mini icon ${settings?.shuffle ? 'on' : ''}`}
        title="무작위 재생"
        onClick={() => void useStore.getState().saveSettings({ shuffle: !settings?.shuffle })}
      >
        <ShuffleIcon />
      </button>
    </div>
  )
  const resume = (
    <div className="mw-resume hint">
      {here
        ? `${playing ? '재생 중' : '일시정지'} · ${trackLabel(w, now!.groupKey)}`
        : target && (resumable ? `이어 듣기 · ${trackLabel(w, target.key)} ${clock(target.position)}부터` : `재생 · ${trackLabel(w, target.key)}부터`)}
    </div>
  )
  const kind = [w.code, ...contentLabels(w.content)].filter(Boolean).join(' · ')
  const prefs = (
    <>
      {w.hasSeChoice && (
        <div className="flat-group">
          {(['on', 'off'] as const).map((se) => (
            <button
              key={se}
              className={`mini ${w.sePref === se ? 'on' : ''}`}
              onClick={async () => {
                await window.api.setWorkPrefs(w.id, { sePref: se })
                await afterPrefs(w)
              }}
            >
              {se === 'on' ? 'SE 포함' : 'SE 제외'}
            </button>
          ))}
        </div>
      )}
      {w.editions.length > 0 && (
        <Dropdown<string>
          kind="mini"
          title="판"
          value={w.edition}
          options={w.editions.map((e) => [e.key, e.label] as const)}
          onChange={async (v) => {
            await window.api.setWorkPrefs(w.id, { edition: v })
            await afterPrefs(w)
          }}
        />
      )}
    </>
  )
  return (
    <div className="workpage mwork">
      {coverUrl && <div className="mw-bg" style={{ backgroundImage: `url("${coverUrl}")` }} />}
      {top}
      <div className="mw-cover">{coverUrl ? <img src={coverUrl} alt="" draggable={false} /> : <div className="cover-box-ph"><LibraryMusicIcon /></div>}</div>
      <h1 className="mw-title selectable">{w.title}</h1>
      {(w.circle || w.voices.length > 0) && (
        <div className="mw-people">
          {w.circle && <b>{w.circle}</b>}
          {w.circle && w.voices.length > 0 && ' · '}
          {w.voices.length > 0 && <b>{w.voices.join(', ')}</b>}
        </div>
      )}
      <div className="mw-meta">{[kind, length(total)].filter(Boolean).join(' · ')}</div>
      <TagLine tags={w.tags} className="mw-tags" all />
      <div className="mw-actions">
        <div className="mw-collect">
          <Stars id={w.id} rank={rank} />
          <div className="flat-group">
            <GroupButton id={w.id} groupIds={groupIds} />
            <FavButton id={w.id} on={fav} />
          </div>
        </div>
        <span className="grow" />
        {shuffle}
        {playBtn}
      </div>
      {target && resume}
      {(w.hasSeChoice || w.editions.length > 0) && <div className="mw-prefs">{prefs}</div>}
      <div className="mw-count">
        <hr />
        <span>총 {main.length}트랙</span>
      </div>
      <div className="ttable">
        <Section w={w} groups={main} />
        <Section w={w} title="부록" groups={w.groups.filter((g) => g.role === 'extra')} />
        <Section w={w} title="샘플" groups={w.groups.filter((g) => g.role === 'sample')} />
      </div>
      {reset && (
        <Confirm
          danger
          title="듣기 기록을 지울까요?"
          body="이 작품의 이어 듣기 위치와 다 들은 표시를 지우고 처음부터 듣습니다. 즐겨찾기 · 평점 · 북마크는 그대로입니다."
          ok="지우기"
          onCancel={() => setReset(false)}
          onOk={async () => {
            setReset(false)
            await window.api.resetProgress(w.id)
            await useStore.getState().refreshWork(w.id)
            void useStore.getState().loadWorks()
          }}
        />
      )}
    </div>
  )
}
