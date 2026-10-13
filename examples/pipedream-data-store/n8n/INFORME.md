# Pipedream → n8n migration report

## Customer lookup
- Steps: 3 | converted automatically: 100%
- To do by hand: step lookup: data store 'customers list' now uses the n8n workflow's static data (persists only in production executions and is not shared across workflows)
- To do by hand: step get_bob: data store 'customers list' now uses the n8n workflow's static data (persists only in production executions and is not shared across workflows)
- To do by hand: step get_visits: data store 'customers list' now uses the n8n workflow's static data (persists only in production executions and is not shared across workflows)
- To do by hand: trigger: the file does not include the trigger settings (GitHub Sync never does, and some exports come with an empty trigger list); it became a manual trigger, set the real one (webhook, schedule or app) in n8n
- Check: step lookup: data store 'customers list' comes preloaded with 3 records from your data store file
- Check: step get_bob: data store 'customers list' comes preloaded with 3 records from your data store file
- Check: step get_visits: data store 'customers list' comes preloaded with 3 records from your data store file
