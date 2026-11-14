import { useState } from 'react';
import type { AiConnectionStatus, AiProvider } from '../../types/ai';
import {
  AI_MODELS,
  PROVIDER_GUIDES,
  loadAiSettings,
  saveAiSettings,
  testProviderConnection,
} from '../../lib/ai/aiConfigStore';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';

export function AiSettingsCard() {
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [showKeys, setShowKeys] = useState<Record<AiProvider, boolean>>({
    gemini: false,
    deepseek: false,
    groq: false,
    openrouter: false,
  });
  const [expandedGuide, setExpandedGuide] = useState<AiProvider | null>(null);
  const [testStatuses, setTestStatuses] = useState<Record<AiProvider, { status: AiConnectionStatus; message: string }>>({
    gemini: { status: 'idle', message: '' },
    deepseek: { status: 'idle', message: '' },
    groq: { status: 'idle', message: '' },
    openrouter: { status: 'idle', message: '' },
  });
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const triggerSaveNotice = () => {
    setSaveNotice('Pengaturan tersimpan');
    setTimeout(() => setSaveNotice(null), 2500);
  };

  const handleKeyChange = (provider: AiProvider, apiKey: string) => {
    setSettings((prev) => {
      const next = {
        ...prev,
        providers: {
          ...prev.providers,
          [provider]: {
            ...prev.providers[provider],
            apiKey,
            enabled: Boolean(apiKey.trim()),
          },
        },
      };
      saveAiSettings(next);
      return next;
    });
    triggerSaveNotice();
    setTestStatuses((prev) => ({
      ...prev,
      [provider]: { status: 'idle', message: '' },
    }));
  };

  const handleTestKey = async (provider: AiProvider) => {
    const key = settings.providers[provider]?.apiKey ?? '';
    setTestStatuses((prev) => ({
      ...prev,
      [provider]: { status: 'testing', message: 'Menguji koneksi ke server provider…' },
    }));

    const result = await testProviderConnection(provider, key);
    setTestStatuses((prev) => ({
      ...prev,
      [provider]: {
        status: result.success ? 'connected' : 'error',
        message: result.message,
      },
    }));
  };

  const toggleShowKey = (provider: AiProvider) => {
    setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  const toggleGuide = (provider: AiProvider) => {
    setExpandedGuide((prev) => (prev === provider ? null : provider));
  };

  const handleModelChange = (modelId: string) => {
    const model = AI_MODELS.find((m) => m.id === modelId);
    if (!model) return;
    setSettings((prev) => {
      const next = {
        ...prev,
        activeModel: model.id,
        activeProvider: model.provider,
      };
      saveAiSettings(next);
      return next;
    });
    triggerSaveNotice();
  };

  const activeModelMeta = AI_MODELS.find((m) => m.id === settings.activeModel);

  return (
    <div className="ai-settings-wrap">
      <Card
        title="AI Copilot & Multi-Provider Settings"
        subtitle="Konfigurasikan model kecerdasan buatan untuk mengoperasikan simulator dan mengoptimalkan pembagian mesin (OEE vs MHPT)."
        actions={saveNotice ? <span className="ai-save-badge">{saveNotice}</span> : undefined}
      >
        <div className="ai-active-model-box">
          <div className="ai-active-model-header">
            <div>
              <strong className="ai-section-title">Model Aktif Utama</strong>
              <p className="ai-section-desc">Pilih model default yang akan digunakan pertama kali oleh Copilot.</p>
            </div>
            <select
              className="input ai-model-select"
              value={settings.activeModel}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <optgroup label="Google Gemini (Free Tier)">
                {AI_MODELS.filter((m) => m.provider === 'gemini').map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.isFree ? '· Free' : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="DeepSeek Official">
                {AI_MODELS.filter((m) => m.provider === 'deepseek').map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Groq Cloud (Free Tier & Fast)">
                {AI_MODELS.filter((m) => m.provider === 'groq').map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.isFree ? '· Free' : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="OpenRouter (Multi-Model Hub)">
                {AI_MODELS.filter((m) => m.provider === 'openrouter').map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.isFree ? '· Free' : ''}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          {activeModelMeta && (
            <div className="ai-model-summary-pill">
              <span>{activeModelMeta.description}</span>
              {activeModelMeta.contextTokens && (
                <span className="ai-token-tag">Context: {(activeModelMeta.contextTokens / 1000).toLocaleString()}k tokens</span>
              )}
            </div>
          )}
        </div>

        <div className="ai-providers-grid">
          {(['gemini', 'deepseek', 'groq', 'openrouter'] as AiProvider[]).map((provKey) => {
            const guide = PROVIDER_GUIDES[provKey];
            const cfg = settings.providers[provKey];
            const test = testStatuses[provKey];
            const isGuideOpen = expandedGuide === provKey;
            const isVisible = showKeys[provKey];

            return (
              <div key={provKey} className={`ai-provider-card ${settings.activeProvider === provKey ? 'is-active-provider' : ''}`}>
                <div className="ai-provider-card-header">
                  <div>
                    <h4 className="ai-provider-title">{guide.title}</h4>
                    <span className="ai-provider-badge">{guide.badge}</span>
                  </div>
                  {settings.activeProvider === provKey && <span className="ai-active-pill">Active Default</span>}
                </div>

                <div className="ai-key-input-row">
                  <div className="ai-input-with-toggle">
                    <input
                      type={isVisible ? 'text' : 'password'}
                      className="input input-sm ai-key-input"
                      placeholder={`Masukkan ${provKey.toUpperCase()} API Key…`}
                      value={cfg.apiKey}
                      onChange={(e) => handleKeyChange(provKey, e.target.value)}
                    />
                    <button
                      type="button"
                      className="ai-icon-btn"
                      onClick={() => toggleShowKey(provKey)}
                      title={isVisible ? 'Sembunyikan' : 'Tampilkan'}
                    >
                      {isVisible ? '🙈' : '👁️'}
                    </button>
                  </div>
                  <Button
                    variant="secondary"
                    className="ai-test-btn"
                    onClick={() => void handleTestKey(provKey)}
                    disabled={!cfg.apiKey.trim() || test.status === 'testing'}
                  >
                    {test.status === 'testing' ? 'Testing…' : 'Test Key'}
                  </Button>
                </div>

                {test.status !== 'idle' && (
                  <div className={`ai-test-result ${test.status === 'connected' ? 'success' : test.status === 'error' ? 'error' : 'info'}`}>
                    <span>{test.status === 'connected' ? '✓ ' : test.status === 'error' ? '✕ ' : '⏳ '}</span>
                    {test.message}
                  </div>
                )}

                <div className="ai-guide-toggle-row">
                  <button
                    type="button"
                    className="ai-guide-btn"
                    onClick={() => toggleGuide(provKey)}
                  >
                    <span>{isGuideOpen ? '▼ Sembunyikan Panduan' : '▶ 📖 Cara Mendapatkan API Key Gratis'}</span>
                  </button>
                  <a
                    href={guide.portalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ai-portal-link"
                  >
                    {guide.portalLabel} ↗
                  </a>
                </div>

                {isGuideOpen && (
                  <div className="ai-guide-body">
                    <ol className="ai-guide-steps">
                      {guide.steps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ol>
                    <p className="ai-guide-tips">💡 <strong>Catatan:</strong> {guide.tips}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
