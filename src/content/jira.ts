import type { JiraTicket, JiraComment, JiraAttachment } from '@/lib/types'

// ─── ADF → Markdown ──────────────────────────────────────────────────────────

type AdfNode = {
  type: string
  text?: string
  content?: AdfNode[]
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

function adfToMarkdown(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as AdfNode

  switch (n.type) {
    case 'doc':
      return (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join('\n\n').trim()

    case 'paragraph': {
      const text = (n.content || []).map(c => adfToMarkdown(c, depth)).join('')
      return text.trim()
    }

    case 'text': {
      let text = n.text || ''
      if (n.marks) {
        for (const mark of n.marks) {
          if (mark.type === 'strong') text = `**${text}**`
          else if (mark.type === 'em') text = `_${text}_`
          else if (mark.type === 'code') text = `\`${text}\``
          else if (mark.type === 'strike') text = `~~${text}~~`
          else if (mark.type === 'link') {
            const href = mark.attrs?.href as string || ''
            text = `[${text}](${href})`
          }
        }
      }
      return text
    }

    case 'hardBreak':
      return '\n'

    case 'heading': {
      const level = (n.attrs?.level as number) || 1
      const prefix = '#'.repeat(Math.min(level, 6))
      const text = (n.content || []).map(c => adfToMarkdown(c, depth)).join('')
      return `${prefix} ${text.trim()}`
    }

    case 'bulletList':
      return (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join('\n')

    case 'orderedList': {
      let i = (n.attrs?.order as number) || 1
      return (n.content || []).map(c => {
        const text = adfToMarkdown(c, depth + 1)
        return text.replace(/^•\s/, `${i++}. `)
      }).filter(Boolean).join('\n')
    }

    case 'listItem': {
      const indent = '  '.repeat(depth)
      const inner = (n.content || []).map(c => adfToMarkdown(c, depth + 1)).filter(Boolean).join('\n')
      return inner.split('\n').map((line, i) => i === 0 ? `${indent}• ${line}` : `${indent}  ${line}`).join('\n')
    }

    case 'codeBlock': {
      const lang = (n.attrs?.language as string) || ''
      const code = (n.content || []).map(c => c.text || '').join('')
      return `\`\`\`${lang}\n${code}\n\`\`\``
    }

    case 'blockquote': {
      const inner = (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join('\n')
      return inner.split('\n').map(l => `> ${l}`).join('\n')
    }

    case 'rule':
      return '---'

    case 'table': {
      const rows = (n.content || []).filter(c => c.type === 'tableRow')
      if (rows.length === 0) return ''
      const renderRow = (row: AdfNode) =>
        '| ' + (row.content || []).map(cell =>
          (cell.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join(' ').replace(/\n/g, ' ').trim()
        ).join(' | ') + ' |'
      const header = renderRow(rows[0])
      const separator = '| ' + (rows[0].content || []).map(() => '---').join(' | ') + ' |'
      const body = rows.slice(1).map(renderRow)
      return [header, separator, ...body].join('\n')
    }

    case 'tableRow':
    case 'tableCell':
    case 'tableHeader':
      return (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join(' ')

    case 'mention': {
      const name = (n.attrs?.text as string) || (n.attrs?.id as string) || 'someone'
      return `@${name}`
    }

    case 'emoji': {
      const text = (n.attrs?.text as string) || (n.attrs?.shortName as string) || ''
      return text
    }

    case 'inlineCard':
    case 'blockCard': {
      const url = (n.attrs?.url as string) || ''
      return url ? `[${url}](${url})` : ''
    }

    case 'media': {
      // Returns the attachment ID so we can cross-reference
      const id = (n.attrs?.id as string) || ''
      const filename = (n.attrs?.alt as string) || (n.attrs?.filename as string) || id
      return id ? `[attachment:${id}:${filename}]` : ''
    }

    case 'mediaGroup':
    case 'mediaSingle':
      return (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join('\n')

    case 'panel': {
      const panelType = (n.attrs?.panelType as string) || 'info'
      const inner = (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join('\n')
      return `> **[${panelType.toUpperCase()}]**\n${inner.split('\n').map(l => `> ${l}`).join('\n')}`
    }

    case 'expand': {
      const title = (n.attrs?.title as string) || 'Details'
      const inner = (n.content || []).map(c => adfToMarkdown(c, depth)).filter(Boolean).join('\n')
      return `**${title}**\n${inner}`
    }

    default:
      // Fallback: recurse into content
      if (Array.isArray(n.content)) {
        return n.content.map(c => adfToMarkdown(c, depth)).filter(Boolean).join(' ')
      }
      return n.text || ''
  }
}

function parseBody(body: unknown): { text: string; attachmentIds: string[] } {
  if (!body) return { text: '', attachmentIds: [] }
  if (typeof body === 'string') return { text: body, attachmentIds: [] }

  const markdown = adfToMarkdown(body)

  // Extract attachment IDs from [attachment:ID:filename] tokens
  const attachmentIds: string[] = []
  const cleaned = markdown.replace(/\[attachment:([^:]+):([^\]]*)\]/g, (_match, id) => {
    attachmentIds.push(id)
    return '' // will be substituted with filename by caller
  }).replace(/\n{3,}/g, '\n\n').trim()

  return { text: cleaned, attachmentIds }
}

// ─── Acceptance criteria ─────────────────────────────────────────────────────

function extractAcceptanceCriteria(description: string, fields: Record<string, unknown>): string {
  // Check dedicated custom fields first
  const acKeys = Object.keys(fields).filter(k => {
    const lower = k.toLowerCase()
    return lower.includes('acceptance') || lower.includes('criteria') || lower.includes('ac_')
  })
  for (const key of acKeys) {
    const val = fields[key]
    if (!val) continue
    if (typeof val === 'string' && val.trim()) return val.trim()
    if (typeof val === 'object') {
      const { text } = parseBody(val)
      if (text) return text
    }
  }

  // Extract from description text
  const match = description.match(
    /(?:acceptance criteria|ac)[:\s]*\n([\s\S]*?)(?:\n#{1,3}\s|\n\*\*[A-Z]|\Z)/i
  )
  return match ? match[1].trim() : ''
}

// ─── Attachments ─────────────────────────────────────────────────────────────

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
  'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff',
])

async function fetchAllAttachments(
  rawAttachments: Record<string, unknown>[]
): Promise<JiraAttachment[]> {
  return rawAttachments.map(a => {
    const mimeType = ((a.mimeType as string) || '').toLowerCase()
    const isImage = IMAGE_MIME_TYPES.has(mimeType)
    const url = (a.content as string) || ''
    return {
      id: (a.id as string) || '',
      filename: (a.filename as string) || 'attachment',
      mimeType,
      url,
      base64: null,
      isImage,
    }
  })
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchTicket(ticketKey: string, baseUrl: string): Promise<JiraTicket> {
  const res = await fetch(
    `${baseUrl}/rest/api/2/issue/${ticketKey}?expand=renderedFields,names`,
    { credentials: 'include' }
  )
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${res.statusText}`)
  const data = await res.json()

  const fields = data.fields as Record<string, unknown>

  const { text: description } = parseBody(fields.description)

  // Fetch ALL comments (paginate if needed)
  const commentsRes = await fetch(
    `${baseUrl}/rest/api/2/issue/${ticketKey}/comment?maxResults=50&orderBy=created`,
    { credentials: 'include' }
  )
  let rawComments: Record<string, unknown>[] = []
  if (commentsRes.ok) {
    const cd = await commentsRes.json()
    rawComments = (cd.comments as Record<string, unknown>[]) || []
  }

  // Fetch attachments (all, not just images)
  const rawAttachments = Array.isArray(fields.attachment)
    ? (fields.attachment as Record<string, unknown>[])
    : []
  const attachments = await fetchAllAttachments(rawAttachments)

  // Build attachment lookup by ID for comment cross-referencing
  const attachmentById = new Map(attachments.map(a => [a.id, a]))

  const comments: JiraComment[] = rawComments.map(c => {
    const { text: body, attachmentIds } = parseBody(c.body)
    const author = c.author as Record<string, unknown>
    return {
      author: (author?.displayName as string) || 'Unknown',
      created: (c.created as string) || '',
      body,
      attachmentIds: attachmentIds.filter(id => attachmentById.has(id)),
    }
  })

  const issueTypeField = fields.issuetype as Record<string, unknown>
  const priorityField = fields.priority as Record<string, unknown>
  const statusField = fields.status as Record<string, unknown>
  const assigneeField = fields.assignee as Record<string, unknown> | null
  const reporterField = fields.reporter as Record<string, unknown>

  const components = ((fields.components as Record<string, unknown>[]) || [])
    .map(c => (c.name as string) || '').filter(Boolean)

  const fixVersions = ((fields.fixVersions as Record<string, unknown>[]) || [])
    .map(v => (v.name as string) || '').filter(Boolean)

  return {
    key: data.key as string,
    summary: (fields.summary as string) || '',
    description,
    issueType: ((issueTypeField?.name as string) || 'Unknown') as JiraTicket['issueType'],
    priority: (priorityField?.name as string) || 'Medium',
    status: (statusField?.name as string) || '',
    assignee: assigneeField ? (assigneeField.displayName as string) : null,
    reporter: (reporterField?.displayName as string) || null,
    labels: (fields.labels as string[]) || [],
    components,
    fixVersions,
    acceptanceCriteria: extractAcceptanceCriteria(description, fields),
    comments,
    attachments,
    url: `${baseUrl}/browse/${data.key}`,
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FETCH_JIRA_TICKET') return false

  fetchTicket(message.ticketKey, message.jiraBaseUrl)
    .then(data => sendResponse({ type: 'JIRA_TICKET_RESULT', data }))
    .catch(err => sendResponse({ type: 'JIRA_TICKET_RESULT', data: null, error: err.message }))

  return true
})
