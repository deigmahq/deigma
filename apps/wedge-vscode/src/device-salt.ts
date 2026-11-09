// The editor's own device salt (collector §2: "the salt stays on the device").
//
// Until 2026-10-09 the extension passed no salt and every draft was hashed with the literal
// "device-salt", the same on every machine. A short suggestion has few plausible spellings, so
// its `draft_hash` could be confirmed by anyone who hashed guesses with that constant: the hash
// was a fingerprint of the code, not a link only the device could make.
//
// Now: 32 random bytes, made the first time this editor collects (never before a sign-in — the
// rule that nothing is kept before one), stored in SecretStorage (the OS keychain behind the
// editor) and never sent. Signing out does NOT remove it, for the same reason the CLI keeps its
// device.json: a salt that changed with every sign-in would make the same draft hash differently
// before and after, and the link between a draft and its later correction would break for no
// reason the person could see.
import { MIN_DEVICE_SALT_LENGTH, newDeviceSalt, requireDeviceSalt } from "@mentat/wedge-core";

export const DEVICE_SALT_KEY = "deigma.deviceSalt";

export type SaltStore = {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
};

/** This editor's salt: the stored one, or a new one made and stored now. */
export async function deviceSalt(secrets: SaltStore, make: () => string = newDeviceSalt): Promise<string> {
  const stored = await secrets.get(DEVICE_SALT_KEY);
  // A stored value too short to be one of ours is replaced, not used: hashing with it would be
  // hashing with a guessable word.
  if (stored && stored.length >= MIN_DEVICE_SALT_LENGTH) return stored;
  const salt = requireDeviceSalt(make());
  await secrets.store(DEVICE_SALT_KEY, salt);
  return salt;
}
