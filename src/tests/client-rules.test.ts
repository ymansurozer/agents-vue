/**
 * A rule the hook is held to that is an **absence**, and so cannot be exercised.
 *
 * A behavioural test says what the hook does; none of them would notice the old line coming back
 * beside it.
 */
import { describe, expect, it } from "vitest";

import hookSource from "../use-agent-chat.ts?raw";

describe("the connect handshake", () => {
  /**
   * `AgentClient` resolves its connect promise and sets its identified flag on the identity frame
   * and on nothing else, so an agent that does not send one settles neither. Awaiting either would
   * hang whatever awaited it — for good, and only once a tab had been open long enough to reach
   * that line. The React hook this was ported from does await it, which is what makes this worth
   * pinning: nothing here may wait on the handshake.
   */
  it("is never waited on", () => {
    // Word boundaries, so an `already` in a comment is not mistaken for one of these.
    expect(hookSource).not.toMatch(/\bready\b/u);
    expect(hookSource).not.toMatch(/\bidentified\b/u);
  });
});
