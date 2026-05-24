import { useState, useEffect, useRef } from 'react'
import { Loader2, Copy, Check, AlertCircle, Zap, Settings, ChevronDown, ChevronUp, RefreshCw, ImageIcon, ExternalLink, X } from 'lucide-react'
import { clsx } from 'clsx'
import type { JiraTicket, JiraAttachment } from '@/lib/types'
import { generatePrompt } from '@/lib/prompt-generator'
import { parseJiraInput } from '@/lib/url-parser'

type Step = 'idle' | 'fetching-jira' | 'generating' | 'done' | 'error'

const TICKET_KEY_RE = /[A-Z][A-Z0-9_]+-\d+/

function isJiraTicketTabUrl(url: string): boolean {
  if (!url.includes('atlassian.net')) return false
  try {
    const parsed = new URL(url)
    if (/\/browse\/[A-Z][A-Z0-9_]+-\d+/.test(parsed.pathname)) return true
    const selected = parsed.searchParams.get('selectedIssue')
    if (selected && TICKET_KEY_RE.test(selected)) return true
    if (/\/issues\/[A-Z][A-Z0-9_]+-\d+/.test(parsed.pathname)) return true
    return false
  } catch {
    return false
  }
}

interface StoredSettings {
  jiraBaseUrl: string
  autoOpenOnJira: boolean
}

interface SessionState {
  jiraInput: string
  step: Step
  error: string
  prompt: string
  ticket: JiraTicket | null
}

function useSettings() {
  const [settings, setSettings] = useState<StoredSettings>({ jiraBaseUrl: '', autoOpenOnJira: false })
  const [settingsReady, setSettingsReady] = useState(false)

  useEffect(() => {
    chrome.storage.local.get(['jiraBaseUrl', 'autoOpenOnJira'], result => {
      setSettings({
        jiraBaseUrl: result.jiraBaseUrl ?? '',
        autoOpenOnJira: result.autoOpenOnJira ?? false,
      })
      setSettingsReady(true)
    })
  }, [])

  function save(s: StoredSettings) {
    setSettings(s)
    chrome.storage.local.set(s)
  }

  return { settings, save, settingsReady }
}

function useSessionPersistence(state: SessionState, ready: boolean) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!ready) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      chrome.storage.session.set({ popupState: state })
    }, 200)
  }, [state, ready])
}

async function injectContentScript(tabId: number, file: string) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] })
}

async function fetchJiraViaCurrentTab(
  ticketKey: string,
  jiraBaseUrl: string
): Promise<JiraTicket> {
  const tabs = await chrome.tabs.query({ url: `${jiraBaseUrl}/*` })
  let tabId: number

  if (tabs.length > 0 && tabs[0].id) {
    tabId = tabs[0].id
  } else {
    const newTab = await chrome.tabs.create({ url: `${jiraBaseUrl}/browse/${ticketKey}`, active: false })
    tabId = newTab.id!
    await waitForTabLoad(tabId)
  }

  await injectContentScript(tabId, 'content-jira.js')

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'FETCH_JIRA_TICKET', ticketKey, jiraBaseUrl },
      response => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        if (response?.error) return reject(new Error(response.error))
        resolve(response.data)
      }
    )
  })
}

function blobToBase64(blob: Blob): Promise<string | null> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

async function fetchAttachmentBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (res.ok) return blobToBase64(await res.blob())
  } catch { /* ignore */ }
  try {
    const res = await fetch(url, { credentials: 'omit' })
    if (res.ok) return blobToBase64(await res.blob())
  } catch { /* ignore */ }
  return null
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise(resolve => {
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    })
  })
}

const ISSUE_TYPE_COLORS: Record<string, string> = {
  Bug: 'bg-red-500/15 text-red-300 border-red-500/30',
  Story: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Epic: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  Task: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
}

export default function App() {
  const { settings, save, settingsReady } = useSettings()
  const [jiraInput, setJiraInput] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [ticket, setTicket] = useState<JiraTicket | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedImageIdx, setCopiedImageIdx] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [jiraBaseUrlInput, setJiraBaseUrlInput] = useState(settings.jiraBaseUrl)
  const [showTicketDetails, setShowTicketDetails] = useState(false)
  const [stateReady, setStateReady] = useState(false)
  const [autoAnalyze, setAutoAnalyze] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<JiraAttachment | null>(null)
  const ticketRef = useRef<JiraTicket | null>(null)

  useEffect(() => { ticketRef.current = ticket }, [ticket])

  // On mount: if active tab is a Jira ticket, always set URL and auto-analyze
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const url = tabs[0]?.url || ''
      if (isJiraTicketTabUrl(url)) {
        chrome.storage.session.remove(['popupState'])
        setJiraInput(url)
        setAutoAnalyze(true)
      } else {
        // Not on a Jira ticket tab — restore last session state if any
        chrome.storage.session.get(['popupState'], result => {
          const saved = result.popupState as SessionState | undefined
          if (saved) {
            setJiraInput(saved.jiraInput || '')
            if (saved.step === 'done' || saved.step === 'error' || saved.step === 'idle') {
              setStep(saved.step)
              setError(saved.error || '')
              setPrompt(saved.prompt || '')
              setTicket(saved.ticket || null)
            }
          }
        })
      }
      setStateReady(true)
    })
  }, [])

  useEffect(() => {
    setJiraBaseUrlInput(settings.jiraBaseUrl)
  }, [settings.jiraBaseUrl])

  useSessionPersistence(
    { jiraInput, step, error, prompt, ticket },
    stateReady
  )

  useEffect(() => {
    if (!autoAnalyze || !stateReady || !settingsReady) return
    setAutoAnalyze(false)
    handleAnalyze()
  }, [autoAnalyze, stateReady, settingsReady])

  // Detect URL change in the active tab while the popup is open (e.g. opening a different ticket)
  useEffect(() => {
    if (!stateReady) return

    function handleTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (!changeInfo.url && changeInfo.status !== 'complete') return

      chrome.tabs.query({ active: true, currentWindow: true }, activeTabs => {
        if (activeTabs[0]?.id !== tabId) return

        const url = activeTabs[0].url || ''
        if (!isJiraTicketTabUrl(url)) return

        const keyMatch =
          url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/) ||
          url.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]+-\d+)/) ||
          url.match(/\/issues\/([A-Z][A-Z0-9_]+-\d+)/)
        const newKey = keyMatch?.[1] ?? null
        if (!newKey) return

        setStep('idle')
        setError('')
        setPrompt('')
        setTicket(null)
        setJiraInput(url)
        chrome.storage.session.remove(['popupState'])
        setAutoAnalyze(true)
      })
    }

    chrome.tabs.onUpdated.addListener(handleTabUpdated)
    return () => chrome.tabs.onUpdated.removeListener(handleTabUpdated)
  }, [stateReady])

  useEffect(() => {
    if (!previewAttachment) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewAttachment(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewAttachment])

  function resetState() {
    setStep('idle')
    setError('')
    setPrompt('')
    setTicket(null)
    chrome.storage.session.remove(['popupState'])
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const url = tabs[0]?.url || ''
      setJiraInput(isJiraTicketTabUrl(url) ? url : '')
    })
  }

  async function handleAnalyze() {
    setError('')
    setPrompt('')
    setTicket(null)

    const parsed = parseJiraInput(jiraInput.trim(), settings.jiraBaseUrl)
    if (!parsed) {
      setError(
        jiraInput.match(/^[A-Z][A-Z0-9_]+-\d+$/)
          ? 'Ticket key detected but no Jira base URL configured. Set it in settings.'
          : 'Invalid URL or ticket key. Expected: https://yourcompany.atlassian.net/browse/PROJ-123'
      )
      return
    }

    if (parsed.baseUrl && !settings.jiraBaseUrl) {
      save({ jiraBaseUrl: parsed.baseUrl })
    }

    try {
      setStep('fetching-jira')
      const jiraTicket = await fetchJiraViaCurrentTab(parsed.ticketKey, parsed.baseUrl)
      setTicket(jiraTicket)

      setStep('generating')
      const generatedPrompt = generatePrompt(jiraTicket)
      setPrompt(generatedPrompt)
      setStep('done')

      // Fetch image attachments from popup context (bypasses content-script CORS limits)
      const imageAttachments = jiraTicket.attachments.filter(a => a.isImage)
      if (imageAttachments.length > 0) {
        const results = await Promise.all(
          imageAttachments.map(a => fetchAttachmentBase64(a.url).then(base64 => ({ id: a.id, base64 })))
        )
        const base64Map = new Map(results.map(r => [r.id, r.base64]))
        setTicket(prev => {
          if (!prev) return prev
          return {
            ...prev,
            attachments: prev.attachments.map(a =>
              base64Map.has(a.id) ? { ...a, base64: base64Map.get(a.id) ?? null } : a
            ),
          }
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setStep('error')
    }
  }

  async function copyPrompt() {
    const images = ticket?.attachments.filter(a => a.isImage && a.base64) ?? []

    if (images.length === 0) {
      await navigator.clipboard.writeText(prompt)
    } else {
      // Build HTML with text + embedded images so Claude.ai receives both in one paste
      const escapedText = prompt
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const imgTags = images
        .map(a => `<img src="${a.base64}" alt="${a.filename}" style="max-width:100%">`)
        .join('\n')
      const html = `<pre>${escapedText}</pre>\n${imgTags}`

      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([prompt], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ])
      } catch {
        // ClipboardItem with multiple types not supported — fall back to text only
        await navigator.clipboard.writeText(prompt)
      }
    }

    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function copyImage(attachment: JiraAttachment) {
    if (!attachment.base64) {
      chrome.tabs.create({ url: attachment.url, active: false })
      return
    }
    try {
      const res = await fetch(attachment.base64)
      const blob = await res.blob()
      if (blob.type === 'image/png') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      } else {
        const img = new Image()
        img.src = attachment.base64
        await new Promise(r => { img.onload = r })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d')!.drawImage(img, 0, 0)
        const pngBlob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/png'))
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      }
      setCopiedImageIdx(attachment.url)
      setTimeout(() => setCopiedImageIdx(null), 2000)
    } catch {
      chrome.tabs.create({ url: attachment.url, active: false })
    }
  }

  const isLoading = ['fetching-jira', 'generating'].includes(step)

  const stepLabel: Record<string, string> = {
    'fetching-jira': 'Reading ticket...',
    generating: 'Generating prompt...',
  }

  const issueTypeColor = ticket
    ? (ISSUE_TYPE_COLORS[ticket.issueType] || ISSUE_TYPE_COLORS.Task)
    : ''

  return (
    <div className="w-full h-full bg-[#0d1117] text-slate-100 flex flex-col">
      {/* Header */}
      <div className="relative flex items-center justify-between px-6 py-4 border-b border-white/8 overflow-hidden">
        <div className="absolute left-0 top-0 w-32 h-full bg-gradient-to-r from-violet-900/20 to-transparent pointer-events-none" />
        <div className="flex items-center gap-3 relative">
          <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-violet-700 rounded-xl flex items-center justify-center shadow-lg shadow-violet-900/60 ring-1 ring-violet-400/20">
            <Zap size={16} className="text-white" />
          </div>
          <div>
            <span className="font-bold text-[15px] text-white tracking-tight">Jira Claude Coworker</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] text-slate-500 font-medium tracking-wide">READY</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 relative">
          {(step === 'done' || step === 'error' || !!ticket) && (
            <button
              onClick={resetState}
              title="New query"
              className="p-2 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-lg transition-all hover:scale-110 active:scale-95"
            >
              <RefreshCw size={15} />
            </button>
          )}
          <button
            onClick={() => setShowSettings(s => !s)}
            className={clsx(
              'p-2 rounded-lg transition-all hover:scale-110 active:scale-95',
              showSettings ? 'text-violet-400 bg-violet-500/10 ring-1 ring-violet-500/20' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
            )}
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="animate-slide-down px-6 py-4 border-b border-white/8 bg-[#161b22] space-y-4">
          <div>
            <p className="text-xs font-semibold text-slate-400 mb-2.5 uppercase tracking-wider">Jira Base URL</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={jiraBaseUrlInput}
                onChange={e => setJiraBaseUrlInput(e.target.value)}
                placeholder="https://yourcompany.atlassian.net"
                className="flex-1 bg-[#0d1117] text-sm text-slate-100 rounded-lg px-3 py-2.5 border border-white/10 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 placeholder-slate-600 transition-all"
              />
              <button
                onClick={() => { save({ jiraBaseUrl: jiraBaseUrlInput, autoOpenOnJira: settings.autoOpenOnJira }); setShowSettings(false) }}
                className="text-sm font-semibold bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white px-4 py-2.5 rounded-lg transition-all hover:shadow-lg hover:shadow-violet-900/40"
              >
                Save
              </button>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
            <div>
              <p className="text-xs font-semibold text-slate-300">Abrir automáticamente al detectar ticket Jira</p>
              <p className="text-xs text-slate-500 mt-0.5">Abre la extensión al navegar a un ticket</p>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoOpenOnJira}
              onClick={() => save({ jiraBaseUrl: settings.jiraBaseUrl, autoOpenOnJira: !settings.autoOpenOnJira })}
              className={clsx(
                'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                settings.autoOpenOnJira ? 'bg-violet-600' : 'bg-slate-700'
              )}
            >
              <span className={clsx(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200',
                settings.autoOpenOnJira ? 'translate-x-4' : 'translate-x-0'
              )} />
            </button>
          </label>
        </div>
      )}

      <div className="flex-1 p-6 space-y-4">
        {/* Jira input */}
        <div className="animate-fade-in">
          <label className="block text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wider">
            Jira Ticket
          </label>
          <input
            type="text"
            value={jiraInput}
            onChange={e => setJiraInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !isLoading && jiraInput.trim() && handleAnalyze()}
            placeholder="https://yourcompany.atlassian.net/browse/PROJ-123"
            className="w-full bg-[#161b22] text-sm text-slate-100 rounded-xl px-4 py-3 border border-white/8 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/15 focus:bg-[#1a2030] placeholder-slate-600 transition-all"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="animate-fade-in flex items-start gap-3 text-red-300 bg-red-500/8 border border-red-500/20 rounded-xl px-4 py-3.5 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <span className="leading-relaxed">{error}</span>
          </div>
        )}

        {/* Analyze button */}
        <button
          onClick={handleAnalyze}
          disabled={isLoading || !jiraInput.trim()}
          className={clsx(
            'w-full py-3.5 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2',
            isLoading || !jiraInput.trim()
              ? 'bg-white/5 text-slate-600 cursor-not-allowed border border-white/5'
              : 'bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 active:from-violet-700 active:to-violet-600 text-white shadow-lg shadow-violet-900/50 border border-violet-400/30 hover:scale-[1.01] active:scale-[0.99]'
          )}
        >
          {isLoading ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              <span>{stepLabel[step]}</span>
            </>
          ) : (
            <>
              <Zap size={15} />
              <span>Analyze and generate prompt</span>
            </>
          )}
        </button>

        {/* Ticket summary */}
        {ticket && (
          <div className="animate-fade-in bg-[#161b22] rounded-xl border border-white/8 overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-white/3 transition-colors"
              onClick={() => setShowTicketDetails(s => !s)}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={clsx('text-xs font-bold px-2.5 py-1 rounded-full border shrink-0', issueTypeColor)}>
                  {ticket.issueType}
                </span>
                <span className="text-xs font-mono text-slate-500 shrink-0">{ticket.key}</span>
                <span className="text-sm text-slate-200 truncate font-medium">{ticket.summary}</span>
              </div>
              {showTicketDetails
                ? <ChevronUp size={14} className="text-slate-600 shrink-0 ml-2 transition-transform" />
                : <ChevronDown size={14} className="text-slate-600 shrink-0 ml-2 transition-transform" />
              }
            </button>
            {showTicketDetails && (
              <div className="animate-fade-in-fast px-4 pb-4 pt-3 border-t border-white/8 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-[#0d1117] rounded-lg px-3 py-2.5">
                    <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-0.5">Status</p>
                    <p className="text-xs text-slate-300">{ticket.status}</p>
                  </div>
                  <div className="bg-[#0d1117] rounded-lg px-3 py-2.5">
                    <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-0.5">Priority</p>
                    <p className="text-xs text-slate-300">{ticket.priority}</p>
                  </div>
                  {ticket.assignee && (
                    <div className="bg-[#0d1117] rounded-lg px-3 py-2.5 col-span-2">
                      <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-0.5">Assigned to</p>
                      <p className="text-xs text-slate-300">{ticket.assignee}</p>
                    </div>
                  )}
                </div>
                {ticket.components.length > 0 && (
                  <div className="bg-[#0d1117] rounded-lg px-3 py-2.5">
                    <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-0.5">Components</p>
                    <p className="text-xs text-slate-300">{ticket.components.join(', ')}</p>
                  </div>
                )}
                {ticket.description && (
                  <div className="bg-[#0d1117] rounded-lg px-3 py-2.5">
                    <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">Description</p>
                    <p className="text-xs text-slate-400 leading-relaxed line-clamp-6">{ticket.description}</p>
                  </div>
                )}
                {ticket.comments.length > 0 && (
                  <div className="bg-[#0d1117] rounded-lg px-3 py-2.5">
                    <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-0.5">Comments</p>
                    <p className="text-xs text-slate-300">{ticket.comments.length} comment(s) included in prompt</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Generated prompt */}
        {prompt && step === 'done' && (
          <div className="animate-fade-in animate-delay-100 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Generated prompt</p>
              <span className="text-xs text-slate-600 tabular-nums bg-white/4 px-2 py-0.5 rounded-md">{prompt.length.toLocaleString()} chars</span>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-white/8 p-4 max-h-56 overflow-y-auto scrollbar-thin">
              <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{prompt}</pre>
            </div>
            <button
              onClick={copyPrompt}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-semibold transition-all border',
                copied
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 scale-[0.99]'
                  : 'bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white border-violet-400/30 shadow-lg shadow-violet-900/50 hover:scale-[1.01] active:scale-[0.99]'
              )}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied!' : 'Copy prompt'}
            </button>
          </div>
        )}

        {/* Attachments */}
        {ticket && ticket.attachments.length > 0 && step === 'done' && (
          <div className="animate-fade-in animate-delay-200 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon size={13} className="text-violet-400" />
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Attachments</p>
                <span className="text-xs font-semibold text-violet-400 bg-violet-500/15 px-2 py-0.5 rounded-full border border-violet-500/25">
                  {ticket.attachments.length}
                </span>
              </div>
              {ticket.attachments.some(a => a.isImage) && (
                <span className="text-[11px] text-slate-600">
                  {ticket.attachments.some(a => a.isImage && a.base64)
                    ? 'Included when copying prompt'
                    : 'Loading images...'}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ticket.attachments.map((a, i) => (
                <div
                  key={a.url}
                  className="animate-fade-in bg-[#161b22] rounded-xl border border-white/8 overflow-hidden flex flex-col"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  {a.isImage ? (
                    a.base64 ? (
                      <img
                        src={a.base64}
                        alt={a.filename}
                        onClick={() => setPreviewAttachment(a)}
                        className="w-full h-32 object-cover bg-[#0d1117] cursor-zoom-in hover:brightness-110 transition-all"
                      />
                    ) : (
                      <div className="skeleton h-32 w-full" />
                    )
                  ) : (
                    <div className="flex items-center justify-center h-14 bg-[#0d1117]">
                      <ExternalLink size={18} className="text-slate-700" />
                    </div>
                  )}
                  <div className="flex items-center justify-between px-2.5 py-2 border-t border-white/8 gap-2">
                    <span className="text-[11px] text-slate-400 truncate font-medium">{a.filename}</span>
                    <button
                      onClick={() => a.isImage ? copyImage(a) : chrome.tabs.create({ url: a.url, active: false })}
                      title={a.isImage ? (a.base64 ? 'Copy image' : 'Open image') : 'Open file'}
                      className={clsx(
                        'flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-all border shrink-0 hover:scale-105 active:scale-95',
                        copiedImageIdx === a.url
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : 'bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 border-violet-500/30'
                      )}
                    >
                      {copiedImageIdx === a.url
                        ? <><Check size={11} /> OK</>
                        : a.isImage && a.base64
                          ? <><Copy size={11} /> Copy</>
                          : <><ExternalLink size={11} /> Open</>
                      }
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Image preview modal */}
      {previewAttachment && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in-fast"
          onClick={() => setPreviewAttachment(null)}
        >
          <div
            className="relative max-w-[640px] max-h-[520px] mx-4 animate-fade-in"
            onClick={e => e.stopPropagation()}
          >
            <img
              src={previewAttachment.base64!}
              alt={previewAttachment.filename}
              className="max-w-full max-h-[460px] object-contain rounded-xl shadow-2xl ring-1 ring-white/10"
            />
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-2 bg-black/60 rounded-b-xl backdrop-blur-sm">
              <span className="text-xs text-slate-300 truncate font-medium">{previewAttachment.filename}</span>
              <button
                onClick={() => setPreviewAttachment(null)}
                className="ml-2 p-1 text-slate-400 hover:text-white hover:bg-white/10 rounded-md transition-all shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
