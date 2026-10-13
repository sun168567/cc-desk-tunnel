// Vite hands a file imported with `?raw` over as its text.
declare module '*.md?raw' {
  const text: string;
  export default text;
}
