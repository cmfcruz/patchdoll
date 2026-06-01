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

Both Slack tokens belong in `/run/secrets/patchdoll.env`. The main
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

## Optional: Allow Slack Admin Settings Changes

Patchdoll does not allow Slack users to change Patchdoll settings unless their
Slack user ID is listed in `PATCHDOLL_ADMINS`.

Use Slack user IDs, not names. To find one:

1. Open the person's Slack profile.
2. Click **More**.
3. Click **Copy member ID**.

Then pass one or more IDs as a comma-separated list:

```sh
-e PATCHDOLL_ADMINS=U12345678,W12345678
```

After that, listed admins can ask Patchdoll to update non-secret runtime
settings from Slack:

```text
/patchdoll set Codex reasoning effort to high
/patchdoll set Codex model to gpt-5.5
```

Secrets do not belong in settings. Keep Slack tokens, API keys, cookies, private
keys, and credentials in `/run/secrets/patchdoll.env`.
