## What's New in v2.4.0

- Safe Markdown answers with tables, task lists, code blocks, and message/code copying.
- Expandable file diffs inside chat with highlighted additions and removals.
- A compact, auto-growing composer, Enter to send, Shift+Enter for a new line, and collapsed reasoning.
- Collapsible source lists, directly openable source links, and fewer duplicated header controls.
- Lightweight streaming updates that no longer resend the full conversation for each chunk.
- Automatic project instructions from `AGENTS.md` and on-demand project skills from `.agents/skills`, `.claude/skills`, and `.opencode/skills`.
- Context-size-aware conversation compaction and bounded tool output, while preserving stored history and native tool-call pairs.
- Protection against overwriting externally changed files with built-in writes and patches, including saved-thread recovery.
- Ambiguous patches require a larger exact match or explicit `replaceAll`.
- LF patch excerpts work with Windows CRLF files without changing their line endings.
- HTTP/HTTPS source links open externally. Model HTML does not execute and remote Markdown images are not fetched automatically.

### Downloads

- Windows: x64 portable `.exe`.
- macOS: Apple Silicon `arm64` and Intel `x64` `.dmg` or `.zip`.
- Linux: x64 `.AppImage` and Debian/Ubuntu `.deb`.

Local model servers and hosted provider credentials are configured separately. Document extraction still requires the documented Python dependencies. macOS builds are unsigned and not notarized.
