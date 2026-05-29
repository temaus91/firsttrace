import type * as OciGenAi from "oci-generativeaiinference";
import { createOciAuthProvider } from "../oci/auth.js";

export type OciGenAiChatClient = {
  chat(request: OciGenAi.requests.ChatRequest): Promise<OciGenAi.responses.ChatResponse | ReadableStream<Uint8Array> | null>;
  endpoint?: string;
  regionId?: string;
};

export type OciGenAiJsonClient = {
  generateJson(request: OciGenAiJsonRequest): Promise<unknown>;
  model: string;
};

export type OciGenAiJsonClientOptions = {
  chatClient?: OciGenAiChatClient;
  compartmentId: string;
  dedicatedEndpointId?: string;
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  maxTokens?: number;
  model: string;
  region?: string;
};

export type OciGenAiJsonRequest = {
  responseName: string;
  systemPrompt: string;
  userPrompt: string;
};

const DEFAULT_MAX_TOKENS = 3000;

const createDefaultChatClient = async (
  env: NodeJS.ProcessEnv,
  { endpoint, region }: { endpoint?: string; region?: string },
): Promise<OciGenAiChatClient> => {
  const ociGenAi = await import("oci-generativeaiinference");
  const client = new ociGenAi.GenerativeAiInferenceClient({
    authenticationDetailsProvider: await createOciAuthProvider(env),
  });
  if (region) client.regionId = region;
  if (endpoint) client.endpoint = endpoint;
  return client;
};

const textMessage = (role: "SYSTEM" | "USER", text: string): OciGenAi.models.SystemMessage | OciGenAi.models.UserMessage => ({
  content: [{ text, type: "TEXT" } as OciGenAi.models.TextContent],
  role,
});

const directJsonParse = (value: string) => JSON.parse(value) as unknown;

const parseJsonText = (text: string, responseName: string) => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return directJsonParse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return directJsonParse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the clear error below.
      }
    }
  }
  throw new Error(`OCI GenAI did not return valid JSON for ${responseName}.`);
};

const assistantTextFromChatResponse = (
  response: OciGenAi.responses.ChatResponse | ReadableStream<Uint8Array> | null,
  responseName: string,
) => {
  if (!response || !("chatResult" in response)) {
    throw new Error(`OCI GenAI did not return a non-stream chat response for ${responseName}.`);
  }
  const chatResponse = response?.chatResult?.chatResponse as
    | {
        choices?: Array<{
          message?: {
            content?: Array<{ text?: string; type?: string }>;
          };
        }>;
        text?: string;
      }
    | undefined;

  const choiceContent = chatResponse?.choices?.[0]?.message?.content;
  const text = choiceContent
    ?.map((item) => item.text ?? "")
    .join("")
    .trim() || chatResponse?.text?.trim();

  if (!text) {
    throw new Error(`OCI GenAI did not return assistant text for ${responseName}.`);
  }
  return text;
};

export const createOciGenAiJsonClient = ({
  chatClient,
  compartmentId,
  dedicatedEndpointId,
  endpoint,
  env = process.env,
  maxTokens = DEFAULT_MAX_TOKENS,
  model,
  region,
}: OciGenAiJsonClientOptions): OciGenAiJsonClient => {
  let clientPromise: Promise<OciGenAiChatClient> | undefined;
  const getClient = () => {
    clientPromise ??= chatClient
      ? Promise.resolve(chatClient)
      : createDefaultChatClient(env, { endpoint, region });
    return clientPromise;
  };

  const servingMode = dedicatedEndpointId
    ? ({ endpointId: dedicatedEndpointId, servingType: "DEDICATED" } as OciGenAi.models.DedicatedServingMode)
    : ({ modelId: model, servingType: "ON_DEMAND" } as OciGenAi.models.OnDemandServingMode);

  return {
    model,
    async generateJson({ responseName, systemPrompt, userPrompt }) {
      const client = await getClient();
      const response = await client.chat({
        chatDetails: {
          chatRequest: {
            apiFormat: "GENERIC",
            isStream: false,
            maxTokens,
            messages: [
              textMessage("SYSTEM", `${systemPrompt}\n\nReturn only valid JSON.`),
              textMessage("USER", userPrompt),
            ],
            responseFormat: { type: "JSON_OBJECT" },
            temperature: 0,
          } as OciGenAi.models.GenericChatRequest,
          compartmentId,
          servingMode,
        },
      });

      return parseJsonText(assistantTextFromChatResponse(response, responseName), responseName);
    },
  };
};
