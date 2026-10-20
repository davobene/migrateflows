# MigrateFlows

Convertidores gratis que transforman flujos de herramientas que cierran en flujos de n8n listos para importar.

| Desde | Por qué ahora | Convertidor |
|---|---|---|
| OpenAI Agent Builder | Cierra el 30 de noviembre de 2026 | [migrateflows.com/openai-agent-builder-to-n8n](https://migrateflows.com/openai-agent-builder-to-n8n/) |
| Flowise | Archivado, sin más parches de seguridad | [migrateflows.com/flowise-to-n8n](https://migrateflows.com/flowise-to-n8n/) |
| Pipedream Workflows | Cierra el 31 de marzo de 2027 | [migrateflows.com](https://migrateflows.com/) |

Todo corre en el navegador: tu export nunca sale de tu computadora. Este repo tiene todo el código, así que podés comprobarlo o correrlo vos.

[Read in English](README.md)

## Qué convierte

**OpenAI Agent Builder** (entrada: el export de código, *Code → Agents SDK*, en Python o TypeScript)
- Cada agente pasa a un AI Agent de n8n con su modelo, instrucciones (fijas o por pedido), esquema de salida y memoria.
- La búsqueda web, la búsqueda en archivos y el intérprete de código siguen como herramientas integradas de OpenAI a través del modelo de OpenAI de n8n, así que los IDs de vector store siguen andando.
- Los servidores MCP pasan a herramientas MCP Client. Los tokens que aparecen en el código nunca se copian: el informe te dice qué credencial crear.
- Los guardrails pasan al nodo Guardrails de n8n. Los if/elif/else y clasificadores pasan a Switch, los bucles while a If con vuelta, la aprobación humana a Wait con formulario.

**Flowise** (entrada: el export de un chatflow o agentflow, o *Settings → Export → All*)
- Cadenas y agentes: LLM Chain, Conversation Chain, Retrieval QA, Tool Agent, ReAct, equipos de supervisor y trabajadores.
- Modelos de chat (OpenAI, Anthropic, Gemini, Mistral, Ollama, Groq, Azure y más), memoria, divisores de texto, parsers de salida.
- Las bases vectoriales siguen apuntando al mismo índice (Pinecone, Qdrant, Supabase, Postgres, Chroma...), así que no hay que volver a generar embeddings.
- Las herramientas propias corren en el Code Tool de n8n. Los Document Stores vienen con *Export All*.
- Nodos de Agentflow v2: LLM, Agent, Condition, Condition Agent, HTTP, Custom Function, Iteration, Loop, Direct Reply, Human Input.

**Pipedream** (entrada: el export del proyecto o una carpeta de GitHub Sync)
- Los pasos de código Node.js pasan a nodos Code, incluyendo `steps.X.$return_value`, `$.export`, `$.flow.exit`, `$.respond` y `axios` de `@pipedream/platform`.
- Disparadores HTTP, webhook y programados, esperas, filtros (seguir o terminar según una condición), respuestas HTTP y data stores.
- Las acciones comunes de apps pasan a nodos HTTP Request con la credencial de n8n que corresponde: Google Sheets, Gmail, Slack, Airtable, OpenAI, Telegram, Discord, GitHub, Outlook, Teams, Google Calendar, SendGrid, Postgres, Supabase, Twilio, Snowflake.

Cada conversión trae una lista de lo que queda por hacer a mano (cuentas para reconectar, variables para crear).

**Los data stores de Pipedream** no vienen en el export oficial y se borran el 30 de abril de 2027. [`src/pipedream-datastore-exporter.mjs`](src/pipedream-datastore-exporter.mjs) es un paso de código de Pipedream que solo lee y baja todos los registros en un archivo `.datastore.json`; soltalo junto con tu export y los flujos de n8n convertidos vienen con los datos precargados. Paso a paso: [migrateflows.com/es/guia/exportar-data-stores-de-pipedream](https://migrateflows.com/es/guia/exportar-data-stores-de-pipedream/).

## Cómo se probó

- Agent Builder: 196 exports reales que la gente publicó en GitHub → 196 flujos (437 agentes). Todos pasan el validador oficial de flujos de n8n e importan.
- Flowise: los 51 templates del marketplace de Flowise → 55 flujos. Todos pasan el validador e importan; los patrones principales se corrieron en vivo en n8n.
- Pipedream: 75 flujos públicos de GitHub Sync importan sin errores; 437 de 438 pasos de código compilan (el que falta ya está roto en el original).

## Correrlo en tu computadora

Usá el sitio, o la línea de comandos (Node.js 18 o más nuevo):

```
cd src
npm install
node agentbuilder-cli.js <carpeta-o-archivo-del-export> <carpeta-de-salida> es
node flowise-cli.js <export.json|carpeta|zip> <carpeta-de-salida> es
node cli.js <carpeta|zip|json-del-export-de-pipedream> <carpeta-de-salida> es
```

Cada corrida escribe un archivo `.n8n.json` por flujo y un informe. Para servir el sitio vos mismo: `npx serve site`.

La carpeta [examples](examples) tiene entradas de ejemplo (escritas para este proyecto, no son datos de nadie) y los flujos de n8n que generan.

## Lo que todavía no convierte

- Agent Builder: las function tools salen como Code Tool para completar (el export no trae su código); los conectores de OpenAI (Gmail, Drive) hay que reemplazarlos por nodos de n8n; los guardrails de moderación y de alucinaciones no tienen equivalente en n8n.
- Flowise: agentes secuenciales (Agentflow v1) y algunas herramientas de integración.
- Pipedream: los pasos en Python están en beta; las acciones de apps menos comunes quedan como punto de la lista.

Si algo se rompe, abrí un issue con el export (sacale antes lo privado) o escribí a hello@migrateflows.com.

## Licencia

MIT. MigrateFlows es independiente y no está afiliado a OpenAI, FlowiseAI, Pipedream, Workday ni n8n.
