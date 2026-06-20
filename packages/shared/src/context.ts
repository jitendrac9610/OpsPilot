import { AsyncLocalStorage } from "async_hooks";

export interface TenantContext {
  organizationId: string;
  projectId: string;
  userId?: string;
  correlationId?: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export class TenantContextHolder {
  static run<R>(context: TenantContext, fn: () => R): R {
    return tenantStorage.run(context, fn);
  }

  static getContext(): TenantContext | undefined {
    return tenantStorage.getStore();
  }

  static getRequiredContext(): TenantContext {
    const ctx = this.getContext();
    if (!ctx) {
      throw new Error("Missing active tenant context scope");
    }
    return ctx;
  }
}
