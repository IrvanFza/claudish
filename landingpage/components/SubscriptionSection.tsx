import {
  Bot,
  Brain,
  Check,
  Cloud,
  Zap as FastIcon,
  HardDrive,
  MessageSquareCode,
  Moon,
  ShieldCheck,
  Sparkles,
  Wallet,
  Zap,
  Code2,
  Server,
  Globe,
  Cpu,
} from "lucide-react";
import type React from "react";

const SUBSCRIPTIONS = [
  {
    name: "Anthropic Max",
    command: "Native support",
    icon: Brain,
    color: "text-orange-400",
    bg: "bg-orange-500/10",
    border: "border-orange-500/20",
  },
  {
    name: "Gemini Advanced",
    command: "g@gemini-2.5-pro",
    icon: Sparkles,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
  },
  {
    name: "ChatGPT Plus",
    command: "oai@gpt-4.1",
    icon: Bot,
    color: "text-green-400",
    bg: "bg-green-500/10",
    border: "border-green-500/20",
  },
  {
    name: "Kimi",
    command: "kimi@kimi-k2",
    icon: Moon,
    color: "text-purple-400",
    bg: "bg-purple-500/10",
    border: "border-purple-500/20",
  },
  {
    name: "Kimi Coding",
    command: "kc@kimi-for-coding",
    icon: Code2,
    color: "text-violet-400",
    bg: "bg-violet-500/10",
    border: "border-violet-500/20",
    badge: "OAUTH",
  },
  {
    name: "GLM / Zhipu",
    command: "glm@GLM-4-Plus",
    icon: MessageSquareCode,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
  },
  {
    name: "MiniMax",
    command: "mm@MiniMax-M1",
    icon: Zap,
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/20",
  },
  {
    name: "Vertex AI",
    command: "v@gemini-2.5-pro",
    icon: Server,
    color: "text-sky-400",
    bg: "bg-sky-500/10",
    border: "border-sky-500/20",
    badge: "ENTERPRISE",
  },
  {
    name: "Z.AI",
    command: "zai@claude-sonnet-4-5",
    icon: Globe,
    color: "text-indigo-400",
    bg: "bg-indigo-500/10",
    border: "border-indigo-500/20",
  },
  {
    name: "OllamaCloud",
    command: "oc@qwen3-coder",
    icon: Cloud,
    color: "text-gray-300",
    bg: "bg-gray-500/10",
    border: "border-gray-500/20",
  },
  {
    name: "OpenRouter",
    command: "or@deepseek/deepseek-r1",
    icon: FastIcon,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    badge: "580+ MODELS",
  },
  {
    name: "Ollama (Local)",
    command: "ollama@qwen3-coder:latest",
    icon: HardDrive,
    color: "text-cyan-400",
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/20",
    badge: "100% OFFLINE",
  },
];

const SubscriptionSection: React.FC = () => {
  return (
    <section className="py-24 bg-[#080808] border-t border-white/5 relative overflow-hidden">
      {/* Background Gradient */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1000px] h-[500px] bg-claude-ish/5 rounded-full blur-[150px] pointer-events-none" />

      <div className="max-w-7xl mx-auto px-6 relative z-10">
        {/* Header */}
        <div className="text-center mb-20">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-claude-ish mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-claude-ish animate-pulse" />
            Bring Your Own Key
          </div>
          <h2 className="text-4xl md:text-5xl font-sans font-bold text-white mb-6 tracking-tight">
            Use Your Existing <span className="text-claude-ish">Subscriptions</span>
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Stop paying for multiple AI subscriptions. Use what you already have directly within
            Claude Code's interface.
          </p>
        </div>

        {/* Subscription Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-16">
          {SUBSCRIPTIONS.map((sub) => (
            <div
              key={sub.name}
              className="bg-[#0f0f0f] border border-white/5 rounded-xl p-5 hover:border-white/10 hover:bg-[#141414] transition-all duration-300 group relative flex flex-col h-full"
            >
              {sub.badge && (
                <div className="absolute -top-3 right-4 bg-[#080808] text-cyan-400 text-[10px] font-bold px-2 py-1 rounded border border-cyan-500/30 flex items-center gap-1 shadow-sm">
                  <ShieldCheck className="w-3 h-3" />
                  {sub.badge}
                </div>
              )}

              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2.5 rounded-lg ${sub.bg} ${sub.color}`}>
                  <sub.icon className="w-5 h-5" />
                </div>
                <span className="font-semibold text-white text-sm tracking-wide">{sub.name}</span>
              </div>

              <div className="mt-auto">
                <div className="bg-[#080808] rounded-lg border border-white/5 px-3 py-2.5 font-mono text-[11px] text-gray-400 group-hover:text-gray-300 transition-colors flex items-center gap-2 overflow-hidden whitespace-nowrap">
                  <span className="text-claude-ish select-none">$</span>
                  <span className="opacity-70">claudish --model</span>
                  <span className={`${sub.color} opacity-90`}>
                    {sub.command.replace(/.*@/, "@")}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Value Proposition */}
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          <div className="bg-[#0c0c0c] border border-white/5 rounded-xl p-6 hover:border-white/10 transition-colors">
            <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center mb-4">
              <Wallet className="w-5 h-5 text-green-400" />
            </div>
            <h3 className="text-white font-semibold mb-2">Save Money</h3>
            <p className="text-gray-400 text-sm leading-relaxed">
              Use one subscription across all your tools instead of paying $140+/month for multiple
              services.
            </p>
          </div>

          <div className="bg-[#0c0c0c] border border-white/5 rounded-xl p-6 hover:border-white/10 transition-colors">
            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center mb-4">
              <ShieldCheck className="w-5 h-5 text-blue-400" />
            </div>
            <h3 className="text-white font-semibold mb-2">Full Privacy</h3>
            <p className="text-gray-400 text-sm leading-relaxed">
              Run completely offline with Ollama or LM Studio. Your code never leaves your machine.
            </p>
          </div>

          <div className="bg-[#0c0c0c] border border-white/5 rounded-xl p-6 hover:border-white/10 transition-colors">
            <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center mb-4">
              <FastIcon className="w-5 h-5 text-yellow-400" />
            </div>
            <h3 className="text-white font-semibold mb-2">Best Tool for Each Task</h3>
            <p className="text-gray-400 text-sm leading-relaxed">
              Switch models mid-session. Use GPT for reasoning, Gemini for context, local for
              privacy.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SubscriptionSection;
