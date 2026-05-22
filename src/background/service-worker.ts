// Service worker: handles tab injection and auto-popup on Jira ticket navigation

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'INJECT_AND_FETCH') {
    handleInjectAndFetch(message).then(sendResponse).catch(err =>
      sendResponse({ error: err.message })
    )
    return true
  }
})

// Auto-open popup when user navigates to a Jira ticket
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  const url = tab.url || ''
  if (!isJiraTicketUrl(url)) return

  // Set badge to signal there's a Jira ticket ready
  chrome.action.setBadgeText({ text: '●', tabId })
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId })

  // Try to open popup automatically (Chrome 127+, requires activeTab)
  // Falls back silently if not supported or tab not active
  tryOpenPopup(tabId)
})

// Clear badge when leaving Jira ticket
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab?.url || !isJiraTicketUrl(tab.url)) {
    chrome.action.setBadgeText({ text: '', tabId })
  }
})

// Ticket key pattern: PROJECT-123
const TICKET_KEY_RE = /[A-Z][A-Z0-9_]+-\d+/

function isJiraTicketUrl(url: string): boolean {
  if (!url.includes('atlassian.net')) return false

  try {
    const parsed = new URL(url)
    // Classic: /browse/PROJ-123
    if (/\/browse\/[A-Z][A-Z0-9_]+-\d+/.test(parsed.pathname)) return true
    // Board with ticket selected: ?selectedIssue=PROJ-123
    const selected = parsed.searchParams.get('selectedIssue')
    if (selected && TICKET_KEY_RE.test(selected)) return true
    // Issue detail view: /issues/PROJ-123
    if (/\/issues\/[A-Z][A-Z0-9_]+-\d+/.test(parsed.pathname)) return true
    return false
  } catch {
    return false
  }
}

async function tryOpenPopup(tabId: number) {
  // Only attempt if the tab is currently active
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (activeTab?.id !== tabId) return

  try {
    // @ts-ignore — available in Chrome 127+
    await chrome.action.openPopup()
  } catch {
    // Not supported or tab not focused — badge is sufficient
  }
}

async function handleInjectAndFetch(message: {
  type: string
  tabId?: number
  targetUrl: string
  contentScript: string
  fetchMessage: Record<string, unknown>
}): Promise<unknown> {
  let tabId = message.tabId

  if (!tabId) {
    const tab = await chrome.tabs.create({ url: message.targetUrl, active: false })
    tabId = tab.id!

    await new Promise<void>(resolve => {
      chrome.tabs.onUpdated.addListener(function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener)
          resolve()
        }
      })
    })
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [message.contentScript],
  })

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId!, message.fetchMessage, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response)
      }
    })
  })
}
