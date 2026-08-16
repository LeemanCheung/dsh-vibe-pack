import React, { useEffect, useMemo, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import vibePackRemote from 'dsh-vibe-pack/remote'
import styles from './VibePack.module.css'
import type { Change, InstallPlan, PackLedger, PackLedgerEntry, SourceSpec } from '../index.js'

export const inject = ['slots', 'remote']

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
type RawApi = {
  history(): Promise<RemoteResult<PackLedger>>
  plan(source: SourceSpec): Promise<RemoteResult<InstallPlan>>
  install(source: SourceSpec, force: boolean, expectedDigest: string): Promise<RemoteResult<InstallPlan>>
  uninstall(id: string, force: boolean): Promise<RemoteResult<void>>
  diff(id: string): Promise<RemoteResult<Change[]>>
  export(id: string): Promise<RemoteResult<string>>
}
type Api = { [K in keyof RawApi]: RawApi[K] extends (...args: infer Args) => Promise<RemoteResult<infer Value>> ? (...args: Args) => Promise<Value> : never }
type Notice = { kind: 'info' | 'success' | 'error'; title: string; detail: string }
type Result = { title: string; summary: string; raw: unknown; plan?: InstallPlan; diff?: Change[] }

async function unwrap<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function apiFrom(raw: RawApi): Api {
  return {
    history: () => unwrap(raw.history()), plan: source => unwrap(raw.plan(source)), install: (source, force, expectedDigest) => unwrap(raw.install(source, force, expectedDigest)),
    uninstall: (id, force) => unwrap(raw.uninstall(id, force)), diff: id => unwrap(raw.diff(id)), export: id => unwrap(raw.export(id)),
  }
}

function downloadPack(id: string, encoded: string): void {
  const prefix = 'dshpack/base64/v1:'
  if (!encoded.startsWith(prefix)) throw new Error('主机返回了不支持的导出格式。')
  const binary = window.atob(encoded.slice(prefix.length))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${id}.dshpack`
  anchor.click()
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function stringify(value: unknown): string { return JSON.stringify(value, null, 2) }
function actionLabel(action: InstallPlan['items'][number]['action']): string { return action === 'create' ? '创建' : action === 'replace' ? '替换' : '合并' }
function changeLabel(change: Change['type']): string { return change === 'create' ? '新增' : change === 'update' ? '更新' : change === 'delete' ? '删除' : '未变更' }

function ResultPanel({ result }: { result: Result | null }): React.ReactElement | null {
  if (!result) return null
  const groups = result.plan ? (['create', 'replace', 'merge'] as const).map(action => ({ action, items: result.plan!.items.filter(item => item.action === action) })).filter(group => group.items.length) : []
  const planContent = groups.length === 0 ? null : React.createElement('div', { className: styles.planGroups }, groups.map(group =>
    React.createElement('div', { className: styles.planGroup, key: group.action },
      React.createElement('h4', null, `${actionLabel(group.action)} · ${group.items.length} 项`),
      React.createElement('ul', { className: styles.planList }, group.items.map(item =>
        React.createElement('li', { className: styles.planItem, key: item.path },
          React.createElement('span', null, React.createElement('code', { className: styles.path }, item.path), item.conflict ? React.createElement('span', { className: styles.conflict }, `冲突：${item.conflict}`) : null),
          React.createElement('span', { className: styles.badge }, item.conflict ? '需确认' : '可执行')))))))
  const diffContent = !result.diff ? null : React.createElement('div', { className: styles.tableWrap },
    React.createElement('table', { className: styles.table },
      React.createElement('caption', { className: styles.help }, `差异共 ${result.diff.length} 项；摘要仅显示路径和状态，不读取文件内容。`),
      React.createElement('thead', null, React.createElement('tr', null, React.createElement('th', { scope: 'col' }, '状态'), React.createElement('th', { scope: 'col' }, '路径'), React.createElement('th', { scope: 'col' }, '变更前'), React.createElement('th', { scope: 'col' }, '变更后'))),
      React.createElement('tbody', null, result.diff.map(item =>
        React.createElement('tr', { key: item.path }, React.createElement('td', { className: styles.change, 'data-change': item.type }, changeLabel(item.type)), React.createElement('td', null, React.createElement('code', { className: styles.path }, item.path)), React.createElement('td', null, item.before?.digest.slice(0, 12) ?? '—'), React.createElement('td', null, item.after?.digest.slice(0, 12) ?? '—'))))))
  return React.createElement('section', { className: styles.result, 'aria-labelledby': 'vibe-result-title' },
    React.createElement('div', { className: styles.resultHeader }, React.createElement('h3', { id: 'vibe-result-title' }, result.title), React.createElement('span', { className: styles.muted }, result.summary)),
    planContent, diffContent,
    React.createElement('details', { className: styles.summary }, React.createElement('summary', null, '展开原始操作详情'), React.createElement('pre', { className: styles.raw }, stringify(result.raw))))
}

function PackCard({ id, entry, selected, onSelect }: { id: string; entry: PackLedgerEntry; selected: boolean; onSelect: () => void }): React.ReactElement {
  return React.createElement('button', { type: 'button', className: styles.packCard, 'aria-pressed': selected, onClick: onSelect },
    React.createElement('div', { className: styles.packHead }, React.createElement('strong', null, id), React.createElement('span', { className: styles.badge }, `v${entry.version}`)),
    React.createElement('p', { className: styles.packMeta }, `${Object.keys(entry.files).length} 个受账本管理的资源`),
    React.createElement('p', { className: styles.packMeta }, `来源摘要 ${entry.sourceDigest.slice(0, 12)}…`))
}

function VibePackSection({ api }: { api: Api }): React.ReactElement {
  const [sourceKind, setSourceKind] = useState<'directory' | 'archive'>('directory')
  const [sourcePath, setSourcePath] = useState('')
  const [forceInstall, setForceInstall] = useState(false)
  const [forceUninstall, setForceUninstall] = useState(false)
  const [reviewed, setReviewed] = useState<{ key: string; plan: InstallPlan } | null>(null)
  const [ledger, setLedger] = useState<PackLedger | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [uninstallConfirm, setUninstallConfirm] = useState('')
  const [notice, setNotice] = useState<Notice>({ kind: 'info', title: '准备就绪', detail: '正在读取本机已安装包账本。' })
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const source = useMemo<SourceSpec>(() => ({ kind: sourceKind, path: sourcePath.trim() }), [sourceKind, sourcePath])
  const sourceKey = `${source.kind}:${source.path}`
  const reviewedPlan = reviewed?.key === sourceKey ? reviewed.plan : undefined
  const installReady = reviewedPlan !== undefined && (reviewedPlan.warnings.length === 0 || forceInstall)
  const packs = useMemo(() => Object.entries(ledger?.packs ?? {}).sort(([a], [b]) => a.localeCompare(b)), [ledger])
  const selectedEntry = ledger?.packs[selectedId]
  const refresh = async (): Promise<PackLedger> => { const next = await api.history(); setLedger(next); return next }
  const run = (task: () => Promise<void>): void => { setBusy(true); void task().catch(reason => { setNotice({ kind: 'error', title: '操作未完成', detail: errorText(reason) }) }).finally(() => setBusy(false)) }

  useEffect(() => { run(async () => { const next = await refresh(); setNotice({ kind: 'success', title: '账本已加载', detail: `当前有 ${Object.keys(next.packs).length} 个已安装包。` }) }) }, [api])

  const preview = (): void => run(async () => { const plan = await api.plan(source); setReviewed({ key: sourceKey, plan }); setForceInstall(false); setResult({ title: '安装预览', summary: `${plan.pack.id} v${plan.pack.version} · ${plan.items.length} 项`, raw: plan, plan }); setNotice({ kind: plan.warnings.length ? 'info' : 'success', title: plan.warnings.length ? '预览发现冲突' : '预览通过', detail: plan.warnings.length ? `${plan.warnings.length} 项冲突需要单独确认强制安装。` : '未发现冲突；现在可以安装这份已审阅计划。' }) })
  const install = (): void => run(async () => { if(!reviewedPlan)throw new Error('请先预览当前来源。'); const plan = await api.install(source, forceInstall, reviewedPlan.sourceDigest); const next = await refresh(); setSelectedId(plan.pack.id); setUninstallConfirm(''); setReviewed(null); setResult({ title: '安装完成', summary: `${plan.pack.id} 已写入账本`, raw: { plan, installedPacks: Object.keys(next.packs) }, plan }); setNotice({ kind: 'success', title: '已安装', detail: forceInstall ? '已按本次预览明确确认的强制模式安装。' : '安装已完成，未使用强制覆盖。' }); setForceInstall(false) })
  const showDiff = (): void => run(async () => { const diff = await api.diff(selectedId); setResult({ title: '已安装包差异', summary: `${selectedId} · ${diff.filter(item => item.type !== 'unchanged').length} 项变化`, raw: diff, diff }); setNotice({ kind: 'success', title: '差异已生成', detail: '此处只展示受管理资源的状态与摘要，不展示文件内容。' }) })
  const exportSelected = (): void => run(async () => { const encoded = await api.export(selectedId); downloadPack(selectedId, encoded); setResult({ title: '导出已开始', summary: `${selectedId}.dshpack`, raw: { id: selectedId, format: 'dshpack/base64/v1' } }); setNotice({ kind: 'success', title: '下载已触发', detail: '导出前已由主机验证已安装资源与账本一致。' }) })
  const uninstall = (): void => run(async () => { await api.uninstall(selectedId, forceUninstall); const next = await refresh(); setResult({ title: '卸载完成', summary: `${selectedId} 已从账本移除`, raw: { uninstalled: selectedId, force: forceUninstall } }); setSelectedId(''); setUninstallConfirm(''); setNotice({ kind: 'success', title: '已卸载', detail: forceUninstall ? '已按本次卸载单独确认的强制模式执行。' : '卸载完成；未使用强制覆盖。' }); setForceUninstall(false); if (Object.keys(next.packs).length === 0) setResult({ title: '卸载完成', summary: '当前没有已安装包', raw: { uninstalled: selectedId, force: forceUninstall } }) })
  const pathLabel = sourceKind === 'directory' ? '本地目录路径' : '本地归档路径'

  return React.createElement('section', { className: styles.section, 'aria-labelledby': 'vibe-pack-title' },
    React.createElement('div', { className: styles.hero }, React.createElement('p', { className: styles.eyebrow }, '本地 · 数据包 · 可回滚'), React.createElement('h2', { id: 'vibe-pack-title' }, 'Vibe Pack 设置'), React.createElement('p', { className: styles.heroText }, '从本地目录或本地 .dshpack / ZIP 归档预览并管理纯数据配置包。不会访问网络或 Git 来源；脚本、符号链接、密钥与不安全路径均会被主机拒绝。')),
    React.createElement('div', { className: styles.layout },
      React.createElement('section', { className: styles.card, 'aria-labelledby': 'vibe-source-title' }, React.createElement('header', null, React.createElement('h3', { id: 'vibe-source-title' }, '安装来源'), React.createElement('span', { className: styles.badge }, '仅本地来源')),
        React.createElement('div', { className: styles.formGrid },
          React.createElement('label', { className: styles.field }, React.createElement('span', { className: styles.fieldLabel }, '来源类型'), React.createElement('select', { className: styles.select, value: sourceKind, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setSourceKind(event.currentTarget.value as typeof sourceKind) }, React.createElement('option', { value: 'directory' }, '本地目录'), React.createElement('option', { value: 'archive' }, '本地 .dshpack / ZIP 归档'))),
          React.createElement('label', { className: styles.field }, React.createElement('span', { className: styles.fieldLabel }, pathLabel), React.createElement('input', { className: styles.textInput, value: sourcePath, required: true, placeholder: sourceKind === 'directory' ? '例如 C:\\packs\\my-pack' : '例如 C:\\packs\\my-pack.dshpack', onChange: event => setSourcePath(event.currentTarget.value), 'aria-describedby': 'vibe-source-help' }), React.createElement('span', { className: styles.help, id: 'vibe-source-help' }, '路径由主机检查；不会上传、下载或执行来源中的代码。'))),
        React.createElement('div', { className: styles.warning, role: 'note' }, React.createElement('strong', null, '安装必须先预览。'), ' 来源路径或类型变化后，旧预览会立即失效；主机也会拒绝安装预览后发生变化的包。'),
        reviewedPlan?.warnings.length ? React.createElement('label', { className: styles.check }, React.createElement('input', { type: 'checkbox', checked: forceInstall, onChange: event => setForceInstall(event.currentTarget.checked) }), React.createElement('span', null, `我已复核预览中的 ${reviewedPlan.warnings.length} 项冲突，仅为本次安装启用强制覆盖。`)) : null,
        React.createElement('div', { className: styles.actions }, React.createElement('button', { type: 'button', className: styles.button, disabled: busy || !source.path, onClick: preview }, reviewedPlan?'重新预览':'预览计划'), React.createElement('button', { type: 'button', className: `${styles.button} ${styles.primary}`, disabled: busy || !installReady, onClick: install }, busy ? '处理中…' : reviewedPlan?'安装已审阅计划':'请先预览'))),
      React.createElement('aside', { className: styles.card, 'aria-labelledby': 'vibe-safety-title' }, React.createElement('header', null, React.createElement('h3', { id: 'vibe-safety-title' }, '安全边界')), React.createElement('p', { className: styles.help }, '每次操作均保留事务保护、SHA-256 完整性验证与归属检查。安装和卸载会保护用户修改；失败时主机会尝试回滚。'), React.createElement('p', { className: styles.help }, '导出前会验证账本一致性，并下载可移植的本地 .dshpack。'))),
    React.createElement('div', { className: styles.status, 'data-kind': notice.kind, role: notice.kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite' }, React.createElement('p', { className: styles.statusTitle }, notice.title), React.createElement('p', null, notice.detail)),
    React.createElement(ResultPanel, { result }),
    React.createElement('section', { className: `${styles.card} ${styles.selectedPanel}`, 'aria-labelledby': 'vibe-library-title' }, React.createElement('div', { className: styles.sectionHeading }, React.createElement('h3', { id: 'vibe-library-title' }, '已安装包'), React.createElement('button', { type: 'button', className: styles.button, disabled: busy, onClick: () => run(async () => { const next = await refresh(); setNotice({ kind: 'success', title: '账本已刷新', detail: `已读取 ${Object.keys(next.packs).length} 个已安装包。` }) }) }, '刷新账本')),
      packs.length === 0 ? React.createElement('p', { className: styles.empty }, '尚未安装 Vibe Pack。使用上方本地来源预览后再安装。') : React.createElement('div', { className: styles.library, role: 'group', 'aria-label': '已安装包列表' }, packs.map(([id, entry]) => React.createElement(PackCard, { key: id, id, entry, selected: id === selectedId, onSelect: () => { setSelectedId(id); setUninstallConfirm(''); setForceUninstall(false) } }))),
      selectedEntry ? React.createElement('section', { className: styles.dangerZone, 'aria-labelledby': 'vibe-selected-title' }, React.createElement('div', { className: styles.sectionHeading }, React.createElement('div', null, React.createElement('h4', { id: 'vibe-selected-title' }, '已选择的包'), React.createElement('p', { className: styles.selectedId }, selectedId)), React.createElement('span', { className: styles.count }, `${Object.keys(selectedEntry.files).length} 项资源`)), React.createElement('div', { className: styles.actions }, React.createElement('button', { type: 'button', className: styles.button, disabled: busy, onClick: showDiff }, '查看差异'), React.createElement('button', { type: 'button', className: styles.button, disabled: busy, onClick: exportSelected }, '导出 .dshpack')),
        React.createElement('p', null, '卸载会删除该包受账本管理的资源。若资源在安装后被修改，默认会拒绝卸载以保护您的更改。'), React.createElement('div', { className: styles.confirm }, React.createElement('label', { className: styles.field }, React.createElement('span', { className: styles.fieldLabel }, `输入“${selectedId}”以确认卸载`), React.createElement('input', { className: styles.textInput, value: uninstallConfirm, onChange: event => setUninstallConfirm(event.currentTarget.value), placeholder: selectedId, 'aria-describedby': 'vibe-uninstall-help' }), React.createElement('span', { className: styles.help, id: 'vibe-uninstall-help' }, forceUninstall ? '本次卸载将允许删除安装后被修改的受管资源。' : '未启用强制卸载；用户修改会受到保护。')), React.createElement('label', { className: styles.check }, React.createElement('input', { type: 'checkbox', checked: forceUninstall, onChange: event => setForceUninstall(event.currentTarget.checked) }), React.createElement('span', null, '仅为本次卸载允许删除安装后被修改的受管资源。')), React.createElement('button', { type: 'button', className: `${styles.button} ${styles.danger}`, disabled: busy || uninstallConfirm !== selectedId, onClick: uninstall }, forceUninstall?'确认强制卸载':'确认安全卸载'))) : null))
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(vibePackRemote)
  const raw = (ctx.remote as unknown as { vibePack: RawApi }).vibePack
  const api = apiFrom(raw)
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'vibe-pack', order: 35, label: () => 'Vibe Pack', inject: () => ({ api }) }, VibePackSection))
  return disposeRemote
}
