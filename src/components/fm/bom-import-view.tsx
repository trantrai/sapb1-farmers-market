'use client'

// ============================================================
// FARMERS MARKET — Import BOM/Combo: màn hình Sprint 1
// Ingest (F18) → Gate 1 xác nhận file (F20) → Parse (F1) →
// Validate (F3) → tab Quyết định 17 mục (F8).
// Preview/Apply/Kết quả: hiển thị disabled "Sprint tiếp theo".
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import {
  Download, CheckCircle2, XCircle, AlertTriangle, FileSpreadsheet,
  ListChecks, Lock, ChevronRight, RefreshCw, Ban,
} from 'lucide-react'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import type { SessionUser } from '@/lib/fm-shared'

const NAVY = '#1E3A5F'
const GOLD = '#F2B705'
const CORAL = '#E0522F'

interface SourceFile {
  input: 'IN-1' | 'IN-2'
  field: string
  filename: string
  relPath: string
  md5: string
  sha256: string
  bytes: number
  downloadedAt: string
}

interface Run {
  id: string
  jobId: string
  jobName: string | null
  status: string
  sourceFiles: SourceFile[]
  decisions: { id: string; decided: string; at: string }[]
  startedBy: string
  createdAt: string
  finishedAt: string | null
}

interface Issue {
  code: string
  rowNo: number | null
  field: string | null
  message: string
  severity: 'error' | 'warning'
}

interface ParentSummary {
  rowNo: number
  itemCode: string | null
  itemName: string
  bomKind: string | null
  primaryBarcode: string | null
  priceExVat: number | null
  components: number
  marginPct: number | null
}

interface Decision {
  id: string
  group: 'mapping' | 'pipeline'
  question: string
  decided: string
}

const STEPS = [
  { key: 'ingest', label: 'Ingest' },
  { key: 'parse', label: 'Parse' },
  { key: 'validate', label: 'Validate' },
  { key: 'preview', label: 'Preview', locked: true },
  { key: 'apply', label: 'Apply', locked: true },
  { key: 'done', label: 'Kết quả', locked: true },
]

const STATUS_LABEL: Record<string, string> = {
  ingesting: 'Đang tải file…',
  ingested: 'Chờ xác nhận (gate 1)',
  confirmed: 'Đã xác nhận — chờ parse',
  validated: 'Đã parse + validate',
  failed: 'Thất bại',
  cancelled: 'Đã hủy',
}

function stepIndexFor(status: string): number {
  switch (status) {
    case 'ingesting': return 0
    case 'ingested': return 0
    case 'confirmed': return 1
    case 'validated': return 2
    default: return 0
  }
}

const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('vi-VN', { hour12: false })
  } catch {
    return iso
  }
}

export default function BomImportView({ user }: { user: SessionUser }) {
  const canCreate = Boolean(user.permissions.bomImport?.create)
  const [tab, setTab] = useState<'runs' | 'decisions'>('runs')
  const [jobId, setJobId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [fieldLog, setFieldLog] = useState<string[]>([])
  const [parents, setParents] = useState<ParentSummary[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [skippedRules, setSkippedRules] = useState<string[]>([])
  const [blocked, setBlocked] = useState(false)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [conflictRunId, setConflictRunId] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    const res = await api('/api/bom-import/runs?pageSize=10')
    if (!res.ok) return
    const json = await res.json()
    setRuns(json.runs ?? [])
  }, [])

  const loadDecisions = useCallback(async () => {
    const res = await api('/api/bom-import/decisions')
    if (!res.ok) return
    const json = await res.json()
    setDecisions(json.decisions ?? [])
  }, [])

  useEffect(() => { loadRuns() }, [loadRuns])
  useEffect(() => { if (tab === 'decisions' && decisions.length === 0) loadDecisions() }, [tab, decisions.length, loadDecisions])

  const openRun = async (id: string) => {
    const res = await api(`/api/bom-import/runs/${id}`)
    if (!res.ok) return
    const json = await res.json()
    setRun(json.run)
    setParents([])
    setIssues([])
    setFieldLog([])
  }

  const startIngest = async (force = false) => {
    if (!jobId.trim() || busy) return
    setBusy(true)
    setMsg(null)
    setConflictRunId(null)
    try {
      const res = await api('/api/bom-import/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId.trim(), force }),
      })
      const json = await res.json()
      if (res.status === 409 && json.existingRunId) {
        setConflictRunId(json.existingRunId)
        setMsg({ type: 'info', text: json.error })
        return
      }
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Tạo run thất bại' })
        return
      }
      setRun(json.run)
      setFieldLog(json.fieldLog ?? [])
      setMsg({ type: 'success', text: `Đã tải ${json.run.sourceFiles.length} file từ job ${json.run.jobId} — hãy kiểm tra và xác nhận ở gate 1` })
      loadRuns()
    } finally {
      setBusy(false)
    }
  }

  const doConfirm = async (action: 'confirm' | 'cancel') => {
    if (!run || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await api(`/api/bom-import/runs/${run.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Xác nhận thất bại' })
        return
      }
      setRun(json.run)
      if (action === 'confirm') {
        setMsg({ type: 'success', text: 'Đã xác nhận file — đang parse…' })
        await doParse(json.run.id)
      } else {
        setMsg({ type: 'info', text: 'Đã hủy run — file đã tải được giữ lại để tra cứu' })
      }
      loadRuns()
    } finally {
      setBusy(false)
    }
  }

  const doParse = async (runId: string) => {
    setBusy(true)
    try {
      const res = await api(`/api/bom-import/runs/${runId}/parse`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Parse thất bại' })
        if (json.run) setRun(json.run)
        return
      }
      setRun(json.run)
      setParents(json.parents ?? [])
      setIssues(json.issues ?? [])
      setSkippedRules(json.skippedRules ?? [])
      setBlocked(Boolean(json.blocked))
      const e = json.stats?.errors ?? 0
      const w = json.stats?.warnings ?? 0
      setMsg(
        e > 0
          ? { type: 'error', text: `Parse xong: ${json.stats.parents} mã cha, ${json.stats.components} dòng con — ${e} lỗi fail-fast (chặn apply), ${w} cảnh báo` }
          : { type: 'success', text: `Parse xong: ${json.stats.parents} mã cha, ${json.stats.components} dòng con — không có lỗi fail-fast, ${w} cảnh báo` },
      )
      loadRuns()
    } finally {
      setBusy(false)
    }
  }

  const stepIdx = run ? stepIndexFor(run.status) : -1
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  return (
    <div>
      <PageHeader
        breadcrumb={['Đồng bộ', 'Import BOM/Combo']}
        title="Import BOM/Combo từ Base Workflow"
        badge="Sprint 1"
      />

      {/* Stepper 6 bước */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {STEPS.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div
                title={s.locked ? 'Sprint tiếp theo' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 999,
                  background: i <= stepIdx && !s.locked ? NAVY : '#F1F5F9',
                  color: i <= stepIdx && !s.locked ? '#fff' : '#64748B',
                  fontSize: 13, fontWeight: 600,
                  opacity: s.locked ? 0.65 : 1,
                }}
              >
                {s.locked && <Lock size={12} />}
                {i + 1}. {s.label}
              </div>
              {i < STEPS.length - 1 && <ChevronRight size={14} color="#94A3B8" />}
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`fm-btn ${tab === 'runs' ? 'fm-btn--primary' : 'fm-btn--secondary'}`}
          onClick={() => setTab('runs')}
        >
          <FileSpreadsheet size={16} style={{ verticalAlign: -2, marginRight: 6 }} />
          Lượt chạy
        </button>
        <button
          className={`fm-btn ${tab === 'decisions' ? 'fm-btn--primary' : 'fm-btn--secondary'}`}
          onClick={() => setTab('decisions')}
        >
          <ListChecks size={16} style={{ verticalAlign: -2, marginRight: 6 }} />
          Quyết định (17)
        </button>
      </div>

      {msg && (
        <div
          className="fm-card"
          style={{
            marginBottom: 16,
            borderLeft: `4px solid ${msg.type === 'error' ? CORAL : msg.type === 'success' ? '#16A34A' : GOLD}`,
          }}
        >
          {msg.text}
          {conflictRunId && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => openRun(conflictRunId)}>
                Mở run đã có
              </button>
              {canCreate && (
                <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => startIngest(true)} disabled={busy}>
                  Tạo run mới có chủ đích
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'decisions' ? (
        <div className="fm-card">
          <div className="fm-card__head"><ListChecks size={18} /> 17 quyết định đã chốt (2026-10-16)</div>
          <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
            <table className="fm-table">
              <thead>
                <tr><th style={{ width: 70 }}>Mã</th><th style={{ width: 90 }}>Nhóm</th><th>Câu hỏi</th><th>Quyết định đã chốt</th></tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{d.id}</td>
                    <td>{d.group === 'mapping' ? 'Mapping' : 'Pipeline'}</td>
                    <td>{d.question}</td>
                    <td>{d.decided}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          {/* Nhập jobId */}
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <div className="fm-card__head"><Download size={18} /> Ingest từ Base Workflow (F18)</div>
            <div className="fm-card__body">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="fm-field" style={{ minWidth: 240 }}>
                  <label className="fm-label" htmlFor="fm-bom-jobid">Job ID Base Workflow</label>
                  <input
                    id="fm-bom-jobid"
                    className="fm-input"
                    placeholder="vd: 4818871"
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                    disabled={busy || !canCreate}
                    onKeyDown={(e) => { if (e.key === 'Enter') startIngest() }}
                  />
                </div>
                <button
                  className="fm-btn fm-btn--primary"
                  onClick={() => startIngest()}
                  disabled={busy || !canCreate || !jobId.trim()}
                >
                  <Download size={16} style={{ verticalAlign: -2, marginRight: 6 }} />
                  {busy ? 'Đang tải…' : 'Tải file từ Base'}
                </button>
                {!canCreate && <span className="fm-hint">Bạn chỉ có quyền xem (cần quyền Tạo để ingest).</span>}
              </div>
              <p className="fm-hint" style={{ marginTop: 8 }}>
                App gọi <code>POST workflow.base.vn/extapi/v1/job/get</code> (param <code>id</code>),
                tải ngay 2 file (File BOM + workbook báo giá) kèm md5/sha256. Cần cấu hình
                Base Access Token v2 ở màn hình Cài đặt trước.
              </p>
            </div>
          </div>

          {/* Gate 1 */}
          {run && run.status === 'ingested' && (
            <div className="fm-card" style={{ marginBottom: 16, borderLeft: `4px solid ${GOLD}` }}>
              <div className="fm-card__head">
                <Lock size={18} /> Gate 1 — Xác nhận file trước khi parse
              </div>
              <div className="fm-card__body">
                <p><strong>Job:</strong> <span style={{ fontFamily: 'monospace' }}>{run.jobId}</span> — {run.jobName || '(không tên)'}</p>
                <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 8 }}>
                  <table className="fm-table">
                    <thead>
                      <tr><th>Input</th><th>Field trên Base</th><th>File</th><th>Dung lượng</th><th>MD5 (8 ký tự đầu)</th><th>Tải lúc</th></tr>
                    </thead>
                    <tbody>
                      {run.sourceFiles.map((f) => (
                        <tr key={f.input + f.field}>
                          <td><span className="fm-chip" style={{ background: NAVY, color: '#fff' }}>{f.input}</span></td>
                          <td>{f.field}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.filename}</td>
                          <td>{fmtBytes(f.bytes)}</td>
                          <td style={{ fontFamily: 'monospace' }}>{f.md5.slice(0, 8)}…</td>
                          <td>{fmtDate(f.downloadedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {fieldLog.length > 0 && (
                  <ul style={{ marginTop: 8, paddingLeft: 18, fontSize: 13, color: '#475569' }}>
                    {fieldLog.map((l, i) => <li key={i}>{l}</li>)}
                  </ul>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="fm-btn fm-btn--primary" onClick={() => doConfirm('confirm')} disabled={busy || !canCreate}>
                    <CheckCircle2 size={16} style={{ verticalAlign: -2, marginRight: 6 }} />
                    Xác nhận & tiếp tục parse
                  </button>
                  <button className="fm-btn fm-btn--secondary" onClick={() => doConfirm('cancel')} disabled={busy || !canCreate}>
                    <Ban size={16} style={{ verticalAlign: -2, marginRight: 6 }} />
                    Hủy run
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Kết quả parse + validate */}
          {run && (run.status === 'validated' || parents.length > 0) && (
            <div className="fm-card" style={{ marginBottom: 16 }}>
              <div className="fm-card__head">
                <CheckCircle2 size={18} /> Parse & Validate — {parents.length} mã cha
                {blocked && <span className="fm-chip" style={{ background: CORAL, color: '#fff' }}>{errors.length} lỗi fail-fast</span>}
                {!blocked && <span className="fm-chip" style={{ background: '#16A34A', color: '#fff' }}>Không lỗi fail-fast</span>}
                {warnings.length > 0 && <span className="fm-chip" style={{ background: GOLD, color: '#1E293B' }}>{warnings.length} cảnh báo</span>}
              </div>
              <div className="fm-card__body">
                <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
                  <table className="fm-table">
                    <thead>
                      <tr><th>Dòng</th><th>Mã cha</th><th>Tên</th><th>Loại</th><th>Barcode chính</th><th>Giá trước VAT</th><th>Số con</th><th>Margin</th></tr>
                    </thead>
                    <tbody>
                      {parents.map((p) => (
                        <tr key={p.rowNo}>
                          <td style={{ fontFamily: 'monospace' }}>{p.rowNo}</td>
                          <td style={{ fontFamily: 'monospace' }}>{p.itemCode ?? <em style={{ color: '#94A3B8' }}>(chờ nhập)</em>}</td>
                          <td>{p.itemName}</td>
                          <td>{p.bomKind === 'BOM_PRODUCT' ? 'BOM' : p.bomKind === 'BOM_ASSEMBLY' ? 'COMBO' : '?'}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.primaryBarcode ?? '—'}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{p.priceExVat?.toLocaleString('vi-VN') ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{p.components}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{p.marginPct != null ? `${(p.marginPct * 100).toFixed(1)}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {errors.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <h4 style={{ color: CORAL, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <XCircle size={16} /> Lỗi fail-fast ({errors.length}) — chặn apply
                    </h4>
                    <ul style={{ paddingLeft: 18, fontSize: 13 }}>
                      {errors.map((e, i) => (
                        <li key={i}><code>{e.code}</code>{e.rowNo ? ` dòng ${e.rowNo}` : ''}: {e.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {warnings.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <h4 style={{ color: '#92400E', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertTriangle size={16} /> Cảnh báo ({warnings.length}) — không chặn
                    </h4>
                    <ul style={{ paddingLeft: 18, fontSize: 13 }}>
                      {warnings.map((w, i) => (
                        <li key={i}><code>{w.code}</code>{w.rowNo ? ` dòng ${w.rowNo}` : ''}: {w.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {skippedRules.length > 0 && (
                  <p className="fm-hint" style={{ marginTop: 12 }}>
                    Bỏ qua ở Sprint 1: {skippedRules.join(' · ')}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Lịch sử runs */}
          <div className="fm-card">
            <div className="fm-card__head">
              <RefreshCw size={18} /> Lịch sử lượt chạy
              <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} onClick={loadRuns}>Tải lại</button>
            </div>
            <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr><th>Run</th><th>Job</th><th>Trạng thái</th><th>Files</th><th>Người tạo</th><th>Tạo lúc</th><th></th></tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} style={run?.id === r.id ? { background: '#EFF6FF' } : undefined}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.id.slice(0, 8)}…</td>
                      <td style={{ fontFamily: 'monospace' }}>{r.jobId}</td>
                      <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                      <td style={{ textAlign: 'right' }}>{r.sourceFiles.length}</td>
                      <td>{r.startedBy}</td>
                      <td>{fmtDate(r.createdAt)}</td>
                      <td><button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => openRun(r.id)}>Mở</button></td>
                    </tr>
                  ))}
                  {runs.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: '#94A3B8' }}>Chưa có lượt chạy nào</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
