/** Conservative exclusion patterns, not a guarantee that arbitrary prose contains no secrets. */
export const isSemanticDocumentTextSafe = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*\S+|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+@|\bBearer\s+\S+|\b(?:sk_live_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i.test(value);

/** Intent is untrusted free text; URLs and line breaks are withheld from model egress. */
export const isSemanticIntentQuerySafe = (value: unknown): value is string =>
  isSemanticDocumentTextSafe(value, 512) && !/[\r\n]|\b[A-Za-z][A-Za-z0-9+.-]*:\/\//i.test(value);
