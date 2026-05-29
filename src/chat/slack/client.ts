export type SlackPostMessageInput = {
  channel: string;
  text: string;
  threadTs?: string;
};

export type SlackPostMessageResult = {
  ts?: string;
};

export type SlackMessageLookupInput = {
  channel: string;
  ts: string;
};

export type SlackThreadMessage = {
  botId?: string;
  text?: string;
  ts?: string;
  user?: string;
};

export type SlackClient = {
  fetchMessageText(input: SlackMessageLookupInput): Promise<string | undefined>;
  fetchThreadMessageDetails?(input: SlackMessageLookupInput): Promise<SlackThreadMessage[]>;
  fetchThreadMessages?(input: SlackMessageLookupInput): Promise<string[]>;
  postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult | void>;
};

type FetchLike = typeof fetch;

const assertSlackOk = async (response: Response, action: string) => {
  const body = (await response.json()) as { error?: string; ok?: boolean };
  if (!response.ok || !body.ok) {
    throw new Error(`Slack ${action} failed: ${body.error ?? response.statusText}`);
  }
  return body;
};

export class SlackWebApiClient implements SlackClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetchMessageText({ channel, ts }: SlackMessageLookupInput): Promise<string | undefined> {
    const messages = await this.fetchThreadMessages({ channel, ts });
    return messages[0];
  }

  async fetchThreadMessages({ channel, ts }: SlackMessageLookupInput): Promise<string[]> {
    const messages = await this.fetchThreadMessageDetails({ channel, ts });
    return messages.flatMap((message) => (message.text ? [message.text] : []));
  }

  async fetchThreadMessageDetails({ channel, ts }: SlackMessageLookupInput): Promise<SlackThreadMessage[]> {
    const params = new URLSearchParams({ channel, inclusive: "true", limit: "10", ts });
    const response = await this.fetchImpl(`https://slack.com/api/conversations.replies?${params.toString()}`, {
      headers: {
        authorization: `Bearer ${this.botToken}`,
      },
      method: "GET",
    });
    const body = (await assertSlackOk(response, "conversations.replies")) as {
      messages?: Array<{ bot_id?: string; text?: string; ts?: string; user?: string }>;
    };
    return (
      body.messages?.map((message) => ({
        botId: message.bot_id,
        text: message.text,
        ts: message.ts,
        user: message.user,
      })) ?? []
    );
  }

  async postMessage({ channel, text, threadTs }: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      body: JSON.stringify({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
    });
    const body = (await assertSlackOk(response, "chat.postMessage")) as { ts?: string };
    return { ts: body.ts };
  }
}
