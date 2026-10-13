import { axios } from "@pipedream/platform";

export default defineComponent({
  async run({ steps, $ }) {
    const o = steps.trigger.event.body || {};
    const rate = await axios($, { url: "https://api.example.com/fx?to=USD" }).catch(() => ({ rate: 1 }));
    const total = Math.round((o.amount || 0) * (rate.rate || 1) * 100) / 100;
    $.export("$summary", `Normalized order ${o.id}`);
    return { name: o.name, email: o.email, total, row: [o.id, o.name, o.email, total] };
  },
});
