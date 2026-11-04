# FEAR R4 MG Discord command setup

This is **prepared but not live** until the Discord application and Cloudflare Worker are configured. It does not change the existing alliance-wide MG notification workflow.

## What it does
An R4 uses `/mg scheduled date:2026-11-05 time:00:30` **after confirming MG in-game**. The date and time use the Last War **server clock (UTC-2)**. The Worker verifies Discord's Ed25519 signature, checks the configured FEAR guild and Leadership role, then sends a GitHub `repository_dispatch` event. GitHub records an **estimated** end time (start + 30 minutes). The separate R4 alert workflow checks for the first 00:00 server reset **after that estimated end**, and sends a single notification within the reset hour. GitHub cron is not exact to the minute.

**Limitations:** Discord does not expose in-game MG status. A delayed, canceled, or changed MG requires R4 to submit a corrected time. The role command records the scheduled start, not a verified completion. Conflict checks are incomplete until other alliance events are configured. No in-game actions are performed.

## One-time configuration
1. In the Discord Developer Portal, create or select a Discord application. Enable its bot and invite it to the FEAR server with `applications.commands` and `bot` scopes. Restrict the slash command to Leadership in **Server Settings > Integrations** when available. The Worker also enforces the Leadership role.
2. Deploy `discord/mg-command-worker.js` as a Cloudflare Worker (module syntax). Add Worker **secrets** `DISCORD_PUBLIC_KEY` (Discord application public key) and `GITHUB_TOKEN` (fine-grained GitHub PAT with repository **Contents: Read and write**; needed for repository dispatch). Add Worker **variables** `DISCORD_GUILD_ID` (FEAR Discord server ID) and `MG_R4_ROLE_ID` (Leadership role ID: `1566896299595399168`). Never put secrets in the repository.
3. Set Discord application's **Interactions Endpoint URL** to the deployed Worker HTTPS URL. Discord verifies the endpoint's signature handling.
4. Register the guild slash command using the application's bot token and application ID. Example PowerShell (run locally; do not paste secrets in chat):
```powershell
$applicationId = Read-Host "Discord Application ID"
$guildId = Read-Host "FEAR Discord Server ID"
$token = Read-Host "Discord bot token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
try { $botToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$command = @(
  @{
    name = "mg"
    description = "R4 MG schedule management"
    type = 1
    options = @(
      @{
        type = 1
        name = "scheduled"
        description = "Record confirmed MG start in server time"
        options = @(
          @{type=3; name="date"; description="Server date YYYY-MM-DD"; required=$true},
          @{type=3; name="time"; description="Server time HH:MM (24-hour)"; required=$true}
        )
      }
    )
  }
) | ConvertTo-Json -Depth 12
Invoke-RestMethod -Method Put -Uri "https://discord.com/api/v10/applications/$applicationId/guilds/$guildId/commands" -Headers @{Authorization="Bot $botToken"} -ContentType "application/json" -Body $command
Remove-Variable botToken
```
5. In GitHub **Settings > Actions > General > Workflow permissions**, ensure **Read and write permissions** are permitted so `mg-record-from-discord.yml` can commit the recorded schedule. The PAT for the Worker needs repository Contents read/write permission for dispatch.
6. Test the command after confirming an actual MG in-game. Verify the `Record confirmed MG schedule from Discord` GitHub Actions run succeeded, and that `config/mg-r4-schedule.json` has the expected `last_mg_end_utc`. Do **not** enter an unconfirmed MG start for testing because it would schedule a real alert.

## Important
The old team-wide workflow `.github/workflows/mg-discord-alerts.yml` remains untouched. The R4 workflow uses `MG_DISCORD_WEBHOOK_URL` and `MG_R4_ROLE_ID` independently.
