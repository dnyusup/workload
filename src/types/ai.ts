export type AiProvider = 'gemini' | 'deepseek' | 'groq' | 'openrouter';

export interface AiModelOption {
  id: string;
  name: string;
  provider: AiProvider;
  description: string;
  contextTokens?: number;
  isFree?: boolean;
}

export interface AiProviderConfig {
  apiKey: string;
  enabled: boolean;
  customEndpoint?: string;
}

export interface AiSettings {
  activeProvider: AiProvider;
  activeModel: string;
  temperature: number;
  providers: Record<AiProvider, AiProviderConfig>;
}

export type AiConnectionStatus = 'idle' | 'testing' | 'connected' | 'error';

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: AiToolCall[];
  toolCallId?: string;
  name?: string;
  isOptimizing?: boolean;
  proposedAction?: {
    type: 'apply_assignment' | 'run_simulation' | 'view_setup';
    label: string;
    payload: unknown;
  };
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}
