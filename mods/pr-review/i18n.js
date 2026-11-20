// The screen's words, in Japanese and English. One language for the whole mod: the one the person
// picked (kept by the main screen), else the Mac's first preferred language when it is Japanese,
// else English. `L("日本語", "English")` gives the word for the language now.

import { exec } from "herdr";

let lang = "en";

export const L = (ja, en) => (lang === "ja" ? ja : en);
export const currentLang = () => lang;
export const setLang = (to) => { lang = to === "ja" ? "ja" : "en"; };

/** The Mac's first preferred language, "ja" or "en" (`defaults read -g AppleLanguages`). */
export async function macLang() {
  const r = await exec("defaults", ["read", "-g", "AppleLanguages"]);
  if (r.code !== 0) return "en";
  const first = /"?([A-Za-z]+)/.exec(r.stdout.split("\n").find((line) => /[A-Za-z]/.test(line)) ?? "")?.[1] ?? "";
  return first.toLowerCase() === "ja" ? "ja" : "en";
}
