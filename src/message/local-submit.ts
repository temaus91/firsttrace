import type { JobQueue, MessageDeliveryAdapter, MessageSubmitInput, MessageSubmitResult } from "../types.js";

const LOCAL_CLI_SOURCE = { provider: "local-cli" };

export class LocalMessageDeliveryAdapter implements MessageDeliveryAdapter {
  constructor(private readonly queue: JobQueue) {}

  async submit(input: MessageSubmitInput): Promise<MessageSubmitResult> {
    const report = input.report.trim();
    if (!report) {
      throw new Error("Missing required --report.");
    }

    const job = await this.queue.enqueue({
      aiEnabled: input.aiEnabled,
      configPath: input.configPath,
      report,
      source: input.source ?? LOCAL_CLI_SOURCE,
    });

    return {
      job,
    };
  }
}
