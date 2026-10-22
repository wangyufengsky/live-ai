/** 精力：每天的 token 预算。用完了她就“累了”。 */

import { config } from "./config.js";
import type { Store } from "./store.js";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export class Energy {
  constructor(private store: Store) {
    if (store.get("energy_date") !== today()) this.reset();
  }

  reset() {
    this.store.put("energy_date", today());
    this.store.put("energy_used", 0);
  }

  get used(): number {
    return Number(this.store.get("energy_used", "0"));
  }

  /** 缓存读取很便宜，按十分之一算 */
  spend(input = 0, output = 0, cacheCreation = 0, cacheRead = 0) {
    this.store.put("energy_used", this.used + input + output + cacheCreation + Math.floor(cacheRead / 10));
  }

  get percent(): number {
    return Math.max(0, 100 - Math.floor((this.used * 100) / config.dailyEnergy));
  }
}

export { today };
