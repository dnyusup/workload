import type { AiModelOption, AiProvider, AiSettings } from '../../types/ai';
import { Mpp_wl_defaultvaluesService } from '../../generated/services/Mpp_wl_defaultvaluesService';
import type { Mpp_wl_defaultvalues } from '../../generated/models/Mpp_wl_defaultvaluesModel';
import { fetchAllPages } from '../dataversePaging';

const STORAGE_KEY = 'workload-ai-settings-v1';

export const AI_MODELS: AiModelOption[] = [
  // Google Gemini
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'gemini',
    description: 'Fastest Google model, excellent reasoning & 1M context. Recommended default.',
    contextTokens: 1000000,
    isFree: true,
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'gemini',
    description: 'Deepest Google intelligence, 2M context token capacity.',
    contextTokens: 2000000,
    isFree: true,
  },

  // DeepSeek Official
  {
    id: 'deepseek-chat',
    name: 'DeepSeek-V3 (Official)',
    provider: 'deepseek',
    description: 'High-capability general reasoning model via official DeepSeek API.',
    contextTokens: 64000,
    isFree: false,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek-R1 (Official)',
    provider: 'deepseek',
    description: 'State-of-the-art chain-of-thought mathematical and logic reasoning.',
    contextTokens: 64000,
    isFree: false,
  },

  // Groq Cloud
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B (Groq)',
    provider: 'groq',
    description: 'Meta flagship open model running on Groq LPUs at 300+ tokens/sec.',
    contextTokens: 128000,
    isFree: true,
  },
  {
    id: 'deepseek-r1-distill-llama-70b',
    name: 'DeepSeek R1 Distill 70B (Groq)',
    provider: 'groq',
    description: 'DeepSeek reasoning distilled into Llama 70B with Groq extreme speed.',
    contextTokens: 128000,
    isFree: true,
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'Llama 3.1 8B (Groq)',
    provider: 'groq',
    description: 'Ultra-lightweight and lightning fast response.',
    contextTokens: 128000,
    isFree: true,
  },

  // OpenRouter Free Models
  {
    id: 'deepseek/deepseek-r1:free',
    name: 'DeepSeek R1 (OpenRouter Free)',
    provider: 'openrouter',
    description: 'Full DeepSeek R1 reasoning model hosted on OpenRouter free tier.',
    contextTokens: 64000,
    isFree: true,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Llama 3.3 70B (OpenRouter Free)',
    provider: 'openrouter',
    description: 'Llama 3.3 70B hosted on OpenRouter free tier.',
    contextTokens: 128000,
    isFree: true,
  },
  {
    id: 'google/gemini-2.0-flash-exp:free',
    name: 'Gemini 2.0 Flash Exp (OpenRouter Free)',
    provider: 'openrouter',
    description: 'Experimental Gemini 2.0 via OpenRouter.',
    contextTokens: 1000000,
    isFree: true,
  },
];

export interface ProviderGuide {
  title: string;
  badge: string;
  portalUrl: string;
  portalLabel: string;
  steps: string[];
  tips: string;
}

export const PROVIDER_GUIDES: Record<AiProvider, ProviderGuide> = {
  gemini: {
    title: 'Google Gemini (Google AI Studio)',
    badge: '100% Free · 1,500 req/day',
    portalUrl: 'https://aistudio.google.com/apikey',
    portalLabel: 'Open Google AI Studio',
    steps: [
      'Open Google AI Studio via the link below (sign in with your Google account).',
      'Click the blue "+ Create API key" button.',
      'Select "Create key in new project" (or choose an existing GCP project).',
      'Copy the API key starting with "AIzaSy..." and paste it into the field above.',
    ],
    tips: 'No credit card required. Free tier includes 15 requests per minute and 1,500 requests per day.',
  },
  deepseek: {
    title: 'DeepSeek Official API',
    badge: 'Official Platform · High Quality',
    portalUrl: 'https://platform.deepseek.com/api_keys',
    portalLabel: 'Open DeepSeek Platform',
    steps: [
      'Open DeepSeek Open Platform and sign in or create an account.',
      'Navigate to "API Keys" in the left sidebar.',
      'Click "Create new secret key", enter a label (e.g. Workload).',
      'Copy the secret key starting with "sk-..." and paste it here.',
    ],
    tips: 'New users usually receive a free bonus balance. Pay-as-you-go rates are very low (around $0.14 per 1M tokens).',
  },
  groq: {
    title: 'Groq Cloud',
    badge: '100% Free · Ultra Fast (300+ tok/s)',
    portalUrl: 'https://console.groq.com/keys',
    portalLabel: 'Open Groq Console',
    steps: [
      'Open Groq Console and sign in with Google or GitHub.',
      'Click "API Keys" in the left sidebar.',
      'Click "Create API Key", enter a name (e.g. WorkloadSim).',
      'Copy the key starting with "gsk_..." and paste it here.',
    ],
    tips: '100% free with no credit card required. World-record inference speeds for Llama 3.3 and DeepSeek R1 Distill.',
  },
  openrouter: {
    title: 'OpenRouter Multi-Model',
    badge: '1 Key for Multiple Free Models',
    portalUrl: 'https://openrouter.ai/keys',
    portalLabel: 'Open OpenRouter Keys',
    steps: [
      'Open OpenRouter and sign in with Google or GitHub.',
      'Click "Create Key" and enter a name (e.g. Workload Agent).',
      'Copy the key starting with "sk-or-v1-..." and paste it here.',
    ],
    tips: 'One API key provides access to dozens of free models labeled ":free" (including DeepSeek R1 and Llama 3.3).',
  },
};

export function defaultAiSettings(): AiSettings {
  return {
    activeProvider: 'gemini',
    activeModel: 'gemini-1.5-flash',
    temperature: 0.2,
    providers: {
      gemini: { apiKey: '', enabled: true },
      deepseek: { apiKey: '', enabled: false },
      groq: { apiKey: '', enabled: false },
      openrouter: { apiKey: '', enabled: false },
    },
  };
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAiSettings();
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const defaults = defaultAiSettings();
    return {
      activeProvider: parsed.activeProvider ?? defaults.activeProvider,
      activeModel: parsed.activeModel ?? defaults.activeModel,
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : defaults.temperature,
      providers: {
        gemini: { ...defaults.providers.gemini, ...(parsed.providers?.gemini ?? {}) },
        deepseek: { ...defaults.providers.deepseek, ...(parsed.providers?.deepseek ?? {}) },
        groq: { ...defaults.providers.groq, ...(parsed.providers?.groq ?? {}) },
        openrouter: { ...defaults.providers.openrouter, ...(parsed.providers?.openrouter ?? {}) },
      },
    };
  } catch {
    return defaultAiSettings();
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

/** Parameter names stored in Dataverse table WL_DefaultValues */
export const AI_DATA_PARAMETERS = {
  activeProvider: 'AiActiveProvider',
  activeModel: 'AiActiveModel',
  geminiKey: 'AiGeminiApiKey',
  deepseekKey: 'AiDeepSeekApiKey',
  groqKey: 'AiGroqApiKey',
  openrouterKey: 'AiOpenRouterApiKey',
} as const;

/** Saves AI configuration and API keys to the Dataverse WL_DefaultValues table */
export async function saveAiSettingsToDataverse(settings: AiSettings): Promise<void> {
  const rows = await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {});
  const rowMap = new Map<string, Mpp_wl_defaultvalues>();
  rows.forEach((r) => {
    const p = (r.mpp_parameters ?? '').trim().toLowerCase();
    if (p) rowMap.set(p, r);
  });

  const entries: [string, string][] = [
    [AI_DATA_PARAMETERS.activeProvider, settings.activeProvider],
    [AI_DATA_PARAMETERS.activeModel, settings.activeModel],
    [AI_DATA_PARAMETERS.geminiKey, settings.providers.gemini?.apiKey ?? ''],
    [AI_DATA_PARAMETERS.deepseekKey, settings.providers.deepseek?.apiKey ?? ''],
    [AI_DATA_PARAMETERS.groqKey, settings.providers.groq?.apiKey ?? ''],
    [AI_DATA_PARAMETERS.openrouterKey, settings.providers.openrouter?.apiKey ?? ''],
  ];

  for (const [paramName, value] of entries) {
    const keyLower = paramName.toLowerCase();
    const existing = rowMap.get(keyLower);
    const trimmedVal = value.trim();

    if (existing) {
      if ((existing.mpp_value ?? '').trim() !== trimmedVal) {
        await Mpp_wl_defaultvaluesService.update(existing.mpp_wl_defaultvalueid, { mpp_value: trimmedVal });
      }
    } else if (trimmedVal) {
      await Mpp_wl_defaultvaluesService.create({
        mpp_parameters: paramName,
        mpp_value: trimmedVal,
        statecode: 0,
      });
    }
  }
}

/** Fetches AI configuration and API keys from the Dataverse WL_DefaultValues table */
export async function fetchAiSettingsFromDataverse(): Promise<AiSettings> {
  const current = loadAiSettings();
  try {
    const rows = await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {});
    const rowMap = new Map<string, string>();
    rows.forEach((r) => {
      const p = (r.mpp_parameters ?? '').trim().toLowerCase();
      if (p) rowMap.set(p, (r.mpp_value ?? '').trim());
    });

    const activeProvider = (rowMap.get(AI_DATA_PARAMETERS.activeProvider.toLowerCase()) as AiProvider) || current.activeProvider;
    const activeModel = rowMap.get(AI_DATA_PARAMETERS.activeModel.toLowerCase()) || current.activeModel;
    const geminiKey = rowMap.get(AI_DATA_PARAMETERS.geminiKey.toLowerCase()) ?? current.providers.gemini.apiKey;
    const deepseekKey = rowMap.get(AI_DATA_PARAMETERS.deepseekKey.toLowerCase()) ?? current.providers.deepseek.apiKey;
    const groqKey = rowMap.get(AI_DATA_PARAMETERS.groqKey.toLowerCase()) ?? current.providers.groq.apiKey;
    const openrouterKey = rowMap.get(AI_DATA_PARAMETERS.openrouterKey.toLowerCase()) ?? current.providers.openrouter.apiKey;

    const merged: AiSettings = {
      ...current,
      activeProvider: (['gemini', 'deepseek', 'groq', 'openrouter'].includes(activeProvider) ? activeProvider : current.activeProvider),
      activeModel,
      providers: {
        gemini: { apiKey: geminiKey, enabled: Boolean(geminiKey) },
        deepseek: { apiKey: deepseekKey, enabled: Boolean(deepseekKey) },
        groq: { apiKey: groqKey, enabled: Boolean(groqKey) },
        openrouter: { apiKey: openrouterKey, enabled: Boolean(openrouterKey) },
      },
    };

    saveAiSettings(merged);
    return merged;
  } catch (err) {
    console.warn('[AI Config] Failed to fetch settings from Dataverse, using cached settings:', err);
    return current;
  }
}

/** Tests if an API key is valid by querying the provider's models or ping endpoint. */
export async function testProviderConnection(provider: AiProvider, apiKey: string, customEndpoint?: string): Promise<{ success: boolean; message: string }> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { success: false, message: 'API Key is empty.' };
  }

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmedKey)}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = (errorData as { error?: { message?: string } })?.error?.message ?? `Status ${res.status}`;
        return { success: false, message: `Failed: ${msg}` };
      }
      return { success: true, message: 'Connection to Google Gemini successful!' };
    }

    if (provider === 'deepseek') {
      const endpoint = customEndpoint?.trim() || 'https://api.deepseek.com/models';
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = (errorData as { error?: { message?: string } })?.error?.message ?? `Status ${res.status}`;
        return { success: false, message: `Failed: ${msg}` };
      }
      return { success: true, message: 'Connection to DeepSeek API successful!' };
    }

    if (provider === 'groq') {
      const endpoint = customEndpoint?.trim() || 'https://api.groq.com/openai/v1/models';
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = (errorData as { error?: { message?: string } })?.error?.message ?? `Status ${res.status}`;
        return { success: false, message: `Failed: ${msg}` };
      }
      return { success: true, message: 'Connection to Groq Cloud successful!' };
    }

    if (provider === 'openrouter') {
      const endpoint = customEndpoint?.trim() || 'https://openrouter.ai/api/v1/auth/key';
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
        },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = (errorData as { error?: { message?: string } })?.error?.message ?? `Status ${res.status}`;
        return { success: false, message: `Failed: ${msg}` };
      }
      return { success: true, message: 'Connection to OpenRouter successful!' };
    }

    return { success: false, message: 'Unknown provider.' };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Failed to reach provider server.' };
  }
}
