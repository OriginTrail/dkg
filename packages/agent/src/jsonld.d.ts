declare module 'jsonld' {
  const jsonld: {
    toRDF: (
      input: unknown,
      options?: { format?: string }
    ) => Promise<string | unknown[]>;
    expand: (input: unknown) => Promise<unknown[]>;
    compact: (input: unknown, context: unknown) => Promise<unknown>;
    flatten: (input: unknown) => Promise<unknown>;
  };
  export default jsonld;
}
