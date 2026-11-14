import { useState, useEffect, useRef } from 'react';
import type { AiChatMessage, AiProvider } from '../../types/ai';
import {
  AI_MODELS,
  loadAiSettings,
  saveAiSettings,
  saveAiSettingsToDataverse,
  fetchAiSettingsFromDataverse,
} from '../../lib/ai/aiConfigStore';
import { executeAiCompletion } from '../../lib/ai/aiClient';
import { COPILOT_TOOLS, executeCopilotTool } from '../../lib/ai/aiTools';
import { getAiAppContext, subscribeAiAppContext, type AiAppContext } from '../../lib/ai/aiContextStore';
import type { OptimizationResult } from '../../lib/ai/aiOptimizer';
import { useAuth, type AuthUser } from '../../context/auth';
import { MarkdownMessage } from './MarkdownMessage';

function buildSystemPrompt(user: AuthUser, ctx: AiAppContext): string {
  const isAdmin = user.role === 'admin';
  const setupInfo = ctx.setup
    ? `Active Setup: "${ctx.setup.name}" (ID: ${ctx.setup.id}, ${ctx.setup.assignments?.length ?? 0} machine assignments, shift time ${ctx.setup.shiftTime ?? 480} min)`
    : 'No active Production Setup is currently selected.';

  let simContext = '';
  if (ctx.simulationMetrics) {
    const sm = ctx.simulationMetrics;
    const topActivities = sm.activityBreakdown.slice(0, 8).map((a) => `${a.activity}: ${a.percent}%`).join(', ');
    const topDowntimes = sm.topDowntimeReasons.slice(0, 4).map((d) => `${d.reason}: ${d.minutes}m`).join(', ');
    simContext = `
[LIVE SIMULATION SCREEN DATA]
The user is currently on the Production Simulation view! A simulation run or replay is loaded:
- Simulation Time: ${sm.clockFormatted} (Shift Complete: ${sm.isComplete ? 'Yes' : 'In Progress'})
- Machines Assigned: ${sm.machineCount} | Operators: ${sm.operatorCount}
- Equipment OEE: ${sm.oee}% | Availability: ${sm.availability}% | Quality: ${sm.quality}%
- Output: Total ${sm.tonageTotal} ton (FP: ${sm.tonageFp} ton, Semi-FP: ${sm.tonageSfp} ton)
- Labor Productivity (MHPT): ${sm.manHourPerTon} h/ton
- Operator Timeline Activities: ${topActivities}
- Top Downtime Causes: ${topDowntimes}
- Total Machine Downtime: ${sm.totalDowntimeMin} minutes
NOTE: You can read and refer to these exact numbers directly when the user asks questions about their simulation or setup!
`;
  } else {
    simContext = `
[LIVE APPLICATION SCREEN]
Current View: ${ctx.currentPage || 'Production Setup / Simulator'}
${setupInfo}
`;
  }

  return `You are the WLM Agent for the Bekaert WorkLoad Simulator manufacturing application.

[USER IDENTITY & ACCESS LEVEL]
- User: ${user.displayName || user.email} (${user.email})
- Role: ${user.role.toUpperCase()}
- Permission Tier: ${isAdmin ? 'Full Administrator' : 'Contribute User'}

[STRICT SECURITY & AUTHORIZATION POLICY]
${
  isAdmin
    ? '- The user is an Administrator with full permissions across all configurations.'
    : `- The current user has CONTRIBUTE role.
- STRICT RESTRICTION: The user is strictly FORBIDDEN from modifying or overriding system settings, Default Values (WL_DefaultValues), API keys, AI model settings, plant parameters, or master data tables.
- If the user asks you to change, update, overwrite, or delete master settings or configuration values, YOU MUST POLITELY REFUSE:
  "Mohon maaf, peran akun Anda adalah Contribute. Pengubahan konfigurasi sistem dan parameter default hanya dapat dilakukan oleh Admin. Silakan hubungi Administrator sistem."
- The user may only view simulation results, diagnose performance, and optimize machine allocations for setups they have access to.`
}

${simContext}

[MISSION & CORE RESPONSIBILITIES]
1. Assist users in analyzing operational performance metrics: OEE, downtime breakdown (especially waiting for operator), Man Occupation (operator workload), and MHPT (Manhour Per Ton).
2. Diagnose operational bottlenecks (e.g. excessive machine downtime waiting for operator vs labor cost inefficiencies from low occupation).
3. Optimize machine-to-operator assignments to achieve balanced Pareto-optimal output (high OEE vs efficient MHPT). Note: high OEE with high MHPT is unfavorable.
4. Output & Presentation Formatting:
   - Use clean Markdown tables with columns (e.g. | Metric | Current | Proposed |) when displaying multi-item comparisons or operator workloads.
   - Use bold for emphasis and bullet points for recommendations.
   - Do not output raw unformatted pipe delimiters outside tables.
5. Language flexibility: If the user communicates in Indonesian, respond naturally in Indonesian. If in English, respond in English. Always keep explanations clear, concise, and backed by calculated metrics.`;
}

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
    'Hello! I am your **WLM Agent** for WorkLoad Simulator. I can assist in analyzing setup performance (OEE, MHPT, Man Occupation), diagnosing downtime bottlenecks, and finding the optimal machine-to-operator assignment balancing high equipment OEE with efficient labor MHPT.\n\nHow can I help you today?',
  ),
];

const QUICK_PROMPTS = [
  { label: '📊 Analyze OEE & MHPT', prompt: 'Analyze the OEE, MHPT, and Man Occupation performance of the currently active setup.' },
  { label: '⚡ Optimize Machine Allocation', prompt: 'Find the optimal machine-to-operator assignment balancing high OEE and efficient MHPT.' },
  { label: '🔍 Diagnose Downtime Bottlenecks', prompt: 'Diagnose the main causes of machine downtime and operator workload distribution on this setup.' },
];

export function CopilotWidget() {
  const { user } = useAuth();
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

  // Sync AI settings from Dataverse table WL_DefaultValues on mount
  useEffect(() => {
    let cancelled = false;
    fetchAiSettingsFromDataverse()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((err) => {
        console.warn('Could not sync AI settings from Dataverse:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    saveAiSettingsToDataverse(next).catch((err) => {
      console.warn('Could not persist model switch to Dataverse:', err);
    });
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
          systemPrompt: buildSystemPrompt(user, appContext),
          tools: COPILOT_TOOLS,
        });

        // Check if model called any tools
        if (response.toolCalls && response.toolCalls.length > 0) {
          const assistantToolCallMsg = createChatMessage(
            'assistant',
            response.content || 'Processing instructions with simulator…',
            { toolCalls: response.toolCalls },
          );
          currentHistory = [...currentHistory, assistantToolCallMsg];
          setMessages(currentHistory);

          // Execute each tool
          for (const call of response.toolCalls) {
            let label = `Executing ${call.name}…`;
            if (call.name === 'optimize_machine_assignments') {
              label = '⚙️ Optimizing machine assignments (OEE vs MHPT)…';
            } else if (call.name === 'diagnose_setup_performance') {
              label = '🔍 Diagnosing downtime bottlenecks & operator workload…';
            } else if (call.name === 'get_current_setup_summary') {
              label = '📊 Fetching latest setup performance data…';
            } else if (call.name === 'get_current_simulation_results') {
              label = '📈 Reading live simulation run output & timeline…';
            }

            setActiveToolStatus(label);

            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
            } catch {
              parsedArgs = {};
            }

            const toolOutcome = await executeCopilotTool(call.name, parsedArgs, {
              user,
              setup: appContext.setup,
              resolvedConstructions: appContext.resolvedConstructions,
              simulationMetrics: appContext.simulationMetrics,
              lastOptimizationResult: appContext.lastOptimizationResult,
              setLastOptimizationResult: (res) => {
                setAppContext((prev) => ({ ...prev, lastOptimizationResult: res }));
              },
              onApplyAssignments: appContext.onApplyAssignments,
              onProgress: (status) => setActiveToolStatus(status),
            });

            const toolResultMsg = createChatMessage(
              'tool',
              JSON.stringify(toolOutcome.result),
              { name: call.name, toolCallId: call.id },
            );
            currentHistory = [...currentHistory, toolResultMsg];
            setMessages(currentHistory);
          }

          setActiveToolStatus('Analyzing calculation results…');
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
          `⚠️ **Failed to process:** ${errMsg}\n\n*Tip: You can switch models to DeepSeek Official, Groq Cloud, or OpenRouter via the dropdown in the header above.*`,
        ),
      ]);
    } finally {
      setIsLoading(false);
      setActiveToolStatus(null);
    }
  };

  const handleApplyOptimization = async (optResult: OptimizationResult) => {
    if (!appContext.onApplyAssignments) {
      alert('Machine allocation can only be applied while on the Production Setup page.');
      return;
    }
    if (user.role !== 'admin' && appContext.setup) {
      const userEmail = (user.email ?? '').trim().toLowerCase();
      const isOwner = (appContext.setup.createdByEmail ?? '').trim().toLowerCase() === userEmail;
      const isShared = (appContext.setup.sharedEmail ?? '').toLowerCase().includes(userEmail);
      if (!isOwner && !isShared) {
        alert('Permission denied: Contribute users can only apply allocations to setups they created or have edit rights for.');
        return;
      }
    }
    setApplyingOptimization(true);
    try {
      await appContext.onApplyAssignments(optResult);
      setMessages((prev) => [
        ...prev,
        createChatMessage(
          'assistant',
          `🎉 **Allocation Successfully Applied!**\n\nSetup now uses ${optResult.recommendedOperatorCount} operators with optimized machine assignments (OEE ~${optResult.bestMetrics.oee}%, MHPT ~${optResult.bestMetrics.mhptTotal} h/ton).`,
        ),
      ]);
    } catch (err) {
      alert(`Failed to apply allocation: ${err instanceof Error ? err.message : String(err)}`);
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
          title="Open WLM Agent"
        >
          <span className="ai-copilot-fab-icon">✨</span>
          <span>WLM Agent</span>
        </button>
      )}

      {/* Floating Chat Window */}
      {isOpen && (
        <div className="ai-copilot-window" role="dialog" aria-label="WLM Agent Chat">
          {/* Header */}
          <div className="ai-copilot-header">
            <div className="ai-header-left">
              <div className="ai-header-avatar">✨</div>
              <div>
                <h3 className="ai-header-title">WLM Agent</h3>
                <span className="ai-header-subtitle">
                  {appContext.simulationMetrics
                    ? `Sim: ${appContext.setup?.name ?? 'Live'} (${appContext.simulationMetrics.oee}% OEE)`
                    : appContext.setup
                      ? `Active: ${appContext.setup.name}`
                      : 'Ready to assist'}
                </span>
              </div>
            </div>

            <div className="ai-header-actions">
              {/* Quick Model Selector */}
              <select
                className="ai-model-quick-select"
                value={settings.activeModel}
                onChange={(e) => handleModelChange(e.target.value)}
                title="Instantly switch AI model"
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
                title="Close WLM Agent"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Rate Limit Banner */}
          {rateLimitError && (
            <div className="ai-test-result error" style={{ margin: '8px 12px 0', fontSize: '0.74rem' }}>
              <div>
                <strong>⚠️ Provider Rate Limit (429):</strong> Switch to an alternative provider?
                <div style={{ marginTop: '4px', display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="ai-prompt-chip"
                    onClick={() => handleQuickSwitchProvider('groq')}
                  >
                    ⚡ Switch to Groq (Fast)
                  </button>
                  <button
                    type="button"
                    className="ai-prompt-chip"
                    onClick={() => handleQuickSwitchProvider('openrouter')}
                  >
                    🌐 Switch to OpenRouter
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* API Key Missing Notice */}
          {!hasApiKey && (
            <div className="ai-test-result info" style={{ margin: '8px 12px 0', fontSize: '0.75rem' }}>
              <span>ℹ️ API Key for <strong>{settings.activeProvider.toUpperCase()}</strong> is not set. Go to <strong>Settings &gt; WLM Agent</strong> to configure a free key.</span>
            </div>
          )}

          {/* Chat Messages */}
          <div className="ai-chat-body">
            {messages.map((msg) => {
              if (msg.role === 'tool') return null; // Hide raw tool data
              const isAssistant = msg.role === 'assistant';

              return (
                <div key={msg.id} className={`ai-msg ${msg.role}`}>
                  <MarkdownMessage content={msg.content} />

                  {/* Render 1-click Apply Button if optimization was produced */}
                  {isAssistant && appContext.lastOptimizationResult && (
                    <div style={{ marginTop: '8px' }}>
                      <button
                        type="button"
                        className="ai-action-btn-inline"
                        onClick={() => void handleApplyOptimization(appContext.lastOptimizationResult!)}
                        disabled={applyingOptimization}
                      >
                        {applyingOptimization ? '⏳ Applying Allocation…' : `🚀 Apply Allocation (${appContext.lastOptimizationResult.recommendedOperatorCount} Operators)`}
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
              placeholder={hasApiKey ? 'Type a message or instruction for WLM Agent…' : 'Enter API Key in Settings first…'}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isLoading}
            />
            <button
              type="submit"
              className="ai-send-btn"
              disabled={isLoading || !inputText.trim()}
            >
              {isLoading ? '…' : 'Send'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
