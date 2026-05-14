export type Disposable = (() => void | Promise<void>) | { dispose: () => void | Promise<void> };

export interface Lifecycle {
  add(disposable: Disposable): Disposable;
  timeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  interval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  disposeAll(): Promise<void>;
  readonly disposed: boolean;
}

export function createLifecycle(): Lifecycle {
  const disposables: Disposable[] = [];
  let disposed = false;

  const add = (disposable: Disposable): Disposable => {
    if (disposed) throw new Error("Lifecycle is already disposed");
    disposables.push(disposable);
    return disposable;
  };

  return {
    add,
    timeout(callback, ms) {
      const timer = setTimeout(callback, ms);
      add(() => clearTimeout(timer));
      return timer;
    },
    interval(callback, ms) {
      const timer = setInterval(callback, ms);
      add(() => clearInterval(timer));
      return timer;
    },
    async disposeAll() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const disposable of disposables.splice(0).reverse()) {
        try {
          if (typeof disposable === "function") await disposable();
          else await disposable.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Multiple lifecycle disposables failed");
    },
    get disposed() {
      return disposed;
    },
  };
}
