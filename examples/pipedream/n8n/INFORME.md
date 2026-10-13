# Pipedream → n8n migration report

## New order follow-up
- Steps: 6 | converted automatically: 100%
- Connect in n8n: Gmail (thank_you); Google Sheets (add_row); Slack (OAuth2) (notify_team)
- To do by hand: step remember: data store 'customers' now uses the n8n workflow's static data (persists only in production executions and is not shared across workflows)
- To do by hand: trigger: this file does not include the trigger settings (GitHub Sync); it became a manual trigger. With the official export it converts automatically

## Lead capture webhook
- Steps: 2 | converted automatically: 100%
- Connect in n8n: Airtable (personal access token) (save_lead)
