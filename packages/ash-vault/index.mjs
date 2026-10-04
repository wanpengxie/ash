// ash-vault: the DSH-world end of ash's secure vault.
//
// DSH resolves every secret it needs (a provider's API key, the balance check) through its own credential service,
// one reference at a time. ash keeps the values in the phone's vault, outside this process's files and environment.
// This plugin makes that vault the first place DSH looks, without touching DSH itself: for a reference the vault
// holds, resolve answers from the vault and describe says so; every other reference, and every record, keeps
// DSH's own behaviour. A vault-held reference cannot be written or removed from inside DSH.

export const name = "ash-vault";
export const inject = ["credentials"];

const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE = "ash-vault";

function createVault() {
  let lookup = null; // async (ref) => string | null, supplied by the ash host side

  /** The vault's value for a reference, or null. A vault that cannot answer is the same as one that holds nothing. */
  async function held(ref) {
    if (!lookup || typeof ref !== "string" || !REF.test(ref)) return null;
    try {
      const value = await lookup(ref);
      return typeof value === "string" && value ? value : null;
    } catch { return null; }
  }

  return {
    /** Called by ash once it can reach the vault. */
    attach(fn) { lookup = fn; },
    held,
  };
}

export const vault = createVault();

export function apply(ctx) {
  const credentials = ctx.get("credentials");
  if (!credentials || credentials[Symbol.for("ash-vault")]) return;
  const original = {
    resolve: credentials.resolve.bind(credentials),
    describe: credentials.describe.bind(credentials),
    set: credentials.set.bind(credentials),
    unset: credentials.unset.bind(credentials),
  };
  credentials.resolve = async (ref) => {
    const value = await vault.held(ref);
    return value ? { value, source: SOURCE } : original.resolve(ref);
  };
  credentials.describe = async (ref) => {
    if (await vault.held(ref)) return { configured: true, source: SOURCE, writable: false };
    return original.describe(ref);
  };
  credentials.set = async (ref, value) => {
    if (await vault.held(ref)) throw new Error(`${ref} is held by the ash vault; change it in ash's settings`);
    return original.set(ref, value);
  };
  credentials.unset = async (ref) => {
    if (await vault.held(ref)) throw new Error(`${ref} is held by the ash vault; change it in ash's settings`);
    return original.unset(ref);
  };
  credentials[Symbol.for("ash-vault")] = true;
}
