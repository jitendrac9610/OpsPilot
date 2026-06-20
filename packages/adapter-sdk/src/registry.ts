import { OpsPilotAdapter } from "./types.js";

export class AdapterRegistry {
  private static adapters: OpsPilotAdapter[] = [];

  static register(adapter: OpsPilotAdapter) {
    this.adapters.push(adapter);
  }

  static getAdapters(): OpsPilotAdapter[] {
    return this.adapters;
  }
}
