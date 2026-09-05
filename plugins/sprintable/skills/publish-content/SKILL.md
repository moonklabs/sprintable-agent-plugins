---
name: publish-content
description: The end-to-end flow for a channel post or site post (blog article) — create a draft, fix any content-rule violations, submit it for approval, wait for a human, read the published result, and branch on failure. Use whenever you are about to call create_channel_post_draft, create_site_post_draft, submit_channel_post_draft, submit_site_post_draft, get_channel_post_publication, or get_site_post_publication — read this first if you have not done this flow before.
user-invocable: true
---

# Publishing a channel post or site post — the full flow

story #3495(페드루 PO 確定 2026-09-05, 미르코 그라운딩 ③) — `create_*_draft`'s own
description already forward-links to `submit_*_draft`, but nothing said what happens
*after* submit, or what to do when the result is a failure. This skill is that missing
middle and end.

**This is a reference, not a command.** You don't run `/sprintable:publish-content` to
do something — you read it before or during a publish task so you know the whole shape
of the flow, including the two links that used to be missing (submit → read result,
and result → failure action).

## The six steps

1. **Create the draft** — `create_channel_post_draft` or `create_site_post_draft`.
   Calling it again with the same `work_item`(+`connection_id` for channel_post) adds a
   new version to the *same* draft; it never publishes anything by itself.
2. **Fix content-rule violations, if any** — the create response includes
   `violations: []`. Empty means clean. A non-empty array means the org has content
   rules configured and this draft trips one or more of them (e.g. a banned term, a
   missing required UTM param). Each entry is `{code, field, value, hint_key,
   settings_path}` — there is no `message` field, read `field`/`hint_key` to know what
   to fix. These are *non-blocking at create time* — you can still submit — but story
   #3471 makes `submit_*_draft` re-check them and reject at that point (see the 422 row
   in the failure table below). Fix the offending content and call `create_*_draft`
   again (same work_item) to save a new version before submitting.
3. **Submit** — `submit_*_draft`. This sends the draft version to the `external_publish`
   approval Gate. **It does not publish anything.** Only a human can approve a Gate from
   the Sprintable screen.
4. **Wait for a human to approve** — there is no polling tool and polling
   `get_*_publication` in a tight loop before approval has happened is wasted calls; a
   human approves (or rejects) the Gate on their own schedule, outside your control. If
   your work item tracking expects you to report status, say "submitted, awaiting
   approval" and move on — don't block on this step.
5. **Read the result — after approval, what happens next differs by content kind and
   destination** (`backend/app/services/gate_service.py::
   _maybe_create_scheduled_publication_command`, confirmed against source, not assumed):
   - **site_post, external destination (not hosted_site)** — a publication command is
     created the instant the Gate is approved; the worker picks it up on its next tick
     (typically within a minute). Call `get_site_post_publication` and expect
     `command_status` to already be set.
   - **channel_post with `scheduled_at` set at submit time** — a command is created on
     approval but the worker only acts on it at that `scheduled_at` time. Call
     `get_channel_post_publication`; `command_status` will read `pending` until then.
   - **channel_post with no `scheduled_at` (immediate post)** — **no command is created
     at all on approval.** Publishing this one is a separate, human-only action from the
     Sprintable screen (a synchronous "Publish" click, `POST .../channel-posts/drafts/
     {draft_id}/publish` — no agent tool for it). `get_channel_post_publication` will
     show a null/absent `command` until a human does that. **This is the expected,
     normal state — not a stuck draft.** Report it as "approved, waiting for a human to
     click Publish", not as a failure or a stall on your end.
   In every case, there is no "publish" tool for *you* to call — either a worker or a
   human does it, per the branches above. The response carries `command_status` /
   `publication_status` and, once published, `permalink`/`external_id`.
6. **Branch on the result** — see the table below. Most `command_status` values need no
   action; only `dead_letter` does, and even then the action is "tell a human", not
   "retry it yourself." A null/absent `command` after approval is its own case — see
   step 5's third bullet, it isn't one of the table's rows.

## Failure / status branch table

| `command_status` (or `publication_status`) | Meaning | What you do |
|---|---|---|
| `pending` / `in_progress` | Approved, not published yet (waiting for the worker tick, or the containerized-media step for images) | Nothing — check again later if you need to confirm, but there's no urgency |
| `container_created` (channel_post, media posts) | The adapter created the media container but hasn't finished publishing it | Nothing — same as pending, this is a normal intermediate state |
| `completed` / `published` | Done | Report the `permalink` you now have |
| `failed` (with `attempt_count` still climbing) | A single attempt failed; the worker backs off and retries automatically (story #3414) | Nothing — this is expected during the retry window, not an error to escalate |
| `dead_letter` | The worker gave up retrying | **Report this to a human, with the `command_id`.** Retrying a `dead_letter` command is a human action from the Sprintable screen (or its `POST .../publication-commands/{id}/retry` endpoint) — there is no agent tool for it in this slice. Don't call `submit_*_draft` again as a workaround; that creates a new version/Gate cycle, it does not retry the stuck command. |

Submit-time errors (`submit_*_draft` itself returning a structured error, before any of
the above ever starts) are a separate axis — see the table below for the common ones,
and `/sprintable:configure`'s **Reading tool error responses** section for the general
JSON error shape (`code`/`message`/`http_status`/`detail`) every Sprintable tool shares.

| `code` | HTTP | Meaning | What you do |
|---|---|---|
| `CONTENT_RULE_VIOLATION` | 422 | The org's content rules reject this version at submit time (story #3471) — `detail.violations[]`, same shape as the create-time array | Go back to step 2: fix the field(s) named in `violations[]`, re-save with `create_*_draft`, submit again |
| `CHANNEL_POST_GATE_ALREADY_HELD` / `SITE_POST_GATE_ALREADY_HELD` | 409 | Another draft on the same work item (or the same site_post slug/lang) already holds the approval Gate | `detail.holding_draft_id` names it — surface that id to a human as-is, don't guess which draft it is or resolve it yourself; it won't resolve by retrying |
| `CHANNEL_POST_APPROVER_ROLE_MISSING` / `SITE_POST_APPROVER_ROLE_MISSING` | 409 | The organization has no default approval role configured | Escalate to an organization owner/admin — not something your key can fix |
| `SITE_POST_CONNECTION_NOT_FOUND` / `SITE_POST_DESTINATION_KIND_MISMATCH` / `MEDIA_NOT_SUPPORTED_PHASE0` / `CAMPAIGN_NOT_FOUND` | 422 | site_post create-time input problems (bad `connection_id`, mismatched destination, unsupported media, unknown `campaign_id`) | Fix the offending field named by the code and re-create |

For `create_channel_post_draft`'s own codes (`CHANNEL_CONNECTION_NOT_ACTIVE`,
`CHANNEL_TEXT_TOO_LONG`), see `/sprintable:configure-threads` — this skill doesn't
repeat those.

## Human-only steps (not exposed to you as tools, by design)

- **Creating a channel connection** — `list_channel_connections` reads them, nothing
  creates one from an agent key; a human connects via the Sprintable screen.
- **Approving or rejecting the Gate** — the entire reason step 3/4 exist as separate
  steps from step 5.
- **Triggering the actual publish** — there is no `publish_*` tool for this domain. For
  site_post and scheduled channel_post, approval plus the worker tick is what publishes.
  For an immediate (no `scheduled_at`) channel_post, a human must separately click
  "Publish" on the Sprintable screen after approving — see step 5's third bullet. You
  never call anything to make any of these happen.
- **Retrying a `dead_letter` command** — see the table above.
- **Site_post's own public "publish" endpoint** (`POST .../site-posts`, the *hosted_site*
  publish path, separate from the create/submit/get flow above) is human-only server-side
  (`SITE_POST_PUBLISH_HUMAN_ONLY`) — it isn't part of this flow at all.
