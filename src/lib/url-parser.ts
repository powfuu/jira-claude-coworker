export interface ParsedJiraUrl {
  baseUrl: string
  ticketKey: string
}

export function parseJiraUrl(input: string): ParsedJiraUrl | null {
  const ticketKeyPattern = /([A-Z][A-Z0-9_]+-\d+)/

  try {
    const url = new URL(input)
    const ticketMatch = url.pathname.match(ticketKeyPattern)
      ?? url.searchParams.get('selectedIssue')?.match(ticketKeyPattern)
    if (!ticketMatch) return null
    return {
      baseUrl: url.origin,
      ticketKey: ticketMatch[1],
    }
  } catch {
    return null
  }
}

export function parseJiraInput(input: string, fallbackBaseUrl?: string): ParsedJiraUrl | null {
  const trimmed = input.trim()

  const fromUrl = parseJiraUrl(trimmed)
  if (fromUrl) return fromUrl

  const keyMatch = trimmed.match(/^([A-Z][A-Z0-9_]+-\d+)$/)
  if (keyMatch && fallbackBaseUrl) {
    return { baseUrl: fallbackBaseUrl.replace(/\/$/, ''), ticketKey: keyMatch[1] }
  }

  return null
}
