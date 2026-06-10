# Slack How-To

You need to talk to Patchdoll from Slack. Here is how to install Patchdoll into
your Slack workspace as an app.

## 1. Create a Slack workspace

If you already have a Slack workspace, skip this.

1. Go to Slack and create a new workspace.
2. Give it a simple name.
3. Create or pick a channel where you will test Patchdoll.

## 2. Create the Slack app

1. Go to `https://api.slack.com/apps`.
2. Click **Create New App**.
3. Choose **From scratch**.
4. Name it `Patchdoll`.
5. Pick your workspace.
6. Click **Create App**.

## 3. Turn on Socket Mode

Socket Mode lets Patchdoll connect out to Slack. You do not need to expose a
public web server.

1. In the Slack app settings, open **Basic Information**.
2. Find **App-Level Tokens**.
3. Click **Generate Token and Scopes**.
4. Name it `patchdoll-socket`.
5. Add this scope:

```text
connections:write
```

6. Click **Generate**.
7. Copy the token that starts with `xapp-`.
8. Open **Socket Mode**.
9. Turn on **Enable Socket Mode**.

Put the `xapp-` token in `PATCHDOLL_SLACK_APP_TOKEN`.

## 4. Add bot permissions

Open **OAuth & Permissions**, then add these **Bot Token Scopes**:

```text
app_mentions:read
channels:history
chat:write
commands
im:history
```

Optional, but useful:

```text
groups:history
mpim:history
```

Add the optional scopes if you want Patchdoll to read threads in private
channels or group DMs where the app has been added.

## 5. Subscribe to events

Open **Event Subscriptions**.

1. Turn on **Enable Events**.
2. Under **Subscribe to bot events**, add:

```text
app_mention
message.im
```

`app_mention` lets Patchdoll respond when someone mentions it in a channel.
`message.im` lets Patchdoll respond to direct messages.

## 6. Create the slash command

Open **Slash Commands**.

1. Click **Create New Command**.
2. Command:

```text
/patchdoll
```

3. Short description:

```text
Ask Patchdoll
```

4. Usage hint:

```text
summarize this thread
```

If Slack asks for a request URL, Socket Mode apps do not need a real public URL.
Use:

```text
https://example.com/slack/events
```

Patchdoll receives the command through Socket Mode.

## 7. Allow direct messages

Open **App Home**.

1. Find **Messages Tab**.
2. Turn on **Allow users to send Slash commands and messages from the messages tab**.

## 8. Install the app

1. Open **OAuth & Permissions**.
2. Click **Install to Workspace**.
3. Approve the install.
4. Copy the **Bot User OAuth Token** that starts with `xoxb-`.

Put the `xoxb-` token in `PATCHDOLL_SLACK_BOT_TOKEN`.

Pass both Slack tokens as container environment variables. The main
[README](../README.md#environment-reference) lists the full secrets and runtime
environment reference.

If you change scopes or events later, reinstall the app.

## 9. Invite Patchdoll to a channel

In the Slack channel where you want to use Patchdoll:

```text
/invite @Patchdoll
```

Now test:

```text
/patchdoll say hi
```

## Troubleshooting: thread transcript says `slack_missing_scope`

Patchdoll reads Slack threads with Slack's `conversations.replies` API. If the
logs show `slack_missing_scope`, the bot token is installed without the history
scope needed for that conversation type.

Add the matching **Bot Token Scope** under **OAuth & Permissions**:

| Conversation type | Required bot scope |
| --- | --- |
| Public channels | `channels:history` |
| Private channels | `groups:history` |
| Direct messages | `im:history` |
| Group direct messages | `mpim:history` |

Then reinstall the app to the workspace. Yes, Slack makes the reinstall step
easy to forget, because apparently scopes are only real after a tiny ceremony.
Restart Patchdoll too if you replaced the bot token.

## Who can use Patchdoll (required)

Patchdoll fails closed. It runs a request only when the requesting Slack user's
ID is on one of two lists:

- `PATCHDOLL_TRUSTED_USERS` — may drive Patchdoll for normal work.
- `PATCHDOLL_ADMINS` — may also change settings and reset threads; implicitly
  trusted, so admins do not also need to be in `PATCHDOLL_TRUSTED_USERS`.

With **neither** list set, Patchdoll denies every request — there is no
open-access mode. Set at least one before expecting a reply, or the bot will
look broken when it is really just locked.

For allowed users, the current Slack request is the trusted interactive input to
Patchdoll, like typing a prompt into the AI provider directly. Slack thread
transcripts, quoted prior messages, and Slack text copied from other systems are
provided as context/evidence only; they are not separate instructions or
authorization.

Use Slack user IDs, not display names. To find one:

1. Open the person's Slack profile.
2. Click **More**.
3. Click **Copy member ID**.

Then pass the IDs as comma- or newline-separated lists:

```sh
-e PATCHDOLL_TRUSTED_USERS=U12345678,U23456789 \
-e PATCHDOLL_ADMINS=U12345678
```

An unlisted user gets a short denial and no AI run starts. The check looks at the
requesting message's author only — other thread participants and quoted or pasted
content never count as authorization.

## Allow Slack admin settings changes

Admins — the Slack user IDs in `PATCHDOLL_ADMINS` (see [Who can use
Patchdoll](#who-can-use-patchdoll-required)) — can ask Patchdoll to update
non-secret runtime settings from Slack:

```text
/patchdoll set Codex reasoning effort to high
/patchdoll set Codex model to gpt-5.5
```

Secrets do not belong in settings. Provide Slack tokens, API keys, cookies,
private keys, and credentials as container environment variables.

## Optional: Reset a thread's session

Patchdoll remembers a CLI session per thread and resumes it on each new message.
If a thread ever gets stuck (for example, a resume keeps failing), an **admin**
can clear the saved session so the next message starts a fresh conversation.

Mention or DM Patchdoll with one of:

```text
reset thread
reset this thread
start fresh
```

This is admin-only (same `PATCHDOLL_ADMINS` list as settings changes) and only
clears the stored session for that one thread — it does not delete any messages.
Non-admins are told to ask an admin. Patchdoll also suggests this command on its
own when an invocation fails in a way that looks like a dead session.
