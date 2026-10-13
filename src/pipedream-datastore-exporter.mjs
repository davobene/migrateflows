// MigrateFlows data store exporter for Pipedream. Read-only: it never changes or deletes your records.
// 1. Create a workflow with an HTTP trigger and set its HTTP Response to "Return a custom response from your workflow".
// 2. Add a Node.js code step, paste this code, pick your data store, type its name and choose an access key.
// 3. Deploy, then open the trigger URL with ?key=YOUR_ACCESS_KEY in your browser: the file downloads.
// 4. Repeat for each data store (change the selection and the name), then delete the workflow.
export default defineComponent({
  props: {
    dataStore: { type: "data_store" },
    storeName: {
      type: "string",
      label: "Data store name",
      description: "Exactly as it appears in Pipedream → Data Stores",
    },
    accessKey: {
      type: "string",
      label: "Access key",
      description: "Any password you choose. Open the trigger URL with ?key=<this value>",
    },
  },
  async run({ steps, $ }) {
    const query = (steps.trigger && steps.trigger.event && steps.trigger.event.query) || {};
    if (query.key !== this.accessKey) {
      await $.respond({ status: 403, body: "Wrong or missing ?key=" });
      return $.flow.exit("wrong access key");
    }
    const records = {};
    let count = 0;
    for await (const [key, value] of this.dataStore) {
      records[key] = value;
      count++;
    }
    const file = {
      migrateflows: "pipedream-data-store",
      version: 1,
      name: this.storeName,
      exportedAt: new Date().toISOString(),
      count,
      records,
    };
    const filename = `${String(this.storeName).replace(/[^\w.-]+/g, "_")}.datastore.json`;
    await $.respond({
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: JSON.stringify(file, null, 2),
    });
    return { name: this.storeName, count };
  },
});
