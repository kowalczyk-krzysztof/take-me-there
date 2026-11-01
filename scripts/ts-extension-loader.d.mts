export declare const resolve: (
  specifier: string,
  context: { parentURL: string },
  next: (specifier: string, context: { parentURL: string }) => Promise<unknown>
) => Promise<{ url: string; shortCircuit: boolean }>;
