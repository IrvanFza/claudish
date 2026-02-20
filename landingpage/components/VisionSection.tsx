import type React from "react";
import { TerminalWindow } from "./TerminalWindow";

export const VisionSection: React.FC = () => {
  return (
    <div className="w-full relative py-24">
      {/* Section Header */}
      <div className="text-center mb-16 relative z-10 max-w-3xl mx-auto px-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded border border-gray-800 text-[10px] font-mono text-gray-400 uppercase tracking-widest mb-6 bg-[#0a0a0a]">
          <span className="w-1.5 h-1.5 rounded-full bg-claude-ish"></span> Vision Proxy
        </div>
        <h2 className="text-3xl md:text-5xl font-sans font-bold text-white mb-6">
          Give every model <span className="text-claude-ish">the gift of sight.</span>
        </h2>
        <p className="text-gray-400 font-mono text-sm md:text-base leading-relaxed">
          Use text-only models like <span className="text-white">GLM 5</span> or{" "}
          <span className="text-white">Kimi 2.5</span> without breaking image workflows. Claudish
          automatically translates images into rich text context before they reach your target
          model.
        </p>
      </div>

      <div className="max-w-5xl mx-auto px-4 relative z-20">
        {/* Minimal Pipeline Diagram */}
        <div className="flex flex-col md:flex-row items-stretch justify-center gap-4 mb-16 relative">
          {/* Connecting Line (Desktop) */}
          <div className="hidden md:block absolute top-1/2 left-0 w-full h-px border-t border-dashed border-gray-800 -z-10 -translate-y-1/2"></div>

          {/* Node 1: Claude Code */}
          <div className="bg-[#050505] border border-gray-800 p-5 rounded-lg w-full md:w-1/3 flex flex-col relative">
            <div className="text-[10px] text-gray-600 font-mono uppercase mb-4 tracking-wider">
              Source
            </div>
            <div className="text-white font-bold mb-4 font-sans flex items-center gap-2">
              <span className="text-claude-ish font-serif italic text-lg pr-1">C</span> Claude Code
            </div>
            <div className="mt-auto bg-[#0a0a0a] border border-gray-800 p-4 rounded font-mono text-xs">
              <div className="text-gray-500 mb-2 text-[10px] uppercase">Payload</div>
              <div className="text-gray-400">{"{"}</div>
              <div className="pl-4 text-blue-300">
                "type": <span className="text-blue-200">"image_url"</span>,
              </div>
              <div className="pl-4 text-blue-300">
                "url": <span className="text-blue-200">"data:image..."</span>
              </div>
              <div className="text-gray-400">{"}"}</div>
            </div>
          </div>

          {/* Node 2: Claudish Proxy */}
          <div className="bg-[#0a0a0a] border border-claude-ish/30 p-5 rounded-lg w-full md:w-1/3 flex flex-col relative shadow-[0_0_30px_rgba(0,212,170,0.05)]">
            <div className="absolute top-0 right-0 px-2 py-1 bg-claude-ish/10 text-claude-ish text-[9px] font-mono border-b border-l border-claude-ish/20 rounded-bl-lg uppercase">
              Auto-Intercept
            </div>
            <div className="text-[10px] text-gray-600 font-mono uppercase mb-4 tracking-wider">
              Middleware
            </div>
            <div className="text-white font-bold mb-4 font-sans flex items-center gap-2">
              Claudish Proxy
            </div>
            <div className="mt-auto bg-claude-ish/5 border border-claude-ish/20 p-4 rounded font-mono text-xs relative overflow-hidden">
              <div className="text-claude-ish mb-2 text-[10px] uppercase flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-claude-ish animate-pulse"></span>
                Processing API
              </div>
              <div className="text-gray-400 text-[11px] leading-relaxed">
                Extracting layout, text, and structure via Vision API...
              </div>
            </div>
          </div>

          {/* Node 3: Target Model */}
          <div className="bg-[#050505] border border-gray-800 p-5 rounded-lg w-full md:w-1/3 flex flex-col relative">
            <div className="text-[10px] text-gray-600 font-mono uppercase mb-4 tracking-wider">
              Destination
            </div>
            <div className="text-white font-bold mb-4 font-sans flex items-center gap-2">
              Kimi 2.5 / GLM 5
            </div>
            <div className="mt-auto bg-[#0a0a0a] border border-gray-800 p-4 rounded font-mono text-xs">
              <div className="text-gray-500 mb-2 text-[10px] uppercase">Payload</div>
              <div className="text-gray-400">{"{"}</div>
              <div className="pl-4 text-green-300">
                "type": <span className="text-green-200">"text"</span>,
              </div>
              <div className="pl-4 text-green-300">
                "text": <span className="text-green-200">"UI shows a..."</span>
              </div>
              <div className="text-gray-400">{"}"}</div>
            </div>
          </div>
        </div>

        {/* Terminal Demo */}
        <div className="max-w-3xl mx-auto">
          <TerminalWindow
            title="claudish — kimi-vision-demo"
            className="border-gray-800 shadow-2xl h-[280px]"
          >
            <div className="flex flex-col gap-3 text-xs md:text-sm font-mono">
              <div className="text-gray-400">
                <span className="text-claude-ish">➜</span> claudish --model kimi@kimi-2.5
              </div>
              <div className="text-white font-bold">
                <span className="text-gray-500 font-normal">&gt;</span> Fix the header layout bug in
                this screenshot. (attached: header_bug.png)
              </div>
              <div className="text-gray-500 flex items-center gap-2">
                <span className="animate-spin text-gray-400">⟳</span>
                [Vision Proxy] Translating 1 image to text via Vision API...
              </div>
              <div className="text-claude-ish/80 flex items-center gap-2">
                <span>✓</span>
                [Vision Proxy] Image successfully described (342 tokens)
              </div>
              <div className="text-gray-300 mt-1 leading-relaxed">
                <span className="text-white font-bold">🤖 kimi-2.5:</span> I can help fix that.
                Based on the screenshot description, the navigation links in the top right are
                overlapping with the logo. Let's update the flexbox gap...
              </div>
            </div>
          </TerminalWindow>
        </div>
      </div>
    </div>
  );
};
