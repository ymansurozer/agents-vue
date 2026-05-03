import { expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, h } from "vue";

test("vitest browser mode boots and Vue renders", async () => {
  const screen = render(
    defineComponent({
      setup() {
        return () => h("div", "agents-vue smoke");
      },
    }),
  );
  await expect.element(screen.getByText("agents-vue smoke")).toBeVisible();
});
