import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index"],
  declaration: true,
  rollup: {
    emitCJS: false,
  },
  externals: ["vue", "ai", "@ai-sdk/vue", "agents", "agents/client", "agents/chat"],
});
