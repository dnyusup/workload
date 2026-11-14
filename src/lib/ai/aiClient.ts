import type { AiChatMessage, AiProvider, AiSettings, AiToolCall, AiToolDefinition } from '../../types/ai';

export interface AiCompletionResponse {
  content: string;
  toolCalls?: AiToolCall[];
  providerUsed: AiProvider;
  modelUsed: string;
}

const PROVIDER_BASE_URLS: Record<AiProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** Executes a chat completion request to the specified provider with function calling support. */
export async function executeAiCompletion({
  settings,
  messages,
  systemPrompt,
  tools,
  overrideProvider,
  overrideModel,
}: {
  settings: AiSettings;
  messages: AiChatMessage[];
  systemPrompt?: string;
  tools?: AiToolDefinition[];
  overrideProvider?: AiProvider;
  overrideModel?: string;
}): Promise<AiCompletionResponse> {
  const provider = overrideProvider ?? settings.activeProvider;
  const model = overrideModel ?? settings.activeModel;
  const providerConfig = settings.providers[provider];

  if (!providerConfig?.apiKey?.trim()) {
    throw new Error(`API Key untuk ${provider.toUpperCase()} belum diisi. Silakan isi di menu Settings > AI Copilot.`);
  }

  const apiKey = providerConfig.apiKey.trim();

  if (provider === 'gemini') {
    return callGeminiApi({
      apiKey,
      model,
      messages,
      systemPrompt,
      tools,
      temperature: settings.temperature,
    });
  }

  // OpenAI-compatible providers: DeepSeek, Groq, OpenRouter
  return callOpenAiCompatibleApi({
    provider,
    apiKey,
    model,
    customEndpoint: providerConfig.customEndpoint,
    messages,
    systemPrompt,
    tools,
    temperature: settings.temperature,
  });
}

/** Google Gemini REST API handler */
async function callGeminiApi({
  apiKey,
  model,
  messages,
  systemPrompt,
  tools,
  temperature,
}: {
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  systemPrompt?: string;
  tools?: AiToolDefinition[];
  temperature?: number;
}): Promise<AiCompletionResponse> {
  const url = `${PROVIDER_BASE_URLS.gemini}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Convert messages to Gemini format
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: m.name ?? 'tool_result',
                response: { result: m.content },
              },
            },
          ],
        };
      }

      if (m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'model',
          parts: m.toolCalls.map((tc) => ({
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          })),
        };
      }

      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      };
    });

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: typeof temperature === 'number' ? temperature : 0.2,
    },
  };

  if (systemPrompt?.trim()) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt.trim() }],
    };
  }

  if (tools && tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const errorMsg = (errorBody as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      throw new Error(`[RATE_LIMIT] Kuota Google Gemini habis (429): ${errorMsg}`);
    }
    throw new Error(`Gemini API error (${res.status}): ${errorMsg}`);
  }

  const json = await res.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: {
            name: string;
            args: Record<string, unknown>;
          };
        }>;
      };
    }>;
  };

  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  let textResult = '';
  const toolCalls: AiToolCall[] = [];

  for (const part of parts) {
    if (part.text) {
      textResult += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      });
    }
  }

  return {
    content: textResult,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    providerUsed: 'gemini',
    modelUsed: model,
  };
}

/** OpenAI-compatible API handler (DeepSeek, Groq, OpenRouter) */
async function callOpenAiCompatibleApi({
  provider,
  apiKey,
  model,
  customEndpoint,
  messages,
  systemPrompt,
  tools,
  temperature,
}: {
  provider: AiProvider;
  apiKey: string;
  model: string;
  customEndpoint?: string;
  messages: AiChatMessage[];
  systemPrompt?: string;
  tools?: AiToolDefinition[];
  temperature?: number;
}): Promise<AiCompletionResponse> {
  const baseUrl = customEndpoint?.trim() || PROVIDER_BASE_URLS[provider];
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

  const formattedMessages: Array<Record<string, unknown>> = [];

  if (systemPrompt?.trim()) {
    formattedMessages.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const m of messages) {
    if (m.role === 'tool') {
      formattedMessages.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? 'call_default',
        name: m.name,
        content: m.content,
      });
    } else if (m.toolCalls && m.toolCalls.length > 0) {
      formattedMessages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      });
    } else {
      formattedMessages.push({
        role: m.role,
        content: m.content,
      });
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages: formattedMessages,
    temperature: typeof temperature === 'number' ? temperature : 0.2,
  };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'WorkLoad Simulator Copilot';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const errorMsg =
      (errorBody as { error?: { message?: string } })?.error?.message ??
      (typeof errorBody === 'string' ? errorBody : `HTTP ${res.status}`);
    if (res.status === 429) {
      throw new Error(`[RATE_LIMIT] Kuota ${provider.toUpperCase()} habis (429): ${errorMsg}`);
    }
    throw new Error(`${provider.toUpperCase()} API error (${res.status}): ${errorMsg}`);
  }

  const json = await res.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: {
            name: string;
            arguments: string;
          };
        }>;
      };
    }>;
  };

  const choice = json.choices?.[0];
  const rawMsg = choice?.message;
  const content = rawMsg?.content ?? '';

  const toolCalls: AiToolCall[] = [];
  if (rawMsg?.tool_calls && Array.isArray(rawMsg.tool_calls)) {
    for (const tc of rawMsg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // keep empty
      }
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      });
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    providerUsed: provider,
    modelUsed: model,
  };
}
