import React, { useEffect, useState } from "react";

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
}

const CACHE_KEY = "claudish-releases";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Color accent for each release note section heading */
const SECTION_COLORS: Record<string, string> = {
  "New Features": "border-emerald-500/60",
  "Bug Fixes": "border-yellow-500/60",
  Documentation: "border-blue-500/60",
  Performance: "border-purple-500/60",
  Refactoring: "border-cyan-500/60",
  "Other Changes": "border-gray-500/60",
};

/** Render inline markdown: **bold**, `code`, [link](url) */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold**, `code`, or [text](url)
  const regex = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      parts.push(
        <strong key={match.index} className="text-white font-bold">
          {match[1]}
        </strong>
      );
    } else if (match[2]) {
      parts.push(
        <code
          key={match.index}
          className="text-claude-ish bg-white/5 px-1.5 py-0.5 text-xs rounded"
        >
          {match[2]}
        </code>
      );
    } else if (match[3] && match[4]) {
      parts.push(
        <a
          key={match.index}
          href={match[4]}
          target="_blank"
          rel="noreferrer"
          className="text-claude-ish hover:underline"
        >
          {match[3]}
        </a>
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

/** Parse and render a release body (markdown subset) */
function ReleaseBody({ body }: { body: string }) {
  if (!body || body.trim().length === 0) {
    return (
      <span className="text-gray-600 italic">No release notes available.</span>
    );
  }

  // Split by ## headings
  const sections = body.split(/^## /m).filter(Boolean);

  // No structured sections — render as plain text with inline markdown
  const hasHeadings = body.includes("## ");
  if (!hasHeadings) {
    return (
      <div className="text-gray-400 leading-relaxed">
        {body.split("\n").map((line, i) => {
          const trimmed = line.trim();
          if (!trimmed) return null;
          return (
            <div key={i}>{renderInline(trimmed)}</div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sections.map((section, idx) => {
        const lines = section.split("\n");
        const heading = lines[0].trim();

        // Skip the Install section — not useful on the landing page
        if (heading.includes("Install")) return null;
        // Skip Full Changelog line if it's a standalone section
        if (heading.startsWith("**Full Changelog**")) return null;

        const borderColor =
          Object.entries(SECTION_COLORS).find(([key]) =>
            heading.includes(key)
          )?.[1] || "border-gray-700";

        // Strip emoji prefix from heading for cleaner display
        const cleanHeading = heading.replace(/^[^\w]*/, "").trim();

        const items = lines
          .slice(1)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- "));

        if (items.length === 0 && !cleanHeading) return null;

        return (
          <div key={idx} className={`border-l-2 ${borderColor} pl-4`}>
            <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">
              {cleanHeading}
            </div>
            {items.map((item, i) => (
              <div key={i} className="text-gray-400 text-sm leading-relaxed">
                <span className="text-gray-600 mr-1.5">•</span>
                {renderInline(item.replace(/^- /, ""))}
              </div>
            ))}
          </div>
        );
      })}
      {/* Render Full Changelog link if present */}
      {body.includes("**Full Changelog**") && (() => {
        const match = body.match(
          /\*\*Full Changelog\*\*:\s*(https?:\/\/[^\s]+)/
        );
        return match ? (
          <div className="text-xs text-gray-600">
            <a
              href={match[1]}
              target="_blank"
              rel="noreferrer"
              className="hover:text-claude-ish transition-colors"
            >
              Full Changelog →
            </a>
          </div>
        ) : null;
      })()}
    </div>
  );
}

/** Skeleton loader for a release card */
function ReleaseSkeleton() {
  return (
    <div className="border border-gray-800 bg-[#0c0c0c] overflow-hidden">
      <div className="bg-[#111] px-6 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-gray-700 animate-pulse" />
          <div className="h-4 w-16 bg-gray-800 rounded animate-pulse" />
        </div>
        <div className="h-3 w-12 bg-gray-800 rounded animate-pulse" />
      </div>
      <div className="p-6 space-y-3">
        <div className="h-3 w-3/4 bg-gray-800/50 rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-gray-800/50 rounded animate-pulse" />
        <div className="h-3 w-2/3 bg-gray-800/50 rounded animate-pulse" />
      </div>
    </div>
  );
}

const Changelog: React.FC = () => {
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    // Check sessionStorage cache
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) {
          setReleases(data);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Ignore cache errors
    }

    fetch(
      "https://api.github.com/repos/MadAppGang/claudish/releases?per_page=10"
    )
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data: GitHubRelease[]) => {
        const filtered = data.filter((r) => !r.prerelease);
        setReleases(filtered);
        try {
          sessionStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ data: filtered, timestamp: Date.now() })
          );
        } catch {
          // Ignore storage errors
        }
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Don't render section if fetch failed and no cached data
  if (error && releases.length === 0) {
    return (
      <section id="changelog" className="py-24 bg-[#080808] border-t border-white/5">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-5xl font-sans font-bold text-white mb-4">
            What's <span className="text-claude-ish">New</span>
          </h2>
          <p className="text-gray-500 font-mono text-sm mb-6">
            Could not load release history.
          </p>
          <a
            href="https://github.com/MadAppGang/claudish/releases"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-mono text-claude-ish hover:underline"
          >
            View releases on GitHub →
          </a>
        </div>
      </section>
    );
  }

  return (
    <section id="changelog" className="py-24 bg-[#080808] border-t border-white/5">
      <div className="max-w-4xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-claude-ish mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-claude-ish animate-pulse" />
            Release History
          </div>
          <h2 className="text-3xl md:text-5xl font-sans font-bold text-white mb-4">
            What's <span className="text-claude-ish">New</span>
          </h2>
          <p className="text-xl text-gray-500 font-mono">
            git log --oneline --releases
          </p>
        </div>

        {/* Release cards */}
        <div className="space-y-4">
          {loading ? (
            <>
              <ReleaseSkeleton />
              <ReleaseSkeleton />
              <ReleaseSkeleton />
            </>
          ) : (
            releases.map((release, idx) => {
              const isExpanded = idx === 0 || expandedIds.has(release.id);
              const bodyLines = (release.body || "").split("\n").length;
              const isLong = bodyLines > 8 && idx !== 0;

              return (
                <div
                  key={release.id}
                  className="border border-gray-800 bg-[#0c0c0c] overflow-hidden group hover:border-gray-700 transition-colors"
                >
                  {/* Header bar */}
                  <button
                    onClick={() => toggleExpand(release.id)}
                    className="w-full bg-[#111] px-6 py-3 border-b border-gray-800 flex items-center justify-between cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          idx === 0
                            ? "bg-claude-ish animate-pulse"
                            : "bg-gray-600"
                        }`}
                      />
                      <span className="text-sm font-mono font-bold text-white">
                        {release.tag_name}
                      </span>
                      {release.name && release.name !== release.tag_name && (
                        <span className="text-xs font-mono text-gray-500 hidden md:inline">
                          — {release.name}
                        </span>
                      )}
                      {idx === 0 && (
                        <span className="text-[10px] font-bold text-claude-ish uppercase tracking-widest">
                          LATEST
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-gray-600">
                        {formatRelativeDate(release.published_at)}
                      </span>
                      <svg
                        className={`w-3 h-3 text-gray-600 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </div>
                  </button>

                  {/* Body — collapsible */}
                  {isExpanded && (
                    <div className="p-6 font-mono text-sm">
                      {isLong && !expandedIds.has(release.id) ? (
                        <div className="relative">
                          <div className="max-h-32 overflow-hidden">
                            <ReleaseBody body={release.body} />
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#0c0c0c] to-transparent" />
                        </div>
                      ) : (
                        <ReleaseBody body={release.body} />
                      )}
                      <a
                        href={release.html_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 mt-4 text-xs text-gray-500 hover:text-claude-ish transition-colors"
                      >
                        View on GitHub →
                      </a>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer link */}
        <div className="text-center mt-8">
          <a
            href="https://github.com/MadAppGang/claudish/releases"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-mono text-gray-500 hover:text-claude-ish transition-colors"
          >
            View all releases on GitHub →
          </a>
        </div>
      </div>
    </section>
  );
};

export default Changelog;
