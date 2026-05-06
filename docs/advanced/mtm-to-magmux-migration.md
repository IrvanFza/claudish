# Migrating from MTM to magmux

**Version**: v6.5.0
**Last updated**: 2026-04-01
**Status**: Steps 1-3 complete. magmux v0.3.0 supports `-g`, `-S`, socket IPC. `team-grid.ts` prefers magmux over MTM.
**Audience**: Claudish developers wiring magmux into team-grid

---

## Quick win: the minimum viable swap

Before touching any Go code, test magmux with the existing grid workflow by hand. This confirms the binary works on your platform and renders panes correctly.

```bash
# 1. Write a test gridfile (same format team-grid.ts produces)
cat > /tmp/test-grid.txt <<'EOF'
echo "pane 1: hello from model-a"; sleep 5
echo "pane 2: hello from model-b"; sleep 5
EOF

# 2. Run magmux with -e flags (already supported)
magmux -e 'echo "pane 1: hello from model-a"; sleep 5' \
       -e 'echo "pane 2: hello from model-b"; sleep 5'
```

Two panes appear. Text renders. Mouse click-to-focus works. That confirms the VT-100 parser and pane layout function correctly. The remaining work adds `-g` and `-S` flags so `team-grid.ts` can drive magmux the same way it drives MTM.

---

## Why replace MTM

| Concern | MTM (C) | magmux (Go) |
|---------|---------|-------------|
| System dependencies | Requires ncurses | Zero -- static binary |
| Cross-compilation | Manual per-platform `make` | `GOOS=X GOARCH=Y go build` |
| Binary size | ~100 KB | ~3 MB |
| VT-100 coverage | Full | ~95% tmux coverage |
| Maintenance | Forked C, single maintainer | Go, testable |

The ncurses dependency causes the most friction. On minimal Docker images and CI runners, MTM fails unless `libncurses-dev` is installed. magmux compiles to a static binary with no runtime dependencies.

---

## Integration surface

One file owns the entire MTM integration: `packages/cli/src/team-grid.ts`. No other source file references MTM. The migration touches four functions in that file plus the npm package manifest.

### What team-grid.ts does today

```
findMtmBinary()          line 38   → locates the mtm binary
renderGridStatusBar()    line 97   → formats status bar text
pollStatus()             line 147  → writes statusbar.txt every 500ms
runWithGrid()            line 259  → writes gridfile, spawns mtm, waits
```

### How MTM is spawned (line 341)

```typescript
const proc = spawn(mtmBin, ["-g", gridfilePath, "-S", statusbarPath, "-t", "xterm-256color"], {
  stdio: "inherit",
  env: { ...process.env },
});
```

Three flags matter:

- **`-g gridfilePath`** -- reads one shell command per line, creates one pane per line
- **`-S statusbarPath`** -- polls this file for status bar content (last line wins)
- **`-t xterm-256color`** -- sets TERM inside panes

magmux needs `-g` and `-S`. It does not need `-t` because it sets `TERM=screen-256color` internally.

---

## Step-by-step migration

### Step 1: Add `-g` flag to magmux

Parse a `-g gridfile` argument in `main.go`. Read the file, split by newlines, and create one pane per non-empty line.

```go
// main.go — flag parsing
gridFile := flag.String("g", "", "grid file: one shell command per line")
flag.Parse()

if *gridFile != "" {
    data, err := os.ReadFile(*gridFile)
    if err != nil {
        log.Fatalf("cannot read grid file: %v", err)
    }
    lines := strings.Split(strings.TrimSpace(string(data)), "\n")
    for _, line := range lines {
        line = strings.TrimSpace(line)
        if line == "" {
            continue
        }
        shell := os.Getenv("SHELL")
        if shell == "" {
            shell = "/bin/sh"
        }
        panes = append(panes, PaneConfig{
            Cmd:  shell,
            Args: []string{"-l", "-c", line},
        })
    }
}
```

Grid mode also needs exit-overlay behavior: when a child process exits, freeze the pane scrollback and show a green checkmark (exit 0) or red X (non-zero). MTM does this, and `team-grid.ts` relies on it -- the `exec sleep 86400` at the end of each gridfile line keeps the pane alive so users can read output.

```go
// When child exits in grid mode:
if pane.GridMode && pane.ChildExited {
    pane.Frozen = true
    if pane.ExitCode == 0 {
        drawOverlay(pane, "\033[42;97;1m done \033[0m")
    } else {
        drawOverlay(pane, fmt.Sprintf("\033[41;97;1m fail (exit %d) \033[0m", pane.ExitCode))
    }
}
```

### Step 2: Add `-S` flag to magmux

Parse a `-S statusbar_file` argument. In the render loop, stat the file on each tick. When the mtime changes, read the last line and parse tab-separated segments.

```go
statusBarFile := flag.String("S", "", "status bar file: tab-separated segments, polled for changes")

// In render loop (runs at ~60fps, but only redraws on dirty):
if *statusBarFile != "" {
    info, err := os.Stat(*statusBarFile)
    if err == nil && info.ModTime().After(lastStatusMtime) {
        lastStatusMtime = info.ModTime()
        data, _ := os.ReadFile(*statusBarFile)
        lines := strings.Split(strings.TrimSpace(string(data)), "\n")
        if len(lines) > 0 {
            lastLine := lines[len(lines)-1]
            statusBar = parseStatusSegments(lastLine)
            dirty = true
        }
    }
}
```

The status bar format uses tab-separated segments with a color prefix:

```
C: claudish team\tG: 3 done\tC: 2 running\tR: 1 failed\tD: 2m 34s
```

Parse the prefix character before the colon to select the color:

```go
func parseStatusSegments(line string) []StatusSegment {
    parts := strings.Split(line, "\t")
    var segments []StatusSegment
    for _, part := range parts {
        if len(part) < 3 || part[1] != ':' {
            segments = append(segments, StatusSegment{Color: ColorWhite, Text: part})
            continue
        }
        color := colorFromCode(part[0])
        text := strings.TrimSpace(part[2:])
        segments = append(segments, StatusSegment{Color: color, Text: text})
    }
    return segments
}

func colorFromCode(c byte) Color {
    switch c {
    case 'M': return ColorMagenta
    case 'C': return ColorCyan
    case 'G': return ColorGreen
    case 'R': return ColorRed
    case 'Y': return ColorYellow
    case 'D': return ColorDim
    default:  return ColorWhite
    }
}
```

### Step 3: Update `team-grid.ts`

Replace `findMtmBinary()` with `findMultiplexerBinary()`. Prefer magmux, fall back to MTM.

```typescript
// packages/cli/src/team-grid.ts — replace findMtmBinary() (line 38)

interface MultiplexerBinary {
  path: string;
  kind: "magmux" | "mtm";
}

function findMultiplexerBinary(): MultiplexerBinary {
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = join(dirname(thisFile), "..");
  const platform = process.platform;
  const arch = process.arch;

  // 1. magmux in PATH (preferred — static binary, no deps)
  try {
    const result = execSync("which magmux", { encoding: "utf-8" }).trim();
    if (result) return { path: result, kind: "magmux" };
  } catch { /* not in PATH */ }

  // 2. Bundled magmux binary
  const bundledMagmux = join(pkgRoot, "native", "magmux", `magmux-${platform}-${arch}`);
  if (existsSync(bundledMagmux)) return { path: bundledMagmux, kind: "magmux" };

  // 3. Fall back to MTM (backwards compat)
  const builtMtm = join(pkgRoot, "native", "mtm", "mtm");
  if (existsSync(builtMtm)) return { path: builtMtm, kind: "mtm" };

  const bundledMtm = join(pkgRoot, "native", "mtm", `mtm-${platform}-${arch}`);
  if (existsSync(bundledMtm)) return { path: bundledMtm, kind: "mtm" };

  try {
    const result = execSync("which mtm", { encoding: "utf-8" }).trim();
    if (result && isMtmForkWithGrid(result)) return { path: result, kind: "mtm" };
  } catch { /* not in PATH */ }

  throw new Error(
    "No terminal multiplexer found. Install magmux (recommended) or build mtm:\n" +
    "  brew install magmux\n" +
    "  # or: cd packages/cli/native/mtm && make"
  );
}
```

Update the spawn call (line 341) to adjust flags based on multiplexer kind:

```typescript
// packages/cli/src/team-grid.ts — replace spawn call (line 341)

const mux = findMultiplexerBinary();

const spawnArgs: string[] = ["-g", gridfilePath, "-S", statusbarPath];
if (mux.kind === "mtm") {
  spawnArgs.push("-t", "xterm-256color");
}
// magmux sets TERM=screen-256color internally — no -t flag needed

const proc = spawn(mux.path, spawnArgs, {
  stdio: "inherit",
  env: { ...process.env },
});
```

### Step 4: Update npm package distribution

Add magmux binaries to the `files` array in `packages/cli/package.json`:

```jsonc
// packages/cli/package.json — line 40
{
  "files": [
    "dist/",
    "bin/",
    "native/mtm/mtm-*",
    "native/magmux/magmux-*",
    "AI_AGENT_GUIDE.md",
    "skills/"
  ]
}
```

Cross-compile magmux for all four target platforms:

```bash
# Build script: scripts/build-magmux.sh (or a Bun script)
PLATFORMS="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64"

for platform in $PLATFORMS; do
  GOOS="${platform%/*}"
  GOARCH="${platform#*/}"
  OUTPUT="packages/cli/native/magmux/magmux-${GOOS/darwin/darwin}-${GOARCH/amd64/x64}"

  echo "Building magmux for ${GOOS}/${GOARCH}..."
  GOOS=$GOOS GOARCH=$GOARCH go build -o "$OUTPUT" ./cmd/magmux
done
```

Map Go platform names to Node.js platform names:

| Go (`GOOS/GOARCH`) | Node.js (`platform-arch`) | Output binary |
|---------------------|---------------------------|---------------|
| `darwin/arm64` | `darwin-arm64` | `magmux-darwin-arm64` |
| `darwin/amd64` | `darwin-x64` | `magmux-darwin-x64` |
| `linux/amd64` | `linux-x64` | `magmux-linux-x64` |
| `linux/arm64` | `linux-arm64` | `magmux-linux-arm64` |

### Step 5: Update CLAUDE.md

Replace the MTM build instructions. The relevant section is under "Build Commands" and the team-grid spawn call reference.

```markdown
## Terminal Multiplexer (team-grid)

Team grid mode uses **magmux** (Go) as the terminal multiplexer.
MTM (C) is supported as a fallback but no longer actively maintained.

- magmux binary: `native/magmux/magmux-{platform}-{arch}`
- MTM fallback: `native/mtm/mtm-{platform}-{arch}` (requires ncurses)
```

---

## CLI flag compatibility

| Flag | MTM | magmux v0.3.0 |
|------|-----|---------------|
| `-g FILE` | Grid file | Done |
| `-S FILE` | Status bar file | Done |
| `-e CMD` | Fork command | Done |
| `-t TERM` | Terminal type | Not needed (internal `screen-256color`) |
| `-c KEY` | Command key | Not in magmux (low priority) |
| `-L FILE` | Diagnostic log | `MAGMUX_DEBUG` env |
| Socket IPC | N/A | `/tmp/magmux-{pid}.sock` (new, beyond MTM) |

---

## Risks

### TERM value difference

MTM uses `TERM=xterm-256color` (via `-t`). magmux uses `TERM=screen-256color` internally.

`screen-256color` is the correct value -- it matches the actual terminal capabilities magmux exposes. Most programs handle it fine. Test claudish `-v` (verbose mode) rendering under `screen-256color` before shipping. If a specific program breaks, the workaround is `TERM=xterm-256color magmux ...` as an env override.

### Grid mode exit behavior

MTM freezes panes on child exit and overlays a status indicator. The current `team-grid.ts` gridfile works around this by appending `exec sleep 86400` to each command line. That keeps the shell alive so MTM never sees an exit.

With magmux, implement native exit-overlay support in grid mode. Then the `exec sleep 86400` hack becomes optional -- magmux freezes the pane and shows the overlay natively. Keep the `sleep` line during the transition period for MTM backwards compatibility.

### Binary size

MTM compiles to ~100 KB. magmux compiles to ~3 MB (Go runtime overhead). This adds ~12 MB to the npm package (4 platforms x 3 MB). Not a blocker, but worth noting for package size budgets.

---

## Testing the migration

### Manual smoke test

```bash
# 1. Build magmux with -g and -S support
cd /path/to/magmux && go build -o magmux ./cmd/magmux

# 2. Create a gridfile
cat > /tmp/grid.txt <<'EOF'
echo "model-a responding..."; sleep 3; echo "done"
echo "model-b responding..."; sleep 5; echo "done"
EOF

# 3. Create a status bar file
echo 'C: test grid\tG: 0 done\tC: 2 running' > /tmp/status.txt

# 4. Launch
./magmux -g /tmp/grid.txt -S /tmp/status.txt

# 5. In another terminal, update the status bar
echo 'C: test grid\tG: 1 done\tC: 1 running' > /tmp/status.txt
sleep 2
echo 'C: test grid\tG: 2 done\tD: 5s\tG: complete' > /tmp/status.txt
```

Verify: two panes appear, status bar updates on each write, panes freeze after commands finish.

### Integration test with team-grid

```bash
# Run a real team grid with magmux in PATH
export PATH="/path/to/magmux:$PATH"
claudish --team "google@gemini-2.0-flash,oai@gpt-4o" "write a haiku about code"
```

The grid spawns, models respond in parallel, status bar updates, and exiting returns a `TeamStatus` JSON.

### Regression check

Run the existing team-grid tests (if any) after the `findMultiplexerBinary()` refactor:

```bash
bun test --cwd packages/cli --grep "team-grid"
```

---

## Estimated effort

| Step | Work | Time estimate |
|------|------|---------------|
| 1. Add `-g` flag to magmux | Go: flag parsing, gridfile reader, pane spawning | 2-3 hours |
| 2. Add `-S` flag to magmux | Go: file stat polling, segment parser, render | 2-3 hours |
| 3. Update `team-grid.ts` | TypeScript: replace binary finder, adjust spawn args | 1 hour |
| 4. npm package distribution | Build script, CI cross-compile, package.json update | 2 hours |
| 5. Update CLAUDE.md | Documentation edits | 30 min |
| 6. Testing | Manual smoke test, integration test, regression check | 2 hours |
| **Total** | | **10-12 hours** |

Steps 1 and 2 are independent and can run in parallel if two developers are available.

---

## Troubleshooting

### magmux not found after install

**Symptom**: `Error: No terminal multiplexer found`

**Cause**: magmux binary not in PATH and not bundled in `native/magmux/`.

**Fix**:
```bash
# Check if magmux is in PATH
which magmux

# If not, add it
export PATH="/path/to/magmux:$PATH"

# Or place the binary in the expected bundle location
cp magmux packages/cli/native/magmux/magmux-darwin-arm64
```

### Status bar not updating

**Symptom**: Status bar shows initial text but never changes.

**Cause**: magmux not polling the status bar file, or polling but not detecting mtime changes.

**Fix**: Verify the file's mtime changes on each write. Some filesystems (notably tmpfs) may not update mtime reliably. Write to a path on a real filesystem.

```bash
# Verify mtime updates
stat /tmp/status.txt
echo 'G: updated' > /tmp/status.txt
stat /tmp/status.txt
# Compare modification timestamps
```

### Panes render garbled text

**Symptom**: ANSI escape codes appear as raw text in panes.

**Cause**: `TERM=screen-256color` not recognized by the program running inside the pane.

**Fix**: Check that `screen-256color` terminfo is installed:
```bash
infocmp screen-256color >/dev/null 2>&1 && echo "OK" || echo "MISSING"

# If missing, install ncurses-term (Linux) or use the fallback:
TERM=xterm-256color magmux -g grid.txt -S status.txt
```

### MTM fallback not working

**Symptom**: Falls through to MTM but MTM also fails.

**Cause**: MTM requires ncurses. On minimal systems, `libncurses` is missing.

**Fix**: Install magmux instead. That is the whole point of this migration.
