// 설정 (phone): library folders (NAS / phone), NAS connections, 떠 있는 자막,
// then Envelope's 재생 · 자막 · 그룹 · 화면 rows. Changes apply at once.
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import type { Settings, SubMode } from '../../../shared/types'
import type { NasConn } from '../../../backend/native'
import { native, nasParts, nasPath } from '../../../backend/native'
import { shownPath } from '../../../backend/api'
import { useBack } from '../touch'
import { AddIcon, CheckIcon, CloseIcon, DeleteIcon, DnsIcon, EditIcon, FolderIcon, KeyboardArrowLeftIcon, MobileIcon, RefreshIcon } from './icons'
import { Confirm, Stepper } from './ui'

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="set-row">
      <div>
        <div className="set-label">{label}</div>
        {hint && <div className="hint set-hint">{hint}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  )
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T | undefined; options: [T, string][]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="flat-group">
      {options.map(([v, label]) => (
        <button key={String(v)} className={`mini ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

// Bottom sheet (the phone's dialog for forms / pickers): slides up over a dim backdrop.
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): JSX.Element {
  useBack(true, onClose)
  return createPortal(
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>{title}</span>
          <button className="mini icon" title="닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}

function Groups(): JSX.Element {
  const groups = useStore((s) => s.groups)
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [del, setDel] = useState<number | null>(null)
  const st = useStore.getState
  const reload = async (): Promise<void> => {
    await st().loadGroups()
    await st().loadWorks()
  }
  const rename = async (id: number): Promise<void> => {
    await window.api.renameGroup(id, name)
    setEditing(null)
    await reload()
  }
  return (
    <div className="dirs">
      {!groups.length && <div className="hint">아직 그룹이 없습니다. 작품의 그룹 버튼에서 만들 수 있습니다.</div>}
      {groups.map((g) => (
        <div key={g.id} className="dir">
          {editing === g.id ? (
            <>
              <input className="field grow" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void rename(g.id)} />
              <button className="mini icon" title="이름 저장" onClick={() => void rename(g.id)}>
                <CheckIcon />
              </button>
              <button className="mini icon" title="취소" onClick={() => setEditing(null)}>
                <CloseIcon />
              </button>
            </>
          ) : (
            <>
              <span>
                {g.name} <span className="hint">작품 {g.count}</span>
              </span>
              <button className="mini icon" title="이름 바꾸기" onClick={() => (setEditing(g.id), setName(g.name))}>
                <EditIcon />
              </button>
              <button className="mini icon" title="그룹 삭제 (작품은 그대로)" onClick={() => setDel(g.id)}>
                <DeleteIcon />
              </button>
            </>
          )}
        </div>
      ))}
      {del !== null && (
        <Confirm
          danger
          title="그룹을 삭제할까요?"
          body="작품과 파일은 그대로이고 그룹 표시만 사라집니다."
          ok="삭제"
          onCancel={() => setDel(null)}
          onOk={async () => {
            await window.api.deleteGroup(del)
            setDel(null)
            await reload()
          }}
        />
      )}
    </div>
  )
}

// NAS connection: SMB and / or WebDAV (Sorta / Halftone 모바일's sheet).
function ConnSheet({ conn, onClose, onSaved, onRemoved }: { conn: Partial<NasConn>; onClose: () => void; onSaved: (id: string) => void; onRemoved: () => void }): JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const [c, setC] = useState<Partial<NasConn>>(conn)
  const [tab, setTab] = useState<'smb' | 'webdav'>(conn.url && !conn.host ? 'webdav' : 'smb')
  const [pw, setPw] = useState('')
  const [smbPw, setSmbPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState<string | null>(null)
  const clear = (): void => (setOk(null), setErr(null))
  const set = (patch: Partial<NasConn>): void => (setC((x) => ({ ...x, ...patch })), clear())
  // typed → that; else the stored one (undefined) for a saved connection
  const pwOf = (typed: string, has?: boolean): string | undefined => typed || (c.id && has ? undefined : '')
  const filled = { smb: !!c.host?.trim(), webdav: !!c.url?.trim() }
  const test = async (): Promise<boolean> => {
    setBusy(true)
    setErr(null)
    try {
      const n = await window.api.nasTest(c, tab, { password: pwOf(pw, conn.hasPassword), smbPassword: pwOf(smbPw, conn.hasSmbPassword) })
      setOk(`${tab === 'smb' ? 'SMB' : 'WebDAV'} 연결 성공 · 폴더 ${n}개`)
      return true
    } catch (e) {
      setOk(null)
      setErr(`${tab === 'smb' ? 'SMB' : 'WebDAV'} 연결 실패: ${String((e as Error).message ?? e)}`)
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={conn.id ? 'NAS 연결 수정' : 'NAS 연결'} onClose={onClose}>
      <div className="flat-group conn-tabs">
        {(['smb', 'webdav'] as const).map((t) => (
          <button key={t} className={`mini ${tab === t ? 'on' : ''}`} onClick={() => (setTab(t), clear())}>
            {t === 'smb' ? 'SMB' : 'WebDAV'}
            {filled[t] && tab !== t && <CheckIcon />}
          </button>
        ))}
      </div>
      <div className="hint sheet-note">둘 다 넣어 두면 SMB가 되는 곳(집 네트워크)에서는 SMB로, 아니면 WebDAV로 연결합니다.</div>
      <label className="sfield">
        <span>이름</span>
        <input className="field" value={c.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {tab === 'smb' ? (
        <>
          <label className="sfield">
            <span>주소</span>
            <input className="field" value={c.host ?? ''} placeholder="192.168.0.10" inputMode="url" autoCapitalize="off" onChange={(e) => set({ host: e.target.value.trim() })} />
          </label>
          <label className="sfield">
            <span>포트</span>
            <input className="field" value={c.port ? String(c.port) : ''} placeholder="445" inputMode="numeric" onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </label>
          <label className="sfield">
            <span>공유 폴더</span>
            <input className="field" value={c.share ?? ''} placeholder="여러 개면 쉼표로 (예: voice, tunnel)" autoCapitalize="off" onChange={(e) => set({ share: e.target.value })} />
          </label>
          <label className="sfield">
            <span>아이디</span>
            <input className="field" value={c.smbUser ?? ''} autoCapitalize="off" onChange={(e) => set({ smbUser: e.target.value })} />
          </label>
          <label className="sfield">
            <span>비밀번호</span>
            <input className="field" type="password" value={smbPw} placeholder={conn.hasSmbPassword ? '바꿀 때만 입력' : ''} onChange={(e) => (setSmbPw(e.target.value), clear())} />
          </label>
        </>
      ) : (
        <>
          <label className="sfield">
            <span>주소</span>
            <input className="field" value={c.url ?? ''} placeholder="https://192.168.0.10:5006" inputMode="url" autoCapitalize="off" onChange={(e) => set({ url: e.target.value.trim() })} />
          </label>
          <label className="sfield">
            <span>아이디</span>
            <input className="field" value={c.user ?? ''} autoCapitalize="off" onChange={(e) => set({ user: e.target.value })} />
          </label>
          <label className="sfield">
            <span>비밀번호</span>
            <input className="field" type="password" value={pw} placeholder={conn.hasPassword ? '바꿀 때만 입력' : ''} onChange={(e) => (setPw(e.target.value), clear())} />
          </label>
          <label className="check sheet-check">
            <input type="checkbox" checked={!!c.insecure} onChange={(e) => set({ insecure: e.target.checked })} />
            인증서 확인 건너뛰기 (자체 서명 https)
          </label>
        </>
      )}
      {ok && <div className="hint sheet-ok">{ok}</div>}
      {err && <div className="sheet-err">{err}</div>}
      <div className="sheet-foot">
        {conn.id && (
          <button className="cfm-btn danger" onClick={() => void window.api.nasRemove(conn.id!).then(onRemoved)}>
            연결 삭제
          </button>
        )}
        <span className="grow" />
        <button
          className="cfm-btn primary"
          disabled={busy || (!filled.smb && !filled.webdav)}
          onClick={async () => {
            // the tab on screen is checked (if filled); the other is saved as entered
            if (filled[tab] && !(await test())) return
            const id = await window.api.nasSave(
              { ...c, host: c.host?.trim() ?? '', url: c.url?.trim() ?? '', name: c.name?.trim() || 'NAS' },
              { password: pw || undefined, smbPassword: smbPw || undefined }
            )
            onSaved(id)
          }}
        >
          저장
        </button>
        <button className="cfm-btn" disabled={busy || !filled[tab]} onClick={() => void test()}>
          연결 확인
        </button>
        <button className="cfm-btn ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </Sheet>
  )
}

// The NAS's folders one level at a time; pick the library folder.
function FolderBrowser({ start, onClose, onPick }: { start: string; onClose: () => void; onPick: (p: string) => void }): JSX.Element {
  const [path, setPath] = useState(start)
  const [dirs, setDirs] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { id, rel } = nasParts(path)
  const up = (): void => setPath(nasPath(id, rel.split('/').slice(0, -1).join('/')))
  useEffect(() => {
    let alive = true
    setDirs(null)
    setErr(null)
    window.api
      .listDirs(path)
      .then((d) => alive && setDirs(d))
      .catch((e: Error) => alive && setErr(String(e.message ?? e)))
    return () => {
      alive = false
    }
  }, [path])
  return (
    <Sheet title="라이브러리 폴더 고르기" onClose={onClose}>
      <div className="fb-path">
        {rel && (
          <button className="mini icon" title="위로" onClick={up}>
            <KeyboardArrowLeftIcon />
          </button>
        )}
        <span className="selectable">/{rel}</span>
      </div>
      {err && <div className="sheet-err">{err}</div>}
      {!dirs && !err && <div className="hint sheet-note">불러오는 중…</div>}
      <div className="fb-list">
        {dirs?.map((d) => (
          <button key={d} className="menu-item" onClick={() => setPath(nasPath(id, rel ? `${rel}/${d}` : d))}>
            <FolderIcon />
            {d}
          </button>
        ))}
        {dirs && dirs.length === 0 && <div className="hint sheet-note">하위 폴더가 없습니다.</div>}
      </div>
      <div className="sheet-foot">
        <span className="grow" />
        <button className="cfm-btn primary" disabled={!rel} onClick={() => onPick(path)}>
          이 폴더 선택
        </button>
        <button className="cfm-btn ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </Sheet>
  )
}

export default function SettingsView(): JSX.Element | null {
  const s = useStore((x) => x.settings)
  const scan = useStore((x) => x.scan)
  const overlay = useStore((x) => x.overlay)
  const works = useStore((x) => x.works)
  const [conns, setConns] = useState<NasConn[]>([])
  const [editing, setEditing] = useState<Partial<NasConn> | null>(null)
  const [browse, setBrowse] = useState<string | null>(null)
  const [pickConn, setPickConn] = useState(false)
  const [removing, setRemoving] = useState<{ id: string; path: string; works: number } | null>(null)
  const [version, setVersion] = useState('')
  const st = useStore.getState
  const loadConns = (): void => void window.api.nasList().then(setConns)
  useEffect(() => {
    loadConns()
    void native.appInfo().then((i) => setVersion(i.version))
  }, [])
  if (!s) return null
  const save = (p: Partial<Settings>): void => void st().saveSettings(p)
  const scanning = scan?.state === 'running'
  const after = async (r: { ok: boolean; message: string }): Promise<void> => {
    st().showToast(r)
    await st().loadWorks()
    await st().loadGroups()
  }
  const addNas = (): void => {
    if (!conns.length) return setEditing({})
    if (conns.length === 1) return setBrowse(nasPath(conns[0].id, ''))
    setPickConn(true)
  }
  const addPhone = async (): Promise<void> => {
    const p = await window.api.pickFolder()
    if (p) await after(await window.api.addSource(p))
  }
  const look = (p: Partial<Settings>): void => {
    save(p)
    const n = { ...s, ...p }
    void native.overlaySet({ size: n.overlaySize, opacity: n.overlayOpacity, hideInApp: n.overlayHideInApp })
  }
  return (
    <div className="settings">
      <div className="wp-top">
        <div className="flat-group">
          <button className="mini icon" title="뒤로" onClick={() => st().setView('library')}>
            <KeyboardArrowLeftIcon />
          </button>
        </div>
      </div>
      <h1>설정</h1>
      <section>
        <h3>라이브러리 폴더</h3>
        <div className="hint set-hint">
          PC의 Envelope가 폴더에 모바일 정보 파일(.envelope)을 남겨 두었으면 그것을 읽습니다 — 복구 · 번역한 이름, DLsite 정보, 프로그램 안의 자막까지 PC와 같습니다. 없으면 폴더를 직접 읽습니다.
        </div>
        <div className="dirs">
          {s.sources.map((x) => (
            <div key={x.id} className="dir">
              {x.path.startsWith('/nas/') ? <DnsIcon /> : <MobileIcon />}
              <span className="selectable grow">
                {shownPath(x.path)}
                <span className="hint"> · 작품 {works.filter((w) => w.path.startsWith(x.path + '/')).length}</span>
              </span>
              <button className="mini icon" title="목록에서 빼기 (파일은 그대로)" onClick={() => setRemoving({ id: x.id, path: x.path, works: window.api.sourceWorks(x.id) })}>
                <DeleteIcon />
              </button>
            </div>
          ))}
          <div className="flat-group">
            <button className="mini" onClick={addNas}>
              <DnsIcon /> NAS 폴더
            </button>
            <button className="mini" onClick={() => void addPhone()}>
              <MobileIcon /> 휴대폰 폴더
            </button>
            <button className="mini" disabled={scanning || !s.sources.length} onClick={async () => after(await window.api.scan(true))}>
              <RefreshIcon /> {scanning ? `읽는 중 ${scan?.total ? `${scan.done} / ${scan.total}` : ''}` : '다시 읽기'}
            </button>
          </div>
        </div>
      </section>
      <section>
        <h3>NAS 연결</h3>
        <div className="dirs">
          {conns.map((c) => (
            <div key={c.id} className="dir">
              <DnsIcon />
              <span className="grow">
                {c.name}
                <span className="hint"> · {[c.host && 'SMB', c.url && 'WebDAV'].filter(Boolean).join(' + ')}</span>
              </span>
              <button className="mini icon" title="연결 수정" onClick={() => setEditing(c)}>
                <EditIcon />
              </button>
            </div>
          ))}
          <div className="flat-group">
            <button className="mini" onClick={() => setEditing({})}>
              <AddIcon /> NAS 연결 추가
            </button>
          </div>
        </div>
      </section>
      <section>
        <h3>떠 있는 자막</h3>
        <Row label="다른 앱 위에 표시" hint="재생 중에 다른 앱을 쓰면 그 위에 자막 줄만 작게 띄웁니다(화면 속 화면 없이). 지금 재생의 자막 버튼 옆에서 켜고 끕니다.">
          {overlay.allowed ? (
            <span className="hint">허용됨</span>
          ) : (
            <div className="flat-group">
              <button className="mini" onClick={async () => useStore.setState({ overlay: await native.overlayPermission() })}>
                권한 설정
              </button>
            </div>
          )}
        </Row>
        <Row label="글자 크기" hint="떠 있는 자막을 눌러 나오는 버튼으로도 바꿀 수 있습니다.">
          <Stepper value={Math.round(overlay.enabled ? overlay.size : s.overlaySize)} min={12} max={40} step={2} onChange={(v) => look({ overlaySize: v })} />
        </Row>
        <Row label="배경 진하기" hint="퍼센트 단위입니다. 잠그면 Android 규칙에 따라 창 전체가 조금 옅어집니다(아래 앱을 누를 수 있게).">
          <Stepper value={Math.round(s.overlayOpacity * 100)} min={30} max={100} step={5} onChange={(v) => look({ overlayOpacity: v / 100 })} />
        </Row>
        <Row label="Envelope 화면에서는 숨기기" hint="Envelope를 보고 있는 동안에는 떠 있는 자막을 숨깁니다.">
          <Seg value={s.overlayHideInApp ? 'on' : 'off'} options={[['on', '켜기'], ['off', '끄기']]} onChange={(v) => look({ overlayHideInApp: v === 'on' })} />
        </Row>
      </section>
      <section>
        <h3>재생</h3>
        <Row label="기본 버전" hint="SE를 넣은 판과 뺀 판이 다 있을 때 먼저 고를 쪽입니다. 작품마다 바꿀 수 있습니다.">
          <Seg value={s.sePref} options={[['on', 'SE 포함'], ['off', 'SE 제외']]} onChange={(v) => save({ sePref: v })} />
        </Row>
        <Row label="파일 형식" hint="같은 트랙이 여러 형식으로 있을 때 먼저 고를 쪽입니다. NAS에서는 mp3가 데이터를 덜 씁니다.">
          <Seg value={s.formatPref} options={[['lossless', '무손실 (wav · flac)'], ['mp3', 'mp3']]} onChange={(v) => save({ formatPref: v })} />
        </Row>
        <Row label="이어 듣기" hint="켜면 작품 · 트랙을 마지막으로 듣던 곳부터 재생합니다. 끄면 항상 첫 트랙의 처음부터 재생합니다(들은 위치 기록은 그대로 남습니다).">
          <Seg value={s.resume ? 'on' : 'off'} options={[['on', '켜기'], ['off', '끄기']]} onChange={(v) => save({ resume: v === 'on' })} />
        </Row>
        <Row label="건너뛰기 간격" hint="초 단위입니다.">
          <Stepper value={s.seekStep ?? 5} min={1} max={60} step={5} onChange={(v) => save({ seekStep: v })} />
        </Row>
      </section>
      <section>
        <h3>자막</h3>
        <Row label="표시" hint="원문(일본어)과 번역(한국어) 자막이 둘 다 있을 때 보여줄 줄입니다. 떠 있는 자막도 같습니다.">
          <Seg<SubMode>
            value={s.subMode}
            options={[
              ['both', '둘 다'],
              ['original', '원문'],
              ['translation', '번역'],
              ['off', '끄기']
            ]}
            onChange={(v) => save({ subMode: v })}
          />
        </Row>
        <Row label="글자 크기">
          <Seg value={s.subSize} options={[[18, '작게'], [22, '보통'], [28, '크게'], [36, '아주 크게']]} onChange={(v) => save({ subSize: v })} />
        </Row>
      </section>
      <section>
        <h3>그룹</h3>
        <Groups />
      </section>
      <section>
        <h3>화면</h3>
        <Row label="테마">
          <Seg value={s.theme} options={[['light', '라이트'], ['dark', '다크']]} onChange={(v) => save({ theme: v })} />
        </Row>
        <Row label="한 페이지 작품 수" hint="라이브러리 목록을 이 개수씩 나눠 페이지로 보여줍니다.">
          <Stepper value={s.pageSize ?? 50} min={1} step={10} onChange={(v) => save({ pageSize: v })} />
        </Row>
      </section>
      <p className="hint selectable about">Envelope 모바일 {version}</p>

      {editing && (
        <ConnSheet
          conn={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null)
            loadConns()
            if (!editing.id) setBrowse(nasPath(id, ''))
          }}
          onRemoved={() => {
            setEditing(null)
            loadConns()
          }}
        />
      )}
      {pickConn && (
        <Sheet title="NAS 고르기" onClose={() => setPickConn(false)}>
          <div className="fb-list">
            {conns.map((c) => (
              <button key={c.id} className="menu-item" onClick={() => (setPickConn(false), setBrowse(nasPath(c.id, '')))}>
                <DnsIcon /> {c.name}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {browse && (
        <FolderBrowser
          start={browse}
          onClose={() => setBrowse(null)}
          onPick={async (p) => {
            setBrowse(null)
            await after(await window.api.addSource(p))
          }}
        />
      )}
      {removing && (
        <Confirm
          danger
          title="라이브러리 폴더를 뺄까요?"
          body={
            <>
              <span className="selectable">{shownPath(removing.path)}</span>
              <br />이 폴더의 작품 {removing.works}개가 목록에서 빠집니다. 파일은 그대로 두고, 휴대폰에 남긴 즐겨찾기 · 이어 듣기 같은 기록은 다시 추가하면 돌아옵니다.
            </>
          }
          ok="빼기"
          onCancel={() => setRemoving(null)}
          onOk={async () => {
            const id = removing.id
            setRemoving(null)
            await window.api.removeSource(id)
            await st().loadWorks()
            await st().loadGroups()
          }}
        />
      )}
    </div>
  )
}
