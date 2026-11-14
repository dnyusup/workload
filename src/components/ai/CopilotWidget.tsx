import { useState, useEffect, useRef } from 'react';
import type { AiChatMessage, AiProvider } from '../../types/ai';
import {
  AI_MODELS,
  loadAiSettings,
  saveAiSettings,
} from '../../lib/ai/aiConfigStore';
import { executeAiCompletion } from '../../lib/ai/aiClient';
import { COPILOT_TOOLS, executeCopilotTool } from '../../lib/ai/aiTools';
import { getAiAppContext, subscribeAiAppContext } from '../../lib/ai/aiContextStore';
import type { OptimizationResult } from '../../lib/ai/aiOptimizer';

const SYSTEM_PROMPT = `Anda adalah AI Copilot untuk aplikasi WorkLoad Simulator manufaktur Bekaert.
Tugas utama Anda:
1. Membantu pengguna menganalisa metrik performa: OEE (Overall Equipment Effectiveness), downtime (termasuk waktu tunggu operator), Man Occupation (kesibukan operator), dan MHPT (Manhour Per Ton).
2. Mendiagnosa bottleneck operasional (apakah mesin terlalu lama menunggu operator, atau sebaliknya operator terlalu banyak sehingga MHPT boros).
3. Mengoptimalkan pembagian alokasi mesin ke operator untuk mencapai output optimum dengan menyeimbangkan OEE tinggi dan MHPT efisien (OEE tinggi tapi MHPT tinggi juga tidak bagus).
4. Menjelaskan trade-off dengan bahasa Indonesia yang jelas, ringkas, dan berbasis data teknis.
5. Selalu gunakan tools yang tersedia untuk mengambil data setup terkini, menganalisa, atau mengoptimalkan mesin sebelum menjawab pertanyaan terkait performa setup.`;

let msgSequence = 0;
function createChatMessage(
  role: 'user' | 'assistant' | 'tool',
  content: string,
  extra?: Partial<AiChatMessage>,
): AiChatMessage {
  msgSequence += 1;
  return {
    id: `msg-${msgSequence}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

const INITIAL_MESSAGES: AiChatMessage[] = [
  createChatMessage(
    'assistant',
    'Halo! Saya **AI Copilot** untuk WorkLoad Simulator. Saya dapat membantu menganalisa performa setup (OEE, MHPT, Man Occupation), mendiagnosa antrian downtime mesin, dan menemukan alokasi pembagian mesin ke operator yang paling seimbang antara OEE tinggi dan MHPT efisien.\n\nApa yang ingin Anda analisa hari ini?',
  ),
];

const QUICK_PROMPTS = [
  { label: '📊 Analisa OEE & MHPT', prompt: 'Analisa performa OEE, MHPT, dan Man Occupation pada setup yang sedang aktif ini.' },
  { label: '⚡ Optimalkan Pembagian Mesin', prompt: 'Carikan pembagian mesin ke operator yang paling optimum, seimbangkan OEE tinggi dan MHPT yang efisien.' },
  { label: '🔍 Diagnosa Bottleneck Downtime', prompt: 'Diagnosa penyebab utama downtime mesin dan ketimpangan beban kerja operator pada setup ini.' },
];

export function CopilotWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [messages, setMessages] = useState<AiChatMessage[]>(INITIAL_MESSAGES);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeToolStatus, setActiveToolStatus] = useState<string | null>(null);
  const [appContext, setAppContext] = useState(() => getAiAppContext());
  const [applyingOptimization, setApplyingOptimization] = useState(false);
  const [rateLimitError, setRateLimitError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Subscribe to live setup context changes
  useEffect(() => {
    return subscribeAiAppContext((ctx) => {
      setAppContext(ctx);
    });
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, activeToolStatus]);

  const handleModelChange = (modelId: string) => {
    const meta = AI_MODELS.find((m) => m.id === modelId);
    if (!meta) return;
    const next = {
      ...settings,
      activeModel: meta.id,
      activeProvider: meta.provider,
    };
    setSettings(next);
    saveAiSettings(next);
    setRateLimitError(null);
  };

  const handleQuickSwitchProvider = (prov: AiProvider) => {
    const model = AI_MODELS.find((m) => m.provider === prov);
    if (!model) return;
    handleModelChange(model.id);
  };

  const handleSendMessage = async (userText: string) => {
    const trimmed = userText.trim();
    if (!trimmed || isLoading) return;

    setRateLimitError(null);
    const userMsg = createChatMessage('user', trimmed);

    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInputText('');
    setIsLoading(true);

    try {
      let currentHistory = nextHistory;
      let keepLooping = true;
      let iterations = 0;

      while (keepLooping && iterations < 5) {
        iterations++;
        const response = await executeAiCompletion({
          settings,
          messages: currentHistory,
          systemPrompt: SYSTEM_PROMPT,
          tools: COPILOT_TOOLS,
        });

        // Check if model called any tools
        if (response.toolCalls && response.toolCalls.length > 0) {
          const assistantToolCallMsg = createChatMessage(
            'assistant',
            response.content || 'Sedang memproses instruksi dengan simulator…',
            { toolCalls: response.toolCalls },
          );
          currentHistory = [...currentHistory, assistantToolCallMsg];
          setMessages(currentHistory);

          // Execute each tool
          for (const call of response.toolCalls) {
            let label = `Menjalankan ${call.name}…`;
            if (call.name === 'optimize_machine_assignments') {
              label = '⚙️ Menghitung optimasi pembagian mesin (OEE vs MHPT)…';
            } else if (call.name === 'diagnose_setup_performance') {
              label = '🔍 Mendiagnosa bottleneck downtime & utilisasi operator…';
            } else if (call.name === 'get_current_setup_summary') {
              label = '📊 Mengambil data performa setup terkini…';
            }

            setActiveToolStatus(label);

            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
            } catch {
              parsedArgs = {};
            }

            const toolOutcome = await executeCopilotTool(call.name, parsedArgs, {
              setup: appContext.setup,
              resolvedConstructions: appContext.resolvedConstructions,
              lastOptimizationResult: appContext.lastOptimizationResult,
              setLastOptimizationResult: (res) => {
                setAppContext((prev) => ({ ...prev, lastOptimizationResult: res }));
              },
              onApplyAssignments: appContext.onApplyAssignments,
            });

            const toolResultMsg = createChatMessage(
              'tool',
              JSON.stringify(toolOutcome.result),
              { name: call.name, toolCallId: call.id },
            );
            currentHistory = [...currentHistory, toolResultMsg];
            setMessages(currentHistory);
          }

          setActiveToolStatus('Menganalisa hasil perhitungan…');
        } else {
          // Final assistant text response
          const finalAssistantMsg = createChatMessage('assistant', response.content);
          setMessages([...currentHistory, finalAssistantMsg]);
          keepLooping = false;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('quota')) {
        setRateLimitError(errMsg);
      }

      setMessages((prev) => [
        ...prev,
        createChatMessage(
          'assistant',
          `⚠️ **Gagal memproses:** ${errMsg}\n\n*Tips: Jika kuota habis, Anda dapat mengganti model ke Groq Cloud atau OpenRouter pada dropdown di atas.*`,
        ),
      ]);
    } finally {
      setIsLoading(false);
      setActiveToolStatus(null);
    }
  };

  const handleApplyOptimization = async (optResult: OptimizationResult) => {
    if (!appContext.onApplyAssignments) {
      alert('Fitur penerapan alokasi hanya dapat dilakukan saat membuka halaman Production Setup.');
      return;
    }
    setApplyingOptimization(true);
    try {
      await appContext.onApplyAssignments(optResult);
      setMessages((prev) => [
        ...prev,
        createChatMessage(
          'assistant',
          `🎉 **Alokasi Berhasil Diterapkan!**\n\nSetup sekarang menggunakan ${optResult.recommendedOperatorCount} operator dengan pembagian mesin yang telah dioptimalkan (OEE ~${optResult.bestMetrics.oee}%, MHPT ~${optResult.bestMetrics.mhptTotal} h/ton).`,
        ),
      ]);
    } catch (err) {
      alert(`Gagal menerapkan alokasi: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplyingOptimization(false);
    }
  };

  const hasApiKey = Boolean(settings.providers[settings.activeProvider]?.apiKey?.trim());

  return (
    <>
      {/* Floating Action Button */}
      {!isOpen && (
        <button
          type="button"
          className="ai-copilot-fab"
          onClick={() => setIsOpen(true)}
          title="Buka AI Copilot"
        >
          <span className="ai-copilot-fab-icon">✨</span>
          <span>AI Copilot</span>
        </button>
      )}

      {/* Floating Chat Window */}
      {isOpen && (
        <div className="ai-copilot-window" role="dialog" aria-label="AI Copilot Chat">
          {/* Header */}
          <div className="ai-copilot-header">
            <div className="ai-header-left">
              <div className="ai-header-avatar">✨</div>
              <div>
                <h3 className="ai-header-title">AI Copilot</h3>
                <span className="ai-header-subtitle">
                  {appContext.setup ? `Active: ${appContext.setup.name}` : 'Ready to assist'}
                </span>
              </div>
            </div>

            <div className="ai-header-actions">
              {/* Quick Model Selector */}
              <select
                className="ai-model-quick-select"
                value={settings.activeModel}
                onChange={(e) => handleModelChange(e.target.value)}
                title="Ganti Model AI secara instan"
              >
                <optgroup label="Gemini (Google AI)">
                  {AI_MODELS.filter((m) => m.provider === 'gemini').map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
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
                <optgroup label="Groq Cloud (Fast)">
                  {AI_MODELS.filter((m) => m.provider === 'groq').map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="OpenRouter (Free Hub)">
                  {AI_MODELS.filter((m) => m.provider === 'openrouter').map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              </select>

              <button
                type="button"
                className="ai-close-btn"
                onClick={() => setIsOpen(false)}
                title="Tutup AI Copilot"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Rate Limit Banner */}
          {rateLimitError && (
            <div className="ai-test-result error" style={{ margin: '8px 12px 0', fontSize: '0.74rem' }}>
              <div>
                <strong>⚠️ Kuota Provider Limit (429):</strong> Ingin pindah ke provider lain?
                <div style={{ marginTop: '4px', display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="ai-prompt-chip"
                    onClick={() => handleQuickSwitchProvider('groq')}
                  >
                    ⚡ Switch ke Groq (Cepat)
                  </button>
                  <button
                    type="button"
                    className="ai-prompt-chip"
                    onClick={() => handleQuickSwitchProvider('openrouter')}
                  >
                    🌐 Switch ke OpenRouter
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* API Key Missing Notice */}
          {!hasApiKey && (
            <div className="ai-test-result info" style={{ margin: '8px 12px 0', fontSize: '0.75rem' }}>
              <span>ℹ️ API Key untuk <strong>{settings.activeProvider.toUpperCase()}</strong> belum diisi. Buka menu <strong>Settings &gt; AI Copilot</strong> untuk memasukkan API Key gratis.</span>
            </div>
          )}

          {/* Chat Messages */}
          <div className="ai-chat-body">
            {messages.map((msg) => {
              if (msg.role === 'tool') return null; // Hide raw tool data
              const isAssistant = msg.role === 'assistant';

              return (
                <div key={msg.id} className={`ai-msg ${msg.role}`}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>
                    {msg.content}
                  </div>

                  {/* Render 1-click Apply Button if optimization was produced */}
                  {isAssistant && appContext.lastOptimizationResult && (
                    <div style={{ marginTop: '8px' }}>
                      <button
                        type="button"
                        className="ai-action-btn-inline"
                        onClick={() => void handleApplyOptimization(appContext.lastOptimizationResult!)}
                        disabled={applyingOptimization}
                      >
                        {applyingOptimization ? '⏳ Menerapkan Alokasi…' : `🚀 Terapkan Alokasi (${appContext.lastOptimizationResult.recommendedOperatorCount} Operator)`}
                      </button>
                    </div>
                  )}

                  <span className="ai-msg-time">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}

            {/* Active Tool Badge */}
            {activeToolStatus && (
              <div className="ai-tool-badge running">
                <span>{activeToolStatus}</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompts */}
          <div className="ai-quick-prompts">
            {QUICK_PROMPTS.map((qp, idx) => (
              <button
                key={idx}
                type="button"
                className="ai-prompt-chip"
                onClick={() => void handleSendMessage(qp.prompt)}
                disabled={isLoading}
              >
                {qp.label}
              </button>
            ))}
          </div>

          {/* Input Form */}
          <form
            className="ai-input-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSendMessage(inputText);
            }}
          >
            <input
              type="text"
              className="ai-chat-input"
              placeholder={hasApiKey ? 'Ketik pesan atau instruksi untuk Copilot…' : 'Masukkan API Key di Settings terlebih dahulu…'}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isLoading}
            />
            <button
              type="submit"
              className="ai-send-btn"
              disabled={isLoading || !inputText.trim()}
            >
              {isLoading ? '…' : 'Kirim'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
