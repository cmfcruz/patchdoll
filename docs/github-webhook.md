# GitHub Webhook Ingress

Patchdoll can accept authenticated GitHub webhook events and notify a trusted
Slack channel when a new issue, pull request, or comment arrives.

The webhook path is intentionally conservative: GitHub payload text is treated
as untrusted content and does not automatically trigger Codex work. Slack
notifications are compact pointers back to GitHub, not remote-control panels.

## Configure secrets

Pass the webhook secret and Slack bot token as container environment variables:

```sh
PATCHDOLL_SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
PATCHDOLL_GITHUB_WEBHOOK_SECRET=your-github-webhook-secret
```

If you expose Patchdoll through ngrok, pass the ngrok auth token as another
environment variable:

```sh
PATCHDOLL_NGROK_AUTHTOKEN=your-ngrok-auth-token
```

Do not pass these values with `docker run -e`. Secrets in environment variables
are a classic little tragedy.

## Configure runtime settings

Set the Slack destination and optional webhook-tracked repository list with
container environment values:

```sh
-e PATCHDOLL_GITHUB_NOTIFY_SLACK_CHANNEL=C0123456789
-e PATCHDOLL_GITHUB_WEBHOOK_TRACKED_REPOS=cmfcruz/patchdoll,cmfcruz/another-repo
```

Use full `owner/repo` names. Separate multiple repositories with commas, spaces,
or newlines.

Slack notification events are fixed to a conservative default:

- `issues.opened`
- `pull_request.opened`
- `issue_comment.created`
- `issue_comment.edited`
- `pull_request_review_comment.created`
- `pull_request_review_comment.edited`

If `PATCHDOLL_GITHUB_WEBHOOK_TRACKED_REPOS` is unset, any repository using the
configured webhook secret is tracked. Patchdoll does not expose an event allowlist setting;
otherwise one typo becomes a surprisingly effective notification black hole.

## Optional intake-review dispatch

Patchdoll also has a gated dispatch seam for the future isolated intake-review
worker. This path is separate from the normal Patchdoll AI orchestrator and only
schedules work when the pre-start observe runtime check reports `available`.
Until the worker lands, the default dispatcher is log-only; this is the narrow
handoff point the worker will plug into.

Enable modes independently:

```sh
-e PATCHDOLL_GITHUB_OBSERVE_ISSUES_ENABLED=true
-e PATCHDOLL_GITHUB_OBSERVE_PRS_ENABLED=true
-e PATCHDOLL_GITHUB_OBSERVE_WORKER_IMAGE=patchdoll-github-observe:latest
```

Issue intake dispatch handles `issues.opened` and `issues.edited`. PR intake
dispatch handles `pull_request.opened` and `pull_request.synchronize`. Comment
events are intentionally not intake-review triggers; they remain Slack
notifications only.

## GitHub webhook settings

Configure the GitHub webhook URL as:

```text
https://your-public-host.example.com/webhooks/github
```

Use these GitHub webhook settings:

- Content type: `application/json`
- Secret: the value from `PATCHDOLL_GITHUB_WEBHOOK_SECRET`
- Events: select individual events for Issues and Pull requests, or send all
  events and let Patchdoll filter them

Patchdoll verifies `X-Hub-Signature-256`, handles `ping`, dedupes deliveries by
`X-GitHub-Delivery`, and ignores unsupported authentic events without triggering
Codex. The webhook endpoint is always registered; if no webhook secret is
configured, authenticated processing stays closed.

When `PATCHDOLL_LOG_LEVEL=trace`, Patchdoll writes safe structured webhook logs
for receive, reject, ignore, duplicate, Slack notification failure, and Slack
notification success paths. These logs include delivery ID, repository, event,
action, issue or pull request number, and URLs, but not webhook secrets,
signature values, or comment/body text.

## Preferred public exposure: ngrok

ngrok is the preferred first-class tunnel option for this feature because it can
provide a stable domain on the free plan. A stable domain means users can set the
GitHub webhook URL once instead of changing it every time the container restarts.
Tiny luxury, enormous reduction in ritual suffering.

Optional ngrok runtime setting:

```sh
-e PATCHDOLL_NGROK_DOMAIN=your-stable-domain.ngrok-free.app
```

Pass the ngrok auth token as `PATCHDOLL_NGROK_AUTHTOKEN`. If that secret is not
set, the ngrok S6 service logs that it is disabled and does not start a tunnel.

## Slack notification behavior

For supported events, Patchdoll posts a message containing:

- issue or pull request title and URL
- GitHub actor
- for comment events, a compact comment preview capped at 300 characters

Comment previews are escaped before posting to Slack, and webhook text alone
does not get to drive Codex. A follow-up request from a trusted Slack user
remains the interactive trust boundary; quoted webhook text inside that request
is still context, not authority. Sensible, yes. Slightly less dramatic, also
yes.
