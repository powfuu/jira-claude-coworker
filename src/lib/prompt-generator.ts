import type { JiraTicket, JiraAttachment, IssueType } from './types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function attachmentRef(a: JiraAttachment): string {
  return a.isImage
    ? `📎 [image] ${a.filename}`
    : `📎 [file]  ${a.filename} (${a.mimeType})`
}

// ─── Ticket context block ────────────────────────────────────────────────────

function buildTicketContext(ticket: JiraTicket): string {
  const lines: string[] = []

  // ── Header ──
  lines.push(`# Ticket ${ticket.key}: ${ticket.summary}`)
  lines.push('')

  // ── Metadata table ──
  lines.push('## Metadata')
  lines.push('')
  lines.push(`| Field       | Value |`)
  lines.push(`|-------------|-------|`)
  lines.push(`| Type        | ${ticket.issueType} |`)
  lines.push(`| Status      | ${ticket.status} |`)
  lines.push(`| Priority    | ${ticket.priority} |`)
  if (ticket.assignee) lines.push(`| Assignee    | ${ticket.assignee} |`)
  if (ticket.reporter) lines.push(`| Reporter    | ${ticket.reporter} |`)
  if (ticket.components.length > 0) lines.push(`| Components  | ${ticket.components.join(', ')} |`)
  if (ticket.fixVersions.length > 0) lines.push(`| Fix Version | ${ticket.fixVersions.join(', ')} |`)
  if (ticket.labels.length > 0) lines.push(`| Labels      | ${ticket.labels.join(', ')} |`)
  lines.push(`| URL         | ${ticket.url} |`)
  lines.push('')

  // ── Description ──
  if (ticket.description) {
    lines.push('## Description')
    lines.push('')
    lines.push(ticket.description)
    lines.push('')
  }

  // ── Acceptance Criteria ──
  if (ticket.acceptanceCriteria) {
    lines.push('## Acceptance Criteria')
    lines.push('')
    lines.push(ticket.acceptanceCriteria)
    lines.push('')
  }

  // ── Attachments (ticket-level) ──
  if (ticket.attachments.length > 0) {
    lines.push('## Attachments')
    lines.push('')
    const images = ticket.attachments.filter(a => a.isImage)
    const files = ticket.attachments.filter(a => !a.isImage)

    if (images.length > 0) {
      lines.push(`${images.length} image(s) are attached to this ticket and included alongside this prompt.`)
      images.forEach(a => lines.push(`  ${attachmentRef(a)}`))
    }
    if (files.length > 0) {
      lines.push(`${files.length} non-image file(s) attached:`)
      files.forEach(a => lines.push(`  ${attachmentRef(a)}`))
    }
    lines.push('')
  }

  // ── Comments ──
  if (ticket.comments.length > 0) {
    lines.push('## Discussion')
    lines.push('')
    lines.push(`${ticket.comments.length} comment(s) in chronological order:`)
    lines.push('')

    ticket.comments.forEach((c, i) => {
      lines.push(`### Comment ${i + 1} — ${c.author} (${formatDate(c.created)})`)
      lines.push('')
      lines.push(c.body || '*(no text)*')

      if (c.attachmentIds.length > 0) {
        lines.push('')
        lines.push('*Attachments in this comment:*')
        c.attachmentIds.forEach(id => {
          const att = ticket.attachments.find(a => a.id === id)
          if (att) lines.push(`  ${attachmentRef(att)}`)
        })
      }
      lines.push('')
    })
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function getBugPrompt(ticket: JiraTicket): string {
  return `You are a senior software engineer assigned to diagnose and fix a production bug.

${buildTicketContext(ticket)}

---

## Your Task

Work through this bug systematically:

1. **Root cause analysis** — Based on the description, error messages, screenshots, and discussion above, identify the most likely root cause(s). Reason step by step; do not jump to conclusions.

2. **Affected scope** — List the specific files, modules, classes, or functions most likely involved. Be precise.

3. **Fix** — Provide the concrete code change(s) needed. Show clear before/after diffs. If multiple approaches exist, explain the tradeoffs and recommend one.

4. **Regression risk** — Identify any related areas that could break. Suggest what to verify after applying the fix.

5. **Verification** — Describe a minimal test case or manual steps to confirm the fix works. Propose a unit or integration test if appropriate.

If the information above is insufficient to diagnose the root cause, specify exactly what additional data is needed (log lines, stack traces, environment details, reproduction steps) and why.

Prioritize correctness and minimal footprint. Avoid unrelated cleanup in the same change.`
}

function getStoryPrompt(ticket: JiraTicket): string {
  return `You are a senior software engineer implementing a new feature.

${buildTicketContext(ticket)}

---

## Your Task

Deliver a complete, production-ready implementation:

1. **Implementation plan** — Before writing code, outline the changes required: which files to create or modify, the data flow, and any new abstractions needed. Keep it concise.

2. **Implementation** — Write the code. Follow the existing patterns, naming conventions, and architecture evident from the context. Address every acceptance criterion explicitly.

3. **Edge cases & error handling** — Enumerate the failure modes and how your implementation handles them. Do not add speculative error handling for impossible states.

4. **Tests** — Propose or write unit and/or integration tests that cover the happy path and the most important edge cases.

5. **Migration / backward compatibility** — If the change touches APIs, data models, or public interfaces, describe any migration steps or compatibility considerations.

When in doubt about intent, interpret the acceptance criteria literally. If a criterion is ambiguous, flag it and make a reasonable default choice.`
}

function getTaskPrompt(ticket: JiraTicket): string {
  return `You are a senior software engineer completing a technical task.

${buildTicketContext(ticket)}

---

## Your Task

1. **Understand the goal** — Restate in one sentence what this task requires and what "done" looks like.

2. **Plan** — List the concrete steps to complete it, in order. Identify any dependencies or blockers upfront.

3. **Execute** — Implement the changes. Be precise and complete; do not leave TODOs or placeholders.

4. **Verification** — Describe how to confirm the task is fully complete (tests, manual checks, metrics).

For refactors: preserve all existing behavior exactly. If you cannot guarantee behavioral equivalence, call it out explicitly.
For configuration or infrastructure tasks: double-check defaults, environment parity, and rollback path.`
}

function getEpicPrompt(ticket: JiraTicket): string {
  return `You are a senior software engineer planning a large initiative.

${buildTicketContext(ticket)}

---

## Your Task

Produce a structured technical breakdown ready to hand off to a team:

1. **Technical summary** — In 2–3 sentences, describe what this epic delivers and why it matters.

2. **Sub-tasks** — Break the epic into concrete, independently deliverable tasks. For each:
   - Title
   - What it entails (1–3 sentences)
   - Relative size: S / M / L
   - Dependencies on other sub-tasks (if any)

3. **Sequencing** — Propose an implementation order that minimizes blocked work and allows early feedback.

4. **Risks & unknowns** — List technical risks, architectural decisions that need resolution before work starts, and any external dependencies (third-party APIs, data migrations, infra changes).

5. **High-level design** — Sketch the key components, their responsibilities, and how they interact. Use plain text or ASCII diagrams.

Flag anything that requires a design review, security review, or stakeholder decision before proceeding.`
}

// ─── Export ───────────────────────────────────────────────────────────────────

const promptBuilders: Record<IssueType, (t: JiraTicket) => string> = {
  Bug: getBugPrompt,
  Story: getStoryPrompt,
  Task: getTaskPrompt,
  Epic: getEpicPrompt,
  'Sub-task': getTaskPrompt,
  Unknown: getTaskPrompt,
}

export function generatePrompt(ticket: JiraTicket): string {
  const builder = promptBuilders[ticket.issueType] ?? promptBuilders['Unknown']
  return builder(ticket)
}
