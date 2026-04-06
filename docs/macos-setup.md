# macOS Auto-Start Setup

This guide shows how to configure the Claude Code CLI Provider to start automatically when you log in.

## Create LaunchAgent

1. Create the plist file:

```bash
cat > ~/Library/LaunchAgents/com.claude-code-provider.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.claude-code-provider</string>
    
    <key>Comment</key>
    <string>Claude Code CLI Provider (uses Claude Max subscription)</string>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/path/to/claude-code-cli-provider/dist/server/standalone.js</string>
    </array>
    
    <key>StandardOutPath</key>
    <string>/tmp/claude-provider.log</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/claude-provider.err.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>/Users/YOUR_USERNAME</string>
      <key>PATH</key>
      <string>/Users/YOUR_USERNAME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>CLAUDE_BIN</key>
      <string>/Users/YOUR_USERNAME/.local/bin/claude</string>
      <!-- Optional: adjust for your workload -->
      <key>CLAUDE_TIMEOUT_MS</key>
      <string>2700000</string>
      <key>CLAUDE_MAX_CONCURRENT</key>
      <string>3</string>
    </dict>
  </dict>
</plist>
PLIST
```

2. **Important:** Edit the file and replace:
   - `/path/to/claude-code-cli-provider` with your actual path
   - `/Users/YOUR_USERNAME` with your actual username
   - `CLAUDE_BIN` with the absolute path to the `claude` binary (find it with `which claude`)
   - Ensure the PATH includes the directory containing `claude`
   - Adjust `CLAUDE_TIMEOUT_MS` for your workload (default 45min, sufficient for 1M tokens)
   - Adjust `CLAUDE_MAX_CONCURRENT` if you need more parallel processes

## Load the Service

```bash
# Load and start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-code-provider.plist

# Verify it's running
launchctl list | grep claude-code
curl http://localhost:3456/health
```

## Management Commands

```bash
# Check status
launchctl list | grep claude-code

# Restart the service
launchctl kickstart -k gui/$(id -u)/com.claude-code-provider

# Stop the service (temporary)
launchctl bootout gui/$(id -u)/com.claude-code-provider

# Start the service again
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-code-provider.plist

# View logs
tail -f /tmp/claude-provider.log
tail -f /tmp/claude-provider.err.log
```

## Uninstall

```bash
# Stop and remove the service
launchctl bootout gui/$(id -u)/com.claude-code-provider
rm ~/Library/LaunchAgents/com.claude-code-provider.plist
```

## Troubleshooting

### Service starts but health check fails

Check the error log:
```bash
cat /tmp/claude-provider.err.log
```

Common issues:
- Wrong path to `standalone.js`
- `claude` CLI not in PATH
- Node.js not found

### `ENOTDIR` or `ENOENT` spawn error

This means the `claude` binary can't be found. LaunchAgents don't load your shell profile, so `claude` may not be in PATH even if it works in your terminal.

Fix: set `CLAUDE_BIN` to the absolute path in the plist:
```bash
# Find the absolute path
which claude
# Then set it in the plist EnvironmentVariables section
```

### Finding the right paths

```bash
# Find node
which node

# Find claude
which claude

# Your home directory
echo $HOME
```
