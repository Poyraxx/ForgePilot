ForgePilot v2.3.0 improves reliability across local and hosted models.

- The desktop UI now bundles its dependencies locally and can open offline.
- OpenAI-compatible and Anthropic responses stream live, including native tool calls.
- Plan mode blocks mutating MCP and plugin tools before execution or approval.
- Research mode requires distinct fetched sources before finalizing a web-backed answer.
- Workspace file tools reject symbolic links that point outside the workspace.
- Chat scrolling and live activity remain usable during longer turns.
- Electron and build dependencies are updated; the current npm audit reports no vulnerabilities.

Windows, macOS, and Linux packages are built from this tag by GitHub Actions. macOS builds are unsigned and may require approval in System Settings on first launch.
