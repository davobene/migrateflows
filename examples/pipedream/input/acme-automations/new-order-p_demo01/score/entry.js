export default defineComponent({
  props: { vipThreshold: { type: "integer", default: 500 } },
  async run({ steps, $ }) {
    const total = steps.normalize.$return_value.total;
    if (total < (this.vipThreshold || 500)) return $.flow.exit("Not a VIP order");
    return { vip: true, total };
  },
});
