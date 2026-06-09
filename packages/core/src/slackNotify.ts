import { patchdollSecret } from "./secrets.js";

const SLACK_API_URL = "https://slack.com/api/chat.postMessage";

export interface SlackNotification {
  channel: string;
  text: string;
  threadTs?: string;
}

interface SlackPostMessageResponse {
  ok?: unknown;
  error?: unknown;
  ts?: unknown;
}

export async function postSlackNotification(
  notification: SlackNotification
): Promise<string | undefined> {
  const token = await patchdollSecret("PATCHDOLL_SLACK_BOT_TOKEN");
  if (!token) {
    throw new Error("PATCHDOLL_SLACK_BOT_TOKEN is required in Patchdoll runtime secrets");
  }

  const response = await fetch(SLACK_API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: notification.channel,
      text: notification.text,
      thread_ts: notification.threadTs,
      unfurl_links: false,
      unfurl_media: false
    })
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as SlackPostMessageResponse;
  if (body.ok !== true) {
    throw new Error(
      `Slack notification failed: ${typeof body.error === "string" ? body.error : "unknown_error"}`
    );
  }

  return typeof body.ts === "string" ? body.ts : undefined;
}
