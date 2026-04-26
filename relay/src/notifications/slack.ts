import type { NotificationJob } from './types.js';

const SLACK_TIMEOUT_MS = 5_000;

export interface SlackPostResult {
  status: number;
  ok: boolean;
  retryAfterSeconds?: number;
}

export type SlackPoster = (url: string, payload: unknown) => Promise<SlackPostResult>;

export const defaultSlackPoster: SlackPoster = async (url, payload) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const retryAfter = res.headers.get('retry-after');
    return {
      status: res.status,
      ok: res.ok,
      retryAfterSeconds: retryAfter ? parseInt(retryAfter, 10) : undefined,
    };
  } finally {
    clearTimeout(t);
  }
};

export function renderSlackBlocks(job: NotificationJob): unknown {
  const headerText = headerForKind(job);
  const summaryPreview = job.summary.slice(0, 240);
  const inboxUrl = `${job.publicUrl.replace(/\/$/, '')}/inbox/${job.threadId}`;
  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Summary:* ${summaryPreview}\n*Thread ID:* \`${job.threadId}\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open inbox' },
            url: inboxUrl,
          },
        ],
      },
    ],
  };
}

function headerForKind(job: NotificationJob): string {
  switch (job.kind) {
    case 'notify.handoff.created':
      return `👋 New handoff from ${job.senderName}`;
    case 'notify.message.appended':
      return `💬 New message from ${job.senderName}`;
    case 'notify.handoff.completed':
      return `✅ Handoff completed by ${job.senderName}`;
    case 'notify.handoff.cancelled':
      return `🚫 Handoff cancelled by ${job.senderName}`;
  }
}
