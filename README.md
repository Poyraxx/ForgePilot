# ForgePilot

ForgePilot is an Electron desktop agent workspace for local and hosted LLMs. It provides a Codex/Cursor-style chat UI, a multi-provider runtime, built-in file and terminal tools, MCP support, web research tools, and document ingestion for PDFs and office files.

The core design goal is simple: even if a model does not support native tool calling, the app can still run tools through an emulated agent envelope and continue the same workflow.

## Highlights

- Multi-provider runtime
  - Ollama
  - OpenAI
  - Anthropic
  - OpenAI-compatible APIs such as LM Studio, OpenRouter, Groq, Together, DeepSeek, vLLM, and LocalAI
- Native tool calling when a provider supports it
- Emulated tool calling when a model does not support tools natively
- Workspace-scoped permissions
  - `read_only`
  - `ask`
  - `full_access`
- Built-in tools
  - `fs_list`
  - `fs_read`
  - `fs_write`
  - `fs_patch`
  - `fs_mkdir`
  - `fs_delete`
  - `search_text`
  - `run_command`
  - `web_search`
  - `web_fetch`
- MCP server support from Settings
- Stdio plugin support
- Conversation search palette
- Persistent threads, settings, and runtime state
- Multi-language UI with English default
- Attachment reuse across a thread
- Cross-platform packaging targets
  - Windows x64 portable
  - macOS x64 + arm64
  - Linux x64 AppImage + deb
- Document extraction for:
  - `pdf`
  - `docx`
  - `xlsx`
  - `pptx`
  - `odt`
  - `ods`
  - `odp`

## Desktop UX

- Custom top chrome with app-style controls
- Codex-inspired left rail, thread center, and progress panel
- Composer with provider, permission, model, and attachment controls
- Live progress feed for tool execution
- Approval flow for risky tools in `ask` mode
- Change summary cards after file edits
- Structure-first web fetch with title, description, heading outline, and link previews

## Architecture

```text
src/
  core/
    agent/        Agent loop, tool orchestration, approvals, context management
    providers/    Ollama, OpenAI-compatible, Anthropic, provider registry
    tools/        Filesystem, command, search, web, document extraction
    mcp/          MCP stdio integration and registry
    plugins/      Stdio plugin loading
  main/
    main.js       Electron main process and IPC
    preload.js    Safe renderer bridge
    session-service.js
                  Session lifecycle, persistence, provider/model management
  renderer/
    app.js        Main UI
    styles.css    Main styles
test/
  unit and runtime behavior tests
plugins/
  echo/           Example stdio plugin
```

## Requirements

- Node.js `>= 24`
- Electron `^35`
- Ollama for local Ollama sessions
- Python 3 for structured document reading from PDFs and office files
- Python packages from `requirements-docs.txt` for PDF and Office extraction
- Optional API keys for hosted providers:
  - OpenAI
  - Anthropic
  - Any OpenAI-compatible endpoint that requires authentication

## Official Platform Targets

- Windows `x64`
- macOS `x64` and `arm64`
- Linux `x64`

Kali Linux is covered through the Debian-style `deb` package target.

## Getting Started

Install dependencies:

```powershell
npm install
```

Install document-reading Python dependencies:

```powershell
python -m pip install -r requirements-docs.txt
```

Start the app:

```powershell
node --run start
```

Run tests:

```powershell
node --test
```

## Build Outputs

Build for the current Windows host:

```powershell
npm.cmd run build:win
```

Build on macOS:

```bash
npm run build:mac
```

Build on Linux:

```bash
npm run build:linux
```

Expected artifacts:

- `ForgePilot-<version>-win-x64.exe`
- `ForgePilot-<version>-mac-x64.dmg`
- `ForgePilot-<version>-mac-arm64.dmg`
- `ForgePilot-<version>-linux-x64.AppImage`
- `ForgePilot-<version>-linux-x64.deb`

## Native Release Automation

The repository includes GitHub Actions workflows for native multi-platform validation and packaging:

- `.github/workflows/ci.yml`
  - runs `node --test` on Windows, macOS, and Ubuntu
- `.github/workflows/release.yml`
  - builds native artifacts on:
    - `windows-latest`
    - `macos-latest`
    - `ubuntu-latest`

This is the recommended path for final macOS and Linux release artifacts, since `electron-builder` only supports macOS packaging on macOS and Linux distributables are most reliable on a native Linux runner.

## Provider Notes

### Ollama

- Best for local workflows
- Supports both native and emulated tool loops
- Make sure the Ollama service is running before opening a session

### OpenAI / Anthropic

- Add API credentials in `Settings > General`
- Model refresh now reports missing credentials in the UI instead of crashing

### OpenAI-compatible providers

Use this for local or hosted endpoints that expose an OpenAI-style API surface. Examples:

- LM Studio
- OpenRouter
- Groq
- Together
- DeepSeek
- vLLM
- LocalAI

## MCP Support

You can add stdio MCP servers from `Settings > MCP`.

For each server you can configure:

- Name
- Command
- Arguments
- Working directory
- Environment variables

Once connected, discovered MCP tools become available to the agent runtime just like built-in tools.

## Attachments and Documents

Files added in a conversation are copied into a session attachment area so the agent can reuse them in later turns. This includes documents outside the current workspace.

The runtime supports:

- Re-reading previously attached files
- Resolving attachment aliases and filename-only references
- Extracting readable text from PDFs and office documents

## Web Research

ForgePilot includes two built-in web tools:

- `web_search`
- `web_fetch`

`web_fetch` follows a structure-first approach inspired by browser automation tools such as FSB: besides plain text, it returns the page title, meta description, canonical URL, heading outline, and a compact link preview list. That gives weaker local models more reliable page context than a raw text dump alone.

## Acceptance Tests

To run the real Ollama acceptance flow:

```powershell
$env:RUN_OLLAMA_ACCEPTANCE='1'
node --test test/ollama-acceptance.test.js
```

Expected local models:

- `qwen3-coder-next:latest`
- `huihui_ai/qwen3-coder-abliterated:latest`

## Known Limits

- Hosted provider support depends on the target endpoint correctly implementing its API contract
- Some weaker local models may still overuse search or produce unstable tool envelopes
- macOS and Linux packaging should be generated on their native host OS for the most reliable release artifacts
- UI is optimized for desktop usage first

## Development Notes

- State is persisted locally between restarts
- Running tool traces are cleaned up on stop and app shutdown
- Renderer notifications are used for provider and runtime errors instead of console-spam for common user-facing issues
