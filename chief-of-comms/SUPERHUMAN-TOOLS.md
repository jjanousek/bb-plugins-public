# What Superhuman actually advertises

Read from the live MCP server at https://mcp.mail.superhuman.com/mcp in 2026,
with an account connected, through an MCP `tools/list` call. Repeat that call
to refresh this file, and put the date on it when you do.

`test/superhuman.test.ts` checks every tool name `superhuman.ts` calls against
the list at the bottom, so this file is what keeps the comms client honest.

This file exists because Superhuman publishes tool NAMES in its help centre and
not parameter schemas. The client uses the names and arguments recorded here,
not guesses: for example there is no `get_read_statuses` tool, and `send_draft`
accepts neither a recipient nor a body.

33 tools. A star marks a required argument.

## The ones this plugin calls

### create_or_update_draft

Compose an email on behalf of the user. Uses the user's writing style, tone, and personalization to produce a polished draft. Returns the composed email — use send_draft separately to send it. The draft is saved to the user's Superhuman Mail Drafts list. The response includes a draft object with draft_id and thread_id — pass draft_id to send_draft to send the email. To update an existing draft (e.g. after user feedback), pass the previous draft_id and thread_id — the existing draft's content (recipients, subject, body) is loaded so the writer can revise it based on your instructions rather than composing from scratch. The draft will be updated in place instead of creating a duplicate. Forward drafts are a temporary exception: use body, not instructions, and provide only your intro text — the server appends the forwarded message automatically.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `bcc` | array | BCC recipients email |
| `body` | string | Email body in HTML format. Use this as a fallback to directly create a draft with the exact text provided, bypassing the AI writer. When body is pr... |
| `cc` | array | CC recipients email |
| `draft_id` | string | Draft ID from a previous create_or_update_draft response. When provided with thread_id, the existing draft's content is loaded as context for revis... |
| `from` | string | Email address to send from. Must be one of the user's verified aliases. When omitted, reply drafts prefer the alias that matches the original messa... |
| `instructions` | string | What the email should say or accomplish — e.g. 'thank Sarah for the update and ask about next steps'. This is the preferred way to compose emails: ... |
| `message_id` | string | Message ID within a thread to reply to. When omitted, replies to the last message in the thread. |
| `subject` | string | Email subject line (optional — will be auto-generated if not provided) |
| `thread_id` | string | Thread ID for replies/forwards, or the draft's thread_id when updating an existing draft. |
| `to` | array | Recipient emails. If omitted may be auto-resolved or asked in clarification. |
| `type`* | string ["new", "forward", "reply", "reply_all"] | The kind of email to compose. |

### send_draft

Send an existing Superhuman Mail draft. Pass draft_id from create_or_update_draft. Optionally use smart_send to schedule at the best engagement time, send_at to schedule at a specific time, or undo_timeout to delay sending by up to 10 minutes so the send can be cancelled via undo_send. When no scheduling option is provided, send_draft applies a default 1-minute undo-send delay. Note: after sending, the message may take up to a minute to appear in search results or thread listings.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `draft_id`* | string | Draft ID returned by create_or_update_draft. |
| `send_at` | string | RFC3339 datetime to schedule the send. Must be in the future. Mutually exclusive with smart_send and undo_timeout. |
| `smart_send` | boolean | When true, schedules the email at the optimal send time based on recipient engagement data. Mutually exclusive with send_at and undo_timeout. |
| `undo_timeout` | integer | Number of minutes (1–10) to delay the send, allowing cancellation via undo_send. Returns undo_token and undo_expires_at. When omitted, send_draft u... |

### get_draft

Fetch a single Superhuman Mail draft by draft_id, including its full body and quoted content. Use list_drafts to discover draft_ids.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `draft_id`* | string | Draft ID, e.g. from list_drafts or create_or_update_draft. |

### discard_draft

Discard a user-owned Superhuman Mail draft by draft_id so it disappears from the user's Drafts list.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `draft_id`* | string | Draft ID returned by draft_email. |

### get_draft_send_status

Read-only check of a Superhuman Mail draft's send state. Returns idle (no send queued, or a prior send failed/was aborted and the draft is sendable again), pending (send queued, undo window still open — includes undo_token), or closed (delivery underway past the undo window, delivered, or draft discarded). Intended for the compose widget to poll so it can reflect sends initiated elsewhere; agents should prefer undo_send for cancellation.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `draft_id`* | string | Draft ID returned by create_or_update_draft. |
| `thread_id` | string | Thread ID returned by create_or_update_draft. Pass it to skip a lookup on this frequently-polled tool. |

### get_read_status_feed

Get a feed of read receipts for emails you've sent — who opened them, when, and on what device. Returns events newest first. By default scans the last 14 days of sent mail (up to 500 messages) and returns read events from the last 24 hours.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `cursor` | string | Opaque pagination cursor from a previous response's next_cursor. |
| `limit` | integer | Max events to return (default 50, max 200). |
| `since` | string | ISO 8601 datetime. Only reads that occurred at or after this time are returned. Defaults to 24 hours ago. |
| `thread_id` | string | If set, returns read events for the most recent message you sent in this thread instead of the cross-thread feed. |

#### What an event actually looks like

Read off the live feed. The help centre
documents none of this.

```
thread_id, message_id, subject, recipient { email }, occurred_at, device
```

- The time field is `occurred_at`. A client that reads another name gets
  `firstReadAt: null` on every event while still counting it, which renders
  exactly like nobody opening the mail, and `followUpOnlyIfOpened` reads that
  field. Test fixtures must use the same field name as the server.
- It is **per recipient**, not per message. `recipient.email` is on every event.
- Repeat opens are separate events: one message opened several times gives
  several events. A count is opens, not people.

`device` is kept as the server sends it; its full set of values is not
documented.

### get_thread

Fetch a specific email thread by its thread ID. Returns structured message data including bodies, recipients, attachments, and any internal team comments on the thread. Requires a thread_id obtained from query_email_and_calendar or list_threads.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `include_comments` | boolean | Whether to include comments on the thread (default true). |
| `include_drafts` | boolean | Whether to include draft messages (default true). |
| `message_limit` | integer | Max messages to return (default 50, max 100). When the thread is longer, the first message (thread root) and the newest message_limit-1 messages ar... |
| `thread_id`* | string | The thread ID to fetch. |

### list_threads

Search email threads with structured filters. Returns thread metadata with participants, labels, and a snippet of the latest message. Supports pagination for large result sets. No filters returns the most recent threads. Note: recently sent or received messages may take up to a minute to appear in results.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `body_contains` | string | Filter by body substring, case-insensitive. |
| `cursor` | string | Opaque pagination cursor from a previous response's next_cursor. |
| `end_date` | string | Threads with messages on or before this date. ISO 8601 format. |
| `from` | array | Filter by sender email addresses, case-insensitive substring match (OR logic). |
| `has_attachment` | boolean | Filter to threads containing messages with attachments. |
| `is_starred` | boolean | Filter to starred threads (true) or unstarred threads (false). |
| `is_unread` | boolean | Filter to unread threads (true) or read threads (false). |
| `labels` | array | Filter by labels (OR logic). Includes system labels like UNREAD, STARRED, INBOX, SENT, DRAFT. Use list_labels to discover available user-created la... |
| `limit` | integer | Max threads to return (default 25, max 50). |
| `sort` | string ["newest", "oldest"] | Order the returned threads by most recent message date: 'newest' first (default) or 'oldest' first. Applies to the returned page, not the whole mai... |
| `split` | string | Filter to threads belonging to a specific split. Accepts a split name (e.g., 'Important', 'Other', 'GitHub', case-insensitive) or ID from list_spli... |
| `start_date` | string | Threads with messages on or after this date. ISO 8601 format (e.g., '2024-01-01' or '2024-01-01T00:00:00Z'). |
| `subject_contains` | string | Filter by subject substring, case-insensitive. |
| `to` | array | Filter by recipient email addresses in to/cc/bcc, case-insensitive substring match (OR logic). |

### list_accounts

List the Superhuman Mail accounts linked to this session. Each entry has the account email, whether it is the primary (default) account actions run as when no account is specified, and when it was linked.

| argument | type | notes |
| --- | --- | --- |

### undo_send

Check whether a draft was queued for sending and cancel it if so. Call this whenever the user asks to undo, unsend, or cancel ANY draft — sends often happen via the UI without going through chat, so calling this is the only reliable way to know if a draft is still local or has been queued. The tool returns success (canceled), `already_sent` (past the undo window), or 'send not found' (still just a draft, nothing to undo) — all are valid outcomes, so calling this is always safe. Prefer passing the `undo_token` returned by `send_draft` when available, since it is the most specific identifier for canceling that queued send. If the `undo_token` is unavailable, pass the `message_id` from a prior `create_or_update_draft` or `send_draft` tool call instead.

| argument | type | notes |
| --- | --- | --- |
| `acting_email` | string | Optional. Email of the linked account to act as for this call. Omit to use the session's default (primary) account; call list_accounts to see linke... |
| `message_id` | string | message_id returned by send_draft. Alternative to undo_token when the token is unavailable. |
| `undo_token` | string | Token returned by send_draft when undo_timeout was set. Cancels the send. |

## Every tool advertised, for reference

- `add_account`: (none advertised)
- `create_or_update_draft`: acting_email, bcc, body, cc, draft_id, from, instructions, message_id, subject, thread_id, to, type*
- `create_or_update_event`: acting_email, attendees, calendar_id, conference, description, end*, event_id, is_all_day, location, recurrence, reminders, start*, timezone*, title*
- `create_or_update_reminder`: acting_email, mark_done, remind_at*, thread_id*
- `create_or_update_snippet`: acting_email, bcc, body*, cc, id, name*, shared, subject, to
- `discard_draft`: acting_email, draft_id*
- `discard_reminder`: acting_email, reminder_id*, thread_id*
- `discard_snippet`: acting_email, id*
- `get_attachment`: acting_email, attachment_name, message_id*
- `get_availability`: acting_email, duration_minutes, end_date*, participants*, start_date*, timezone, working_hours_only
- `get_draft`: acting_email, draft_id*
- `get_draft_send_status`: acting_email, draft_id*, thread_id
- `get_message`: acting_email, include_raw_html, message_id*
- `get_read_status_feed`: acting_email, cursor, limit, since, thread_id
- `get_snippet`: acting_email, id*
- `get_thread`: acting_email, include_comments, include_drafts, message_limit, thread_id*
- `list_accounts`: (none advertised)
- `list_drafts`: acting_email, cursor, limit, thread_id
- `list_labels`: acting_email
- `list_reminders`: acting_email, limit, since, status
- `list_snippets`: acting_email, include_team, query, shared_by
- `list_splits`: acting_email
- `list_threads`: acting_email, body_contains, cursor, end_date, from, has_attachment, is_starred, is_unread, labels, limit, sort, split, start_date, subject_contains, to
- `mark_spam`: acting_email, also_block_domain, also_block_sender, also_trash, thread_id*
- `query_email_and_calendar`: acting_email, question*
- `remove_account`: account_email*
- `send_draft`: acting_email, draft_id*, send_at, smart_send, undo_timeout
- `set_default_account`: account_email*
- `trash_thread`: acting_email, thread_id*
- `undo_send`: acting_email, message_id, undo_token
- `unsubscribe`: acting_email, also_block, also_domain, also_trash, thread_id*
- `update_personalization`: acting_email, feedback*
- `update_thread`: acting_email, add_labels, last_message_id*, mark_done, mark_important, mark_read, mark_starred, move_to_folder, remove_labels, thread_id*

## Things worth knowing that are not obvious from the names

- `send_draft` takes the draft id and nothing else about the message. The from
  address, the recipient, the subject and the body all come from the draft, so
  `create_or_update_draft` is where they are set and where a wrong from address
  would be introduced.
- `create_or_update_draft` requires `type`, one of new, forward, reply or
  reply_all. It also takes `instructions`, which asks Superhuman to WRITE the
  email. This plugin never uses that: the text is written by our own writer
  against the owner's voice rules and checked by the guard, so we always pass
  `body` and let nothing else compose.
- `from` must be one of the account's verified aliases, so an address set up
  as a send-as alias on the connected account can be the from address.
- `send_draft` applies a default one minute undo delay when no scheduling option
  is passed. So a message recorded as sent is genuinely cancellable for a minute
  afterwards through `undo_send`.
- `get_draft_send_status` returns idle, pending or closed. Only `idle` means the
  draft is safely unsent, and it covers a send that failed or was aborted.
  `closed` covers delivered AND discarded, so it is not proof of delivery.
- `get_read_status_feed` is a feed, not a lookup. With `thread_id` it returns the
  read events for the most recent message we sent in that thread. It defaults to
  the last 24 hours, so `since` matters for anything older.
- `mark_spam` exists and mutates a stranger's mail, so it belongs in the send
  tripwire even though this plugin never calls it.

