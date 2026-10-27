// Ambient types for raw file imports: component CSS consumed as
// constructable stylesheets, and HTML shells mounted by flow tests.
declare module '*?raw' {
  const text: string;
  export default text;
}
