# 1971 FEAR — Discord MG Scheduling Channel

## Channel setup
Create text channel `#mg-scheduling` in the **1971 - Born For Havoc** Discord server. Set **View Channel** for members who should see announcements. Allow **Send Messages**, **Use Application Commands**, and **Manage Messages** as appropriate for the Leadership R4/R5 role. Deny ordinary members **Use Application Commands** in this channel if they should not invoke the scheduler. Discord server permissions are defense-in-depth; the Cloudflare Worker separately checks `MG_R4_ROLE_ID` before accepting `/mg scheduled`.

## Current live command
`/mg scheduled date:YYYY-MM-DD time:HH:MM` records a **confirmed MG start** in Last War server time. It does not schedule MG inside the game. Only submit after R4 confirms the start in-game.

## Planned panel (not yet deployed)
- `/mg next`: three ranked tentative slots, with missing availability and event conflicts clearly marked
- `/mg calendar`: confirmed upcoming event blocks, plus missing times
- `/mg availability`: record participation estimates or preferred windows
- Buttons: Refresh Recommendations; Review Conflicts; Open LW Spy
- R4/R5-only scheduling actions; read-only visibility for ordinary members

## Current scheduling configuration
`config/mg-r4-schedule.json` defines the balanced policy (earliest 50%, participation 35%, preferred time 15%). Participation data and some event times are still unconfirmed. The existing workflow has not been verified end-to-end after the latest changes. Treat recommendations as tentative until R4 checks the game.

## LW Spy
Use a normal link to https://lw-spy.com/login . Discord text channels cannot iframe an arbitrary external login page. Do not share LW Spy credentials or tokens in Discord.

## Deployment checklist
1. Server administrator creates `#mg-scheduling` and sets channel/role permissions.
2. Verify `/mg scheduled` appears and can only be used successfully by Leadership.
3. Extend the Cloudflare Worker and register additional subcommands before advertising them as live.
4. Test GitHub workflow in manual test mode, confirm no existing team-wide notifications were altered.
5. Populate verified event windows and participation data.
