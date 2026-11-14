import type { AiModelOption, AiProvider, AiSettings } from '../../types/ai';

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
      'Buka Google AI Studio melalui tombol di bawah (login dengan akun Google Anda).',
      'Klik tombol biru "+ Create API key".',
      'Pilih "Create key in new project" (atau gunakan project GCP yang ada).',
      'Salin API Key yang diawali "AIzaSy..." lalu tempelkan di field input di atas.',
    ],
    tips: 'Tanpa perlu kartu kredit. Memberikan kuota 15 request per menit dan 1.500 request per hari secara gratis.',
  },
  deepseek: {
    title: 'DeepSeek Official API',
    badge: 'Official Platform · High Quality',
    portalUrl: 'https://platform.deepseek.com/api_keys',
    portalLabel: 'Open DeepSeek Platform',
    steps: [
      'Buka DeepSeek Open Platform dan login atau daftar akun baru.',
      'Masuk ke menu "API Keys" di navigasi sebelah kiri.',
      'Klik tombol "Create new secret key", beri nama label (misal: Workload).',
      'Salin kunci rahasia yang diawali "sk-..." lalu tempelkan di sini.',
    ],
    tips: 'Pengguna baru biasanya mendapatkan saldo bonus gratis. Setelahnya biayanya sangat murah (sekitar $0.14 per 1 juta token).',
  },
  groq: {
    title: 'Groq Cloud',
    badge: '100% Free · Ultra Fast (300+ tok/s)',
    portalUrl: 'https://console.groq.com/keys',
    portalLabel: 'Open Groq Console',
    steps: [
      'Buka Groq Console dan login dengan akun Google atau GitHub Anda.',
      'Klik tab "API Keys" di menu kiri.',
      'Klik tombol "Create API Key", beri nama (misal: WorkloadSim).',
      'Salin kunci yang diawali "gsk_..." lalu tempelkan di sini.',
    ],
    tips: 'Gratis 100% tanpa kartu kredit. Memiliki kecepatan inferensi tercepat di dunia untuk Llama 3.3 dan DeepSeek-R1 Distill.',
  },
  openrouter: {
    title: 'OpenRouter Multi-Model',
    badge: '1 Key for Multiple Free Models',
    portalUrl: 'https://openrouter.ai/keys',
    portalLabel: 'Open OpenRouter Keys',
    steps: [
      'Buka OpenRouter dan login via akun Google atau GitHub.',
      'Klik tombol "Create Key" dan beri nama (misal: Workload Agent).',
      'Salin kunci yang diawali "sk-or-v1-..." lalu tempelkan di sini.',
    ],
    tips: 'Satu API Key bisa langsung dipakai untuk puluhan model open-source berlabel ":free" (termasuk DeepSeek-R1 dan Llama 3.3).',
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

/** Tests if an API key is valid by querying the provider's models or ping endpoint. */
export async function testProviderConnection(provider: AiProvider, apiKey: string, customEndpoint?: string): Promise<{ success: boolean; message: string }> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { success: false, message: 'API Key masih kosong.' };
  }

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmedKey)}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = (errorData as { error?: { message?: string } })?.error?.message ?? `Status ${res.status}`;
        return { success: false, message: `Gagal: ${msg}` };
      }
      return { success: true, message: 'Koneksi ke Google Gemini berhasil!' };
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
        return { success: false, message: `Gagal: ${msg}` };
      }
      return { success: true, message: 'Koneksi ke DeepSeek API berhasil!' };
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
        return { success: false, message: `Gagal: ${msg}` };
      }
      return { success: true, message: 'Koneksi ke Groq Cloud berhasil!' };
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
        return { success: false, message: `Gagal: ${msg}` };
      }
      return { success: true, message: 'Koneksi ke OpenRouter berhasil!' };
    }

    return { success: false, message: 'Provider tidak dikenal.' };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Gagal menghubungi server provider.' };
  }
}
