/** Vite's `?raw` suffix, which the source-text pin in `client-rules.test.ts` reads the hook with. */
declare module "*?raw" {
  const content: string;
  export default content;
}
