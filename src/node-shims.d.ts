// Minimal node ambient declarations for the flow tests, which mount the
// real HTML shells from disk. Only what the tests use is declared.
declare module 'node:fs' {
  export const readFileSync: (path: string, encoding: string) => string;
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
  }
  export const readdirSync: (path: string, options: { withFileTypes: true }) => Dirent[];
}

declare module 'node:path' {
  export const dirname: (path: string) => string;
  export const join: (...parts: string[]) => string;
}

declare module 'node:url' {
  export const fileURLToPath: (url: string | URL) => string;
}
