/**
 * Ready-made detectors for common sensitive data. They are suggestions:
 * every hit is shown to the user, who decides what is redacted.
 */
export interface Preset {
  id: string;
  label: string;
  pattern: string;
  /** Optional extra check on a regex match (e.g. checksum). */
  validate?: (match: string) => boolean;
}

function luhn(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(s: string): boolean {
  const iban = s.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of v) rem = (rem * 10 + +d) % 97;
  }
  return rem === 1;
}

export const PRESETS: Preset[] = [
  { id: "email", label: "E-mail addresses", pattern: String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}` },
  {
    id: "phone",
    label: "Phone numbers",
    pattern: String.raw`(?<![\p{N}])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){2,3}(?![\p{N}])`,
  },
  { id: "iban", label: "IBAN bank accounts", pattern: String.raw`\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b`, validate: ibanValid },
  { id: "card", label: "Payment card numbers", pattern: String.raw`(?<![\p{L}\p{N}][ -]?)(?:\d[ -]?){12,18}\d(?![ -]?[\p{L}\p{N}])`, validate: luhn },
  { id: "ipv4", label: "IP addresses", pattern: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b` },
  { id: "url", label: "Web links (URLs)", pattern: String.raw`\bhttps?://[^\s<>"']+` },
  { id: "date", label: "Dates", pattern: String.raw`\b(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})\b` },
];
