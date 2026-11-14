import type { AiModelOption, AiProvider, AiSettings } from '../../types/ai';
import { Mpp_wl_defaultvaluesService } from '../../generated/services/Mpp_wl_defaultvaluesService';
import type { Mpp_wl_defaultvalues } from '../../generated/models/Mpp_wl_defaultvaluesModel';
import { fetchAllPages } from '../dataversePaging';

const STORAGE_KEY = 'workload-ai-settings-v1';

export const AI_MODELS: AiModelOption[] = [
  // DeepSeek Official (Verified & Active)
  {
    id: 'deepseek-chat',
    name: 'DeepSeek-V3 (Official)',
    provider: 'deepseek',
    description: 'High-capability general reasoning model via official DeepSeek API. Verified active.',
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

  // Groq Cloud (Active Models)
  {
    id: 'openai/gpt-oss-120b',
    name: 'OpenAI GPT-OSS 120B (Groq)',
    provider: 'groq',
    description: 'Flagship 120B open model running on Groq LPUs at 300+ tok/s with native tool calling.',
    contextTokens: 131072,
    isFree: true,
  },
  {
    id: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B (Groq)',
    provider: 'groq',
    description: 'Alibaba Qwen reasoning model on Groq hardware at ultra-fast generation speed.',
    contextTokens: 131072,
    isFree: true,
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'OpenAI GPT-OSS 20B (Groq)',
    provider: 'groq',
    description: 'Ultra-fast lightweight model for instant completions.',
    contextTokens: 131072,
    isFree: true,
  },

  // Google Gemini (Free Tier)
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'gemini',
    description: 'Fastest Google model, 1M context. Requires Google AI Studio key starting with AIzaSy...',
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

  // OpenRouter Free Models
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    name: 'Nemotron 3.5 Lightning (OpenRouter Free)',
    provider: 'openrouter',
    description: 'NVIDIA high-performance reasoning model on OpenRouter free tier.',
    contextTokens: 131072,
    isFree: true,
  },
  {
    id: 'particle-ai/particle-1:free',
    name: 'Particle-1 (OpenRouter Free)',
    provider: 'openrouter',
    description: 'Fast general-purpose conversational free model.',
    contextTokens: 32768,
    isFree: true,
  },
  {
    id: 'liquid/lfm-3-1.7b:free',
    name: 'Liquid LFM 3 1.7B (OpenRouter Free)',
    provider: 'openrouter',
    description: 'Lightweight free model hosted on OpenRouter.',
    contextTokens: 32768,
    isFree: true,
  },
  {
    id: 'inclusionai/ling-3.2-flash:free',
    name: 'Ling 3.2 Flash (OpenRouter Free)',
    provider: 'openrouter',
    description: 'Fast conversational free model on OpenRouter.',
    contextTokens: 32768,
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
      'Select "Create key in new project" (or choose an existing project).',
      'IMPORTANT: Copy the key starting with "AIzaSy..." and paste it here. (OAuth tokens starting with "AQ.Ab8..." will not work).',
    ],
    tips: 'No credit card required. Free tier includes 1,500 requests per day. Key MUST start with "AIzaSy...".',
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
    tips: 'New users receive free balance. High capability DeepSeek-V3 & DeepSeek-R1 reasoning models.',
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
    tips: '100% free with no credit card required. Active models include OpenAI GPT-OSS 120B and Qwen 3.8 27B on Groq LPUs.',
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
    tips: 'One API key provides access to free models labeled ":free" (including Nemotron 3.5 Lightning and Liquid LFM).',
  },
};

export function defaultAiSettings(): AiSettings {
  return {
    activeProvider: 'deepseek',
    activeModel: 'deepseek-chat',
    temperature: 0.2,
    providers: {
      gemini: { apiKey: '', enabled: false },
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

let savePromiseChain: Promise<void> = Promise.resolve();

/**
 * Saves AI configuration and API keys to the Dataverse WL_DefaultValues table.
 * Serialized sequentially to prevent concurrent race condition creates,
 * and automatically detects and purges duplicate rows.
 */
export function saveAiSettingsToDataverse(settings: AiSettings): Promise<void> {
  savePromiseChain = savePromiseChain
    .catch(() => {})
    .then(() => executeSaveAiSettingsToDataverse(settings));
  return savePromiseChain;
}

async function executeSaveAiSettingsToDataverse(settings: AiSettings): Promise<void> {
  const rows = await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {});
  const rowsByParam = new Map<string, Mpp_wl_defaultvalues[]>();
  rows.forEach((r) => {
    const p = (r.mpp_parameters ?? '').trim().toLowerCase();
    if (p) {
      const list = rowsByParam.get(p) ?? [];
      list.push(r);
      rowsByParam.set(p, list);
    }
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
    const matchingRows = rowsByParam.get(keyLower) ?? [];
    const trimmedVal = value.trim();

    if (matchingRows.length > 0) {
      // 1. Update primary row if value changed
      const primary = matchingRows[0];
      if ((primary.mpp_value ?? '').trim() !== trimmedVal) {
        await Mpp_wl_defaultvaluesService.update(primary.mpp_wl_defaultvalueid, { mpp_value: trimmedVal });
      }

      // 2. Automatically delete all duplicate rows for this parameter
      if (matchingRows.length > 1) {
        for (let i = 1; i < matchingRows.length; i++) {
          const duplicate = matchingRows[i];
          try {
            await Mpp_wl_defaultvaluesService.delete(duplicate.mpp_wl_defaultvalueid);
            console.log(`[AI Config] Successfully purged duplicate Dataverse row for ${paramName}: ${duplicate.mpp_wl_defaultvalueid}`);
          } catch (err) {
            console.warn(`[AI Config] Failed to purge duplicate row for ${paramName}:`, err);
          }
        }
      }
    } else if (trimmedVal) {
      // 3. Create only if row does not exist at all and value is not empty
      const created = await Mpp_wl_defaultvaluesService.create({
        mpp_parameters: paramName,
        mpp_value: trimmedVal,
        statecode: 0,
      });
      if (created.data) {
        rowsByParam.set(keyLower, [created.data]);
      }
    }
  }
}

/** Fetches AI configuration and API keys from the Dataverse WL_DefaultValues table and cleans any duplicates */
export async function fetchAiSettingsFromDataverse(): Promise<AiSettings> {
  const current = loadAiSettings();
  try {
    const rows = await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {});
    const rowsByParam = new Map<string, Mpp_wl_defaultvalues[]>();
    rows.forEach((r) => {
      const p = (r.mpp_parameters ?? '').trim().toLowerCase();
      if (p) {
        const list = rowsByParam.get(p) ?? [];
        list.push(r);
        rowsByParam.set(p, list);
      }
    });

    // Check and clean up any duplicate AI parameter rows in the background
    const allAiKeys = Object.values(AI_DATA_PARAMETERS).map((k) => k.toLowerCase());
    rowsByParam.forEach((matchingRows, keyLower) => {
      if (allAiKeys.includes(keyLower) && matchingRows.length > 1) {
        for (let i = 1; i < matchingRows.length; i++) {
          Mpp_wl_defaultvaluesService.delete(matchingRows[i].mpp_wl_defaultvalueid).catch((err) => {
            console.warn(`[AI Config] Failed to clean up duplicate row ${matchingRows[i].mpp_wl_defaultvalueid}:`, err);
          });
        }
      }
    });

    const getParamVal = (paramName: string): string | undefined => {
      const match = rowsByParam.get(paramName.toLowerCase());
      return match && match[0] ? (match[0].mpp_value ?? '').trim() : undefined;
    };

    let activeProvider = (getParamVal(AI_DATA_PARAMETERS.activeProvider) as AiProvider) || current.activeProvider;
    let activeModel = getParamVal(AI_DATA_PARAMETERS.activeModel) || current.activeModel;
    const geminiKey = getParamVal(AI_DATA_PARAMETERS.geminiKey) ?? current.providers.gemini.apiKey;
    const deepseekKey = getParamVal(AI_DATA_PARAMETERS.deepseekKey) ?? current.providers.deepseek.apiKey;
    let groqKey = getParamVal(AI_DATA_PARAMETERS.groqKey) ?? current.providers.groq.apiKey;
    const openrouterKey = getParamVal(AI_DATA_PARAMETERS.openrouterKey) ?? current.providers.openrouter.apiKey;

    // Auto-fix common Groq key copy-paste OCR typo (e.g. KltDu -> KItDu)
    if (groqKey && groqKey.startsWith('gsk_WmwaCQxKltDu')) {
      groqKey = groqKey.replace('gsk_WmwaCQxKltDu', 'gsk_WmwaCQxKItDu');
    }

    // Auto-migrate retired models (such as deprecated llama-3.3-70b-versatile) or invalid model IDs
    let settingsMigrated = false;
    if (activeModel === 'llama-3.3-70b-versatile' || !AI_MODELS.some((m) => m.id === activeModel)) {
      if (activeProvider === 'groq') {
        activeModel = 'openai/gpt-oss-120b';
      } else if (activeProvider === 'deepseek' || deepseekKey) {
        activeProvider = 'deepseek';
        activeModel = 'deepseek-chat';
      } else {
        const fallback = AI_MODELS.find((m) => m.provider === activeProvider) ?? AI_MODELS[0];
        activeModel = fallback.id;
        activeProvider = fallback.provider;
      }
      settingsMigrated = true;
    }

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

    // If models were migrated, asynchronously update Dataverse table so it stays clean
    if (settingsMigrated) {
      saveAiSettingsToDataverse(merged).catch((err) => {
        console.warn('[AI Config] Auto-migration Dataverse save error:', err);
      });
    }

    return merged;
  } catch (err) {
    console.warn('[AI Config] Failed to fetch settings from Dataverse, using cached settings:', err);
    return current;
  }
}

/** Tests if an API key is valid by querying the provider's models or ping endpoint. */
export async function testProviderConnection(provider: AiProvider, apiKey: string, customEndpoint?: string): Promise<{ success: boolean; message: string }> {
  let trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { success: false, message: 'API Key is empty.' };
  }

  // Auto-correct common OCR typo in Groq key:
  if (provider === 'groq' && trimmedKey.startsWith('gsk_WmwaCQxKltDu')) {
    trimmedKey = trimmedKey.replace('gsk_WmwaCQxKltDu', 'gsk_WmwaCQxKItDu');
  }

  try {
    if (provider === 'gemini') {
      if (!trimmedKey.startsWith('AIzaSy')) {
        return {
          success: false,
          message: 'Invalid key format. Google AI Studio keys must start with "AIzaSy...". The provided token ("' + trimmedKey.slice(0, 8) + '...") is an OAuth credential, not an AI Studio API key. Please get your key at https://aistudio.google.com/apikey',
        };
      }
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
