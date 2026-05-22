export type IssueType = 'Bug' | 'Story' | 'Task' | 'Epic' | 'Sub-task' | 'Unknown'

export interface JiraAttachment {
  id: string
  filename: string
  mimeType: string
  url: string
  base64: string | null
  isImage: boolean
}

export interface JiraComment {
  author: string
  created: string
  body: string
  attachmentIds: string[]  // references to ticket-level attachments embedded in this comment
}

export interface JiraTicket {
  key: string
  summary: string
  description: string
  issueType: IssueType
  priority: string
  status: string
  assignee: string | null
  reporter: string | null
  labels: string[]
  components: string[]
  fixVersions: string[]
  acceptanceCriteria: string
  comments: JiraComment[]
  attachments: JiraAttachment[]
  url: string
}

export interface AnalysisResult {
  ticket: JiraTicket | null
  error?: string
}

export type MessageType =
  | { type: 'FETCH_JIRA_TICKET'; ticketKey: string; jiraBaseUrl: string }
  | { type: 'JIRA_TICKET_RESULT'; data: JiraTicket | null; error?: string }
