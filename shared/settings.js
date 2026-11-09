// Small settings store keyed by site host or file name. Uses the extension's storage when available,
// else localStorage. Classic script; defines globalThis.HandySettings.
globalThis.HandySettings = (() => {
  const ext = globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local;
  const name = key => 'handy-sync:' + key;
  // Filled in before anything is saved, so a fresh install connects with no typing. Saved values win.
  const DEFAULTS = {};
  return {
    async get(key) {
      let v;
      if (ext) v = (await ext.get(name(key)))[name(key)];
      else try { v = JSON.parse(localStorage.getItem(name(key))); } catch {}
      return v || DEFAULTS[key] || {};
    },
    async set(key, value) {
      if (ext) return ext.set({[name(key)]: value});
      localStorage.setItem(name(key), JSON.stringify(value));
    },
  };
})();
