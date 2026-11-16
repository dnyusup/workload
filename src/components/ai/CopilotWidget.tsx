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
import { WLM_APP_NAVIGATION_GUIDE, WLM_FORMULAS_KNOWLEDGE } from '../../lib/ai/aiKnowledgeBase';

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
    const opMetricsSummary =
      sm.operatorMetrics && sm.operatorMetrics.length > 0
        ? sm.operatorMetrics
            .map(
              (op) =>
                `- ${op.operatorLabel}: Actual Man Occupation = ${op.actualManOccupation}% (Working: ${op.workingPercent}%, Walking: ${op.walkingPercent}%, Idle: ${op.idlePercent}%, Machines: ${op.machineCount} [${op.assignedMachines.join(', ')}])`,
            )
            .join('\n')
        : 'Operator metrics loading...';

    simContext = `
[LIVE SIMULATION SCREEN DATA]
The user is currently on the Production Simulation view! A simulation run or replay is loaded:
- Simulation Time: ${sm.clockFormatted} (Shift Complete: ${sm.isComplete ? 'Yes' : 'In Progress'})
- Machines Assigned: ${sm.machineCount} | Operators: ${sm.operatorCount}
- Equipment OEE: ${sm.oee}% | Availability: ${sm.availability}% | Quality: ${sm.quality}%
- Output: Total ${sm.tonageTotal} ton (FP: ${sm.tonageFp} ton, Semi-FP: ${sm.tonageSfp} ton)
- Labor Productivity (MHPT): ${sm.manHourPerTon} h/ton
- Machine Waiting Handling: ${sm.waitingHandlingPercent}% (${sm.waitingHandlingMinutes} minutes machines stopped waiting for operator)
- Operator Timeline Activities: ${topActivities}
- Top Downtime Causes: ${topDowntimes}
- Total Machine Downtime: ${sm.totalDowntimeMin} minutes

[ACTUAL MAN OCCUPATION PER OPERATOR (POST-SIMULATION)]:
${opMetricsSummary}

CRITICAL METRIC CLARIFICATION:
- When the user asks about "Man Occupation" or "Utilization" while a simulation is loaded, REFER DIRECTLY TO THE ACTUAL MAN OCCUPATION LISTED ABOVE (working % + walking %)!
- Never give an estimated average when the user asks about a specific operator after simulation!
- Clearly explain the components: Actual Man Occupation = Working % + Walking %. The remaining is Idle %.
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

${WLM_APP_NAVIGATION_GUIDE}

${WLM_FORMULAS_KNOWLEDGE}

[MISSION & CORE RESPONSIBILITIES]
1. Guidance & Application Navigator:
   - You know every feature and menu of the WorkLoad app. Explain concepts and workflows clearly.
   - If the user asks to open or go to a menu/page (e.g. "buka menu frequency", "bawa saya ke layouts", "lihat actual output"), call the "navigate_to_page" tool immediately!
2. Teaching Mathematical Formulas & Logic:
   - When asked about calculations, explain step-by-step using formulas from the Technical Formulas section above.
   - Clarify the difference between Forecast Man Occupation (pre-simulation theoretical workload) and Actual Man Occupation (post-simulation recorded working + walking %).
3. Operational Performance & Bottleneck Diagnosis:
   - Analyze OEE, Waiting Handling, MHPT, and operator workloads.
   - Diagnose why OEE drops (e.g. machines queuing for operators, walking distances).
4. Machine Allocation Optimization:
   - Optimize machine-to-operator assignments balancing high OEE and low MHPT.
   - Ensure clustered physical row layouts to minimize operator walking distance.
5. Presentation & Formatting:
   - Use clean Markdown tables with columns (e.g. | Operator | Actual Man Occ | Working | Walking | Idle | Machines |).
   - Use bold for emphasis and bullet points for recommendations.
   - If the user asks in Indonesian, respond naturally in Indonesian. If in English, respond in English.`;
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

  // Draggable and Resizable Window State
  const [windowSize, setWindowSize] = useState<{ width: number; height: number }>({
    width: 440,
    height: 620,
  });
  const [windowPos, setWindowPos] = useState<{ x: number; y: number } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Keep window clamped within viewport on browser window resize
  useEffect(() => {
    const handleViewportResize = () => {
      setWindowPos((prev) => {
        if (!prev) return prev;
        const clampedX = Math.min(Math.max(8, prev.x), Math.max(8, window.innerWidth - windowSize.width - 8));
        const clampedY = Math.min(Math.max(8, prev.y), Math.max(8, window.innerHeight - windowSize.height - 8));
        return { x: clampedX, y: clampedY };
      });
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, [windowSize]);

  const handleOpen = () => {
    if (!windowPos) {
      const initX = Math.max(16, window.innerWidth - windowSize.width - 24);
      const initY = Math.max(16, window.innerHeight - windowSize.height - 24);
      setWindowPos({ x: initX, y: initY });
    }
    setIsOpen(true);
  };

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, select, input, a, .ai-model-quick-select')) {
      return;
    }
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const currentX = windowPos?.x ?? Math.max(16, window.innerWidth - windowSize.width - 24);
    const currentY = windowPos?.y ?? Math.max(16, window.innerHeight - windowSize.height - 24);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const nextX = Math.min(Math.max(8, currentX + deltaX), window.innerWidth - windowSize.width - 8);
      const nextY = Math.min(Math.max(8, currentY + deltaY), window.innerHeight - windowSize.height - 8);
      setWindowPos({ x: nextX, y: nextY });
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleResizePointerDown = (direction: string, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = windowSize.width;
    const startHeight = windowSize.height;
    const startPosX = windowPos?.x ?? Math.max(16, window.innerWidth - windowSize.width - 24);
    const startPosY = windowPos?.y ?? Math.max(16, window.innerHeight - windowSize.height - 24);

    const minWidth = 340;
    const minHeight = 400;
    const maxWidth = Math.max(minWidth, window.innerWidth - 24);
    const maxHeight = Math.max(minHeight, window.innerHeight - 24);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextPosX = startPosX;
      let nextPosY = startPosY;

      if (direction.includes('e')) {
        nextWidth = Math.min(Math.max(minWidth, startWidth + deltaX), maxWidth);
      } else if (direction.includes('w')) {
        const proposedWidth = Math.min(Math.max(minWidth, startWidth - deltaX), maxWidth);
        nextPosX = startPosX + (startWidth - proposedWidth);
        nextWidth = proposedWidth;
      }

      if (direction.includes('s')) {
        nextHeight = Math.min(Math.max(minHeight, startHeight + deltaY), maxHeight);
      } else if (direction.includes('n')) {
        const proposedHeight = Math.min(Math.max(minHeight, startHeight - deltaY), maxHeight);
        nextPosY = startPosY + (startHeight - proposedHeight);
        nextHeight = proposedHeight;
      }

      setWindowSize({ width: nextWidth, height: nextHeight });
      setWindowPos({ x: nextPosX, y: nextPosY });
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

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
            } else if (call.name === 'navigate_to_page') {
              label = '🧭 Navigating to requested page…';
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
              onNavigate: appContext.onNavigate,
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
    setActiveToolStatus('Applying allocation to setup…');
    try {
      await appContext.onApplyAssignments(optResult, (phase, done, total) => {
        setActiveToolStatus(`⚙️ ${phase} (${done}/${total})`);
      });
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
      setActiveToolStatus(null);
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
          onClick={handleOpen}
          title="Open WLM Agent"
        >
          <span className="ai-copilot-fab-icon">✨</span>
          <span>WLM Agent</span>
        </button>
      )}

      {/* Floating Chat Window (Draggable & Resizable) */}
      {isOpen && (
        <div
          className="ai-copilot-window"
          role="dialog"
          aria-label="WLM Agent Chat"
          style={{
            left: windowPos ? `${windowPos.x}px` : undefined,
            top: windowPos ? `${windowPos.y}px` : undefined,
            right: windowPos ? 'auto' : '24px',
            bottom: windowPos ? 'auto' : '24px',
            width: `${windowSize.width}px`,
            height: `${windowSize.height}px`,
          }}
        >
          {/* Resize handles */}
          <div className="ai-resize-handle ai-resize-n" onPointerDown={(e) => handleResizePointerDown('n', e)} />
          <div className="ai-resize-handle ai-resize-s" onPointerDown={(e) => handleResizePointerDown('s', e)} />
          <div className="ai-resize-handle ai-resize-w" onPointerDown={(e) => handleResizePointerDown('w', e)} />
          <div className="ai-resize-handle ai-resize-e" onPointerDown={(e) => handleResizePointerDown('e', e)} />
          <div className="ai-resize-handle ai-resize-nw" onPointerDown={(e) => handleResizePointerDown('nw', e)} />
          <div className="ai-resize-handle ai-resize-ne" onPointerDown={(e) => handleResizePointerDown('ne', e)} />
          <div className="ai-resize-handle ai-resize-sw" onPointerDown={(e) => handleResizePointerDown('sw', e)} />
          <div
            className="ai-resize-handle ai-resize-se"
            onPointerDown={(e) => handleResizePointerDown('se', e)}
            title="Drag corner to resize window"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" className="ai-resize-corner-icon">
              <line x1="8" y1="2" x2="2" y2="8" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="8" y1="5" x2="5" y2="8" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>

          {/* Header (Draggable) */}
          <div
            className="ai-copilot-header"
            onPointerDown={handleHeaderPointerDown}
            title="Click and drag header to move window"
          >
            <div className="ai-header-left">
              <div className="ai-header-avatar">✨</div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <h3 className="ai-header-title">WLM Agent</h3>
                  <span style={{ fontSize: '0.7rem', color: '#64748b', cursor: 'grab' }} title="Drag header to move">⋮⋮</span>
                </div>
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
