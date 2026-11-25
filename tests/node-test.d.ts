// テストを型チェックするための、node:test と node:assert/strict の最小限の型。
// テストで使うものだけを書いている（@types/node を入れずに済ませるため）。新しく使うものは足す

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    rejects(fn: Promise<unknown> | (() => Promise<unknown>), error?: unknown, message?: string): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
