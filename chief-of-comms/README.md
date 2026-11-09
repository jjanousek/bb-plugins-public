# bb-plugin-chief-of-comms

A bb plugin that runs your inbound mail and WhatsApp as one inbox of
conversations, with one long-lived "Chief of Communications" agent thread that
drafts replies. A conversation is a Gmail thread (work or personal account) or
a WhatsApp chat, and it has at most one pending draft. Agents only draft; a
message is sent only when you press **Send** in the Comms panel (or run the
send commands in your own terminal).

## What it needs

- bb `>=0.40` and plugin SDK `>=0.4.21` (see `package.json`).
- **Gmail through a `gw` command line tool.** All Gmail reads and drafts go
  through a CLI named in the `gwCommand` setting. It must own the Google OAuth
  tokens and support these subcommands: `gmail search`, `gmail read`,
  `gmail thread <threadId>`, `gmail draft [--reply-to <messageId>]`,
  `gmail draft-get`, `gmail draft-update <draftId> --body -`,
  `gmail draft-delete`, `gmail drafts`, `gmail labels` and `gmail send-draft`,
  with JSON output. This tool is part of the original author's own setup and is
  not in this repo. Without a compatible `gw`, the mail half does not work; the
  WhatsApp half still does.
- **Two Gmail accounts**, called `work` and `personal`. Set their addresses in
  `workEmail` and `personalEmail`. The plugin passes `--account work` or
  `--account personal` to `gw`; if your `gw` knows the accounts under other
  labels, set them in `gwWorkAccount` and `gwPersonalAccount`.
- **Superhuman (optional).** With `mailSendVia = superhuman` (the default), work
  mail is sent through Superhuman's MCP server so it carries read receipts and
  an undo window. You sign in once from the panel (OAuth). Set `mailSendVia` to
  `gmail` if you do not use Superhuman. "Needs reply" also reads Superhuman's
  AI labels on Gmail when they are there.
- **WhatsApp**: a phone to link as a device (Baileys, the unofficial WhatsApp
  Web protocol).
- **A drafting-style skill named `unslop` (optional, third-party)**, installed
  as a user skill (`~/.bb/skills/unslop`). Any drafting-style skill of that
  name works; none is shipped here. When it is installed, every draft request
  tells the agent to run it before saving. When it is not, the agent skips that
  step and applies only the voice rules.

## Install

From a checkout of this repo:

```sh
cd chief-of-comms
npm ci --ignore-scripts
bb plugin install "$PWD" --yes
```

Then open **Comms** in the sidebar:

1. Press **Start Chief of Communications** (or run `bb comms start`).
2. In **Connections**, scan the WhatsApp QR code with your phone (WhatsApp,
   Settings, Linked devices, Link a device). The session is kept under
   `~/.bb/plugins/chief-of-comms/whatsapp-auth/` (mode 0700).
3. Set `gwCommand`, `workEmail` and `personalEmail` in the plugin settings.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `chiefProject` | personal project | Where the chief thread lives |
| `chiefProviderId`, `chiefModel` | project defaults | Provider and model for the chief |
| `gwCommand` | `gw` | How to invoke the Gmail CLI, as a full command line (a wrapper or prefix is allowed) |
| `gwWorkAccount`, `gwPersonalAccount` | `work`, `personal` | The `--account` labels `gw` uses for the two mailboxes |
| `workEmail`, `personalEmail` | `work@example.com`, `personal@example.com` | Own-address detection and Gmail/Superhuman links |
| `mailSyncMinutes` | `3` | Minutes between mail syncs |
| `mailLookbackDays` | `14` | Days of inbox mail the inbox keeps |
| `whatsappEnabled` | true | Run the WhatsApp service (reload after changing) |
| `autoDraft` | `direct` | Ask the chief to draft replies for new WhatsApp messages: off, direct chats, or all including groups |
| `toolsEverywhere` | false | Offer the `comms_*` tools to every thread, not only the chief |
| `mailSendVia` | `superhuman` | Send work mail through Superhuman or straight from the Gmail draft. Personal mail always goes through Gmail |
| `ownAddresses` | empty | Your other addresses; mail from them is your own forward and needs no reply |
| `answerElsewhereTo` | empty | Addresses or `@domain` you answer in another app; kept out of Needs reply |
| `noReplyFrom` | empty | Senders that never need a reply |
| `undoSendMinutes` | `1` | Undo window for work mail sent through Superhuman (1 to 10) |
| `superhumanRedirectBase` | empty | Base URL the Superhuman sign-in returns to; empty uses the public app URL, then loopback |

Times are shown in UTC. The zone is a constant in
`components/comms/format.ts`, `server.ts`, `about.ts`, `voice.ts` and
`superhuman-send.ts`; change it there for another zone. The weekly voice review
runs on Thursday, UTC.

## Conversation keys

| Key | Meaning |
| --- | --- |
| `mail:work:<gmailThreadId>` | Gmail thread in the work mailbox |
| `mail:personal:<gmailThreadId>` | Gmail thread in the personal mailbox |
| `mail:<account>:draft:<draftId>` | A Gmail draft with no thread at all |
| `wa:<jid>` | A WhatsApp chat or group |

A Gmail draft that belongs to a thread uses the thread key. WhatsApp addresses
one contact both as `<digits>@lid` and as `<phone>@s.whatsapp.net`; the plugin
merges the two into one conversation keyed by the phone number.

## The panel

- **Left**: the conversation list, filtered by *Needs reply*, *Ready to send*
  and *All*, with per-channel counts and a search box. Rows have **Dismiss**
  and, when a draft exists, **Discard draft**.
- **Right**: the selected conversation, oldest message first.
- **Reply dock**: edit the pending draft, **Send**, **Save draft**,
  **Discard**, and for mail links into Gmail and Superhuman.
- **Side tabs**: *Chief* (the thread, the About card with the contact's voice
  file and the thread so far), *Activity* (what the plugin did), *Connections* (WhatsApp
  pairing, mail sync state, Superhuman sign-in), *Discarded* (drafts thrown
  away in the last 24 hours, which can be restored).

"Needs reply" uses Superhuman's AI labels where present. Otherwise a thread
needs a reply when the last message is not from you, does not look automated
or bulk (`List-Unsubscribe`, bulk `Precedence`, no-reply senders) and is from
the last 7 days. **Dismiss** hides a conversation until a newer message
arrives. **Ready to send** lists conversations whose pending draft waits for
you.

## How it works

- **Chief thread**: one thread with the `chief-of-comms` skill, the `comms_*`
  tools and standing rules: draft only, never send, use the voice file.
- **Mail sync**: a background service per account every `mailSyncMinutes`
  reads recent inbox mail, your own sent mail, and up to 200 drafts into a
  local SQLite cache, and repairs threads whose last message is a draft.
  Readers answer from the cache and start a refresh when it is stale.
- **WhatsApp** runs in a separate Node worker (`whatsapp-worker.mjs`)
  supervised by the plugin. The worker talks JSON on file descriptor 3 and
  throws away its stdout and stderr, because the Signal library inside Baileys
  prints session keys to the console. Unlink wipes the auth directory, the
  message mirror and downloaded media.
- **WhatsApp media** (up to 25 MB) is downloaded to
  `~/.bb/plugins/chief-of-comms/whatsapp-media/` (mode 0700), shown inline, and
  handed to the chief as file paths.
- **Auto-draft**: new messages in one chat are batched for 90 seconds, then the
  chief gets the recent conversation and is asked to draft (not send) a reply.
- **Voice files**: one markdown file per active one-to-one contact, kept in the
  plugin's data directory (never in git). It holds who the person is, notes on
  tone, things to avoid, and up to five of your recent sent messages to them.
  It goes into every draft request for that person. The chief reviews the notes
  weekly from the edits you made to its drafts.
- **Sending**: agents cannot send. The send tools and `bb comms approve`,
  `bb comms wa approve` and `bb comms wa send` refuse any call that carries a
  bb thread id. Only the panel's Send button and your own terminal send.

## CLI

```
bb comms start | status | inbox [--json] | sync | ask <facts only> | activity
bb comms open <key>                 Print one conversation
bb comms draft <key> <text>         Create or update the pending draft
bb comms approve <key>              Send the pending draft (your terminal only)
bb comms discard <key>              Discard the pending draft
bb comms dismiss <key>              Hide until a new message arrives
bb comms mute <key> [--off]         Never queue or auto-draft for this sender
bb comms muted                      List the muted senders
bb comms discarded                  Drafts discarded in the last 24 hours
bb comms mail search <work|personal|all> <query> [--max N]
bb comms mail read <work|personal> <messageId>
bb comms mail thread <work|personal> <threadId>
bb comms mail draft <work|personal> --to <addr> --subject <s> --body <text> [--cc <addr>] [--reply-to <messageId>]
bb comms mail draft-update <work|personal> <draftId> --body <text>
bb comms mail draft-delete <work|personal> <draftId>
bb comms mail drafts [work|personal|all] [--max N]
bb comms wa status | login | logout
bb comms wa chats [--query <text>] [--limit N]
bb comms wa messages <chat> [--limit N]
bb comms wa draft <chat> <text>
bb comms wa drafts [--status pending|sent|discarded|failed|all]
bb comms wa approve <draftId> | discard <draftId>     (approve: your terminal only)
bb comms wa send <chat> <text>                        (your terminal only)
bb comms wa request-draft <chat>
```

`bb comms help` prints the full list. `chat` is a jid, a phone number, or a
unique contact or group name.

## Agent tools

`comms_inbox`, `comms_conversation`, `comms_dismiss`, `comms_mail_search`,
`comms_mail_read`, `comms_mail_thread`, `comms_mail_draft`,
`comms_mail_draft_update`, `comms_mail_draft_delete`,
`comms_mail_draft_restore`, `comms_mail_drafts`, `comms_wa_status`,
`comms_wa_chats`, `comms_wa_messages`, `comms_wa_draft`, `comms_wa_drafts`,
`comms_wa_keep`, `comms_wa_discard_draft`, `comms_voice_read`,
`comms_voice_note`. `comms_mail_send_draft`, `comms_wa_send` and
`comms_wa_send_draft` exist but always refuse an agent.

By default only the chief thread gets them (see `toolsEverywhere`).

## Notes and limits

- If your agent harness also has mail connectors (for example a Superhuman or
  Gmail connector on claude.ai), deny their send tools in the harness
  permissions too. This plugin cannot stop a connector it does not own.
- Baileys is unofficial. WhatsApp may end the session; the panel then shows a
  QR code again. Video notes and button or list replies are not rendered.
  History sync is shallow.
- The mail cache holds the last `mailLookbackDays` days plus threads you
  opened. Use `comms_mail_search` for older mail.
- The glyphs were made with the pipeline in `tools/asset-pipeline/`.

## Development

```sh
npm ci --ignore-scripts
npx tsc -p tsconfig.json   # typecheck
npm test
bb plugin dev              # rebuild and reload on save
```

`qa/githooks/pre-commit` refuses a commit whose typecheck or tests fail
(`git config core.hooksPath qa/githooks`).
